import { DurableObject } from "cloudflare:workers";

export type Computer = {
  id: number;
  name: string;
  created_at: number;
};

export class Computers extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.initSchema();
  }

  initSchema() {
    // Create computers table with name as unique indexed column
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS computers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )
    `);

    // Create index on name for fast lookups
    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_computers_name ON computers(name)
    `);
  }

  async createComputer(): Promise<{
    success: boolean;
    computer?: Computer;
    error?: string;
  }> {
    // Import unique-names-generator dynamically
    const { uniqueNamesGenerator, adjectives, colors, animals } =
      await import("unique-names-generator");

    // Generate a random name, retry up to 10 times if collision
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const name = uniqueNamesGenerator({
        dictionaries: [colors, animals],
        separator: "-",
        length: 2,
        style: "lowerCase",
      });

      try {
        const created_at = Date.now();

        // Insert the computer
        this.sql.exec(
          `INSERT INTO computers (name, created_at) VALUES (?, ?)`,
          name,
          created_at
        );

        // Get the inserted computer
        const computer = this.sql
          .exec(
            `SELECT id, name, created_at FROM computers WHERE name = ?`,
            name
          )
          .one() as Computer;

        return {
          success: true,
          computer,
        };
      } catch (error: any) {
        // Check if it's a unique constraint violation
        if (error.message?.includes("UNIQUE constraint failed")) {
          attempts++;
          continue; // Try again with a new name
        }
        return {
          success: false,
          error: error.message || "Failed to create computer",
        };
      }
    }

    return {
      success: false,
      error: "Could not generate unique computer name after multiple attempts",
    };
  }

  async getComputer(name: string): Promise<Computer | null> {
    const computer = this.sql
      .exec(`SELECT id, name, created_at FROM computers WHERE name = ?`, name)
      .one() as Computer | null;

    return computer;
  }

  async listComputers(): Promise<
    { id: number; name: string; created_at: number }[]
  > {
    const computers = this.sql
      .exec(
        `SELECT id, name, created_at FROM computers ORDER BY created_at DESC`
      )
      .toArray() as { id: number; name: string; created_at: number }[];

    return computers;
  }

  async fetch(request: Request): Promise<Response> {
    return new Response("Use RPC methods instead", { status: 200 });
  }
}
