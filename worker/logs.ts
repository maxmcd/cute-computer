import { DurableObject } from "cloudflare:workers";
import { verifyToken } from "./lib/jwt";

export type Log = {
  log: string;
  ts: string;
};

export class Logs extends DurableObject<Env> {
  sql: SqlStorage;
  secretsCache: Map<string, string[]> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;

    this.sql.exec(`
        CREATE TABLE IF NOT EXISTS logs (
            log TEXT NOT NULL,
            ts_sec INTEGER NOT NULL,
            ts_nsec INTEGER NOT NULL
        )`);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts_sec DESC, ts_nsec DESC)
    `);

    // FTS5 virtual table for full-text search with trigram tokenizer for substring matching
    this.sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(log, content='logs', content_rowid='rowid', tokenize='trigram')
    `);

    // Triggers to keep FTS index in sync
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
        INSERT INTO logs_fts(rowid, log) VALUES (new.rowid, new.log);
      END
    `);

    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
        DELETE FROM logs_fts WHERE rowid = old.rowid;
      END
    `);

    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS logs_au AFTER UPDATE ON logs BEGIN
        UPDATE logs_fts SET log = new.log WHERE rowid = old.rowid;
      END
    `);
  }

  async fetch(request: Request): Promise<Response> {
    // JWT Authentication - Bearer token only
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = authHeader.slice(7);
    
    // Decode JWT to get computer name
    const parts = token.split('.');
    if (parts.length !== 3) {
      return Response.json({ error: "Invalid token format" }, { status: 401 });
    }
    
    const payloadJson = JSON.parse(atob(parts[1]));
    const computerName = payloadJson.sub;
    
    if (!computerName) {
      return Response.json({ error: "Invalid token claims" }, { status: 401 });
    }
    
    // Get secrets (from cache or fetch)
    let secrets = this.secretsCache.get(computerName);
    let payload;
    let needsFetch = false;
    
    // Try verification with cached secrets
    if (secrets) {
      try {
        payload = await verifyToken(token, secrets);
      } catch (err) {
        needsFetch = true;
      }
    } else {
      needsFetch = true;
    }
    
    // Fetch secrets if not cached or verification failed
    if (needsFetch) {
      const computersStub = this.env.COMPUTERS.get(this.env.COMPUTERS.idFromName("global"));
      const computer = await computersStub.getComputer(computerName);
      
      if (!computer) {
        return Response.json({ error: "Computer not found" }, { status: 401 });
      }
      
      const fetchedSecrets: string[] = JSON.parse(computer.secrets);
      if (fetchedSecrets.length === 0) {
        return Response.json({ error: "No secrets configured" }, { status: 401 });
      }
      
      this.secretsCache.set(computerName, fetchedSecrets);
      
      try {
        payload = await verifyToken(token, fetchedSecrets);
      } catch (err) {
        return Response.json({ error: "Invalid token" }, { status: 401 });
      }
    }

    // Route based on URL path
    const url = new URL(request.url);
    
    if (url.pathname === "/write" && request.method === "POST") {
      const logs: Log[] = await request.json();
      this.writeLogs(logs);
      return Response.json({ success: true });
    } else if (url.pathname === "/list" && request.method === "GET") {
      const before = url.searchParams.get("before") || undefined;
      const search = url.searchParams.get("search") || undefined;
      const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : undefined;
      const logs = this.getLogs({ before, search, limit });
      return Response.json(logs);
    } else {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
  }

  writeLogs(logs: Log[]) {
    for (const log of logs) {
      // Parse nanosecond timestamp string into seconds and nanoseconds
      const tsNanos = BigInt(log.ts);
      const tsSec = Number(tsNanos / 1_000_000_000n); // Convert to seconds
      const tsNsec = Number(tsNanos % 1_000_000_000n); // Remainder nanoseconds
      
      this.sql.exec(
        `INSERT INTO logs (log, ts_sec, ts_nsec) VALUES (?, ?, ?)`,
        log.log,
        tsSec,
        tsNsec
      );
    }
  }

  getLogs(ops: { before?: string; search?: string; limit?: number }) {
    if (!ops.limit) {
      ops.limit = 100;
    }
    
    // Parse "before" timestamp into seconds and nanoseconds
    let beforeSec: number;
    let beforeNsec: number;
    if (ops.before !== undefined) {
      const beforeTs = BigInt(ops.before);
      beforeSec = Number(beforeTs / 1_000_000_000n);
      beforeNsec = Number(beforeTs % 1_000_000_000n);
    } else {
      const nowNanos = BigInt(Date.now()) * 1_000_000n;
      beforeSec = Number(nowNanos / 1_000_000_000n);
      beforeNsec = Number(nowNanos % 1_000_000_000n);
    }
    
    // 7-day lookback window (7 * 24 * 60 * 60 = 604800 seconds)
    const minTsSec = beforeSec - 604800;
    
    let result;
    if (ops.search) {
      // Use FTS5 search with highlighting
      result = this.sql.exec(
        `SELECT logs.rowid, logs.log, logs.ts_sec, logs.ts_nsec,
                highlight(logs_fts, 0, '<mark>', '</mark>') as highlighted_log
         FROM logs_fts
         JOIN logs ON logs.rowid = logs_fts.rowid
         WHERE logs_fts MATCH ?
           AND logs.ts_sec >= ?
           AND (logs.ts_sec < ? OR (logs.ts_sec = ? AND logs.ts_nsec < ?))
         ORDER BY logs.ts_sec DESC, logs.ts_nsec DESC
         LIMIT ?`,
        ops.search,
        minTsSec,
        beforeSec,
        beforeSec,
        beforeNsec,
        ops.limit
      );
    } else {
      // No search - return all logs within time window
      result = this.sql.exec(
        `SELECT rowid, log, ts_sec, ts_nsec, log as highlighted_log
         FROM logs 
         WHERE ts_sec >= ?
           AND (ts_sec < ? OR (ts_sec = ? AND ts_nsec < ?))
         ORDER BY ts_sec DESC, ts_nsec DESC 
         LIMIT ?`,
        minTsSec,
        beforeSec,
        beforeSec,
        beforeNsec,
        ops.limit
      );
    }
    
    // Convert to array for proper serialization over RPC
    return result.toArray();
  }
}
