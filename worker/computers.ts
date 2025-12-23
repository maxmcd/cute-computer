import { DurableObject } from "cloudflare:workers";

export type Computer = {
  id: number;
  name: string; // Display name (can be duplicated, e.g., "My Computer")
  slug: string; // Unique subdomain identifier (e.g., "my-computer")
  created_at: number;
  secrets: string; // JSON array of secret strings
};

// Helper function to generate slug from name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove special characters
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Replace multiple hyphens with single hyphen
    .replace(/^-+|-+$/g, ""); // Remove leading/trailing hyphens
}

export class Computers extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.initSchema();
  }

  initSchema() {
    // Create computers table with both name and slug
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS computers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        secrets TEXT NOT NULL DEFAULT '[]'
      )
    `);

    // Create index on slug for fast lookups
    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_computers_slug ON computers(slug)
    `);
  }

  async createComputer(displayName: string): Promise<{
    success: boolean;
    computer?: Computer;
    error?: string;
  }> {
    // Validate name is provided
    if (!displayName || !displayName.trim()) {
      return {
        success: false,
        error: "Computer name is required",
      };
    }

    const name = displayName.trim();
    const baseSlug = generateSlug(name);

    // If slug is empty after sanitization, return error
    if (!baseSlug) {
      return {
        success: false,
        error: "Computer name must contain at least one alphanumeric character",
      };
    }

    // Try to insert with unique slug, add number suffix if needed
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      const slug = attempts === 0 ? baseSlug : `${baseSlug}-${attempts}`;

      try {
        const created_at = Date.now();

        // Generate initial secret (256-bit random string)
        const secret = crypto.randomUUID();
        const secrets = JSON.stringify([secret]);

        // Insert the computer
        this.sql.exec(
          `INSERT INTO computers (name, slug, created_at, secrets) VALUES (?, ?, ?, ?)`,
          name,
          slug,
          created_at,
          secrets
        );

        // Get the inserted computer
        const computer = this.sql
          .exec(
            `SELECT id, name, slug, created_at, secrets FROM computers WHERE slug = ?`,
            slug
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
          continue; // Try again with incremented slug
        }
        return {
          success: false,
          error: error.message || "Failed to create computer",
        };
      }
    }

    return {
      success: false,
      error: "Could not generate unique slug after multiple attempts",
    };
  }

  async getComputer(slug: string): Promise<Computer | null> {
    const result = this.sql.exec(
      `SELECT id, name, slug, created_at, secrets FROM computers WHERE slug = ?`,
      slug
    );

    const rows = [...result];
    if (rows.length === 0) {
      return null;
    }

    const computer = rows[0] as Computer;

    if (computer && (!computer.secrets || computer.secrets === "[]")) {
      this.sql.exec(
        `UPDATE computers SET secrets = ? WHERE slug = ?`,
        JSON.stringify([crypto.randomUUID()]),
        slug
      );
      const updatedResult = this.sql.exec(
        `SELECT id, name, slug, created_at, secrets FROM computers WHERE slug = ?`,
        slug
      );
      const updatedRows = [...updatedResult];
      return updatedRows.length > 0 ? (updatedRows[0] as Computer) : null;
    }
    return computer;
  }

  async listComputers(): Promise<
    { id: number; name: string; slug: string; created_at: number }[]
  > {
    const computers = this.sql
      .exec(
        `SELECT id, name, slug, created_at FROM computers ORDER BY created_at DESC`
      )
      .toArray() as {
      id: number;
      name: string;
      slug: string;
      created_at: number;
    }[];

    return computers;
  }

  async fetch(request: Request): Promise<Response> {
    return new Response("Use RPC methods instead", { status: 401 });
  }
}
