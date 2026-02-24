import pg from "pg";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function loadDbConfig(): DbConfig {
  return {
    host: process.env["DEVPORT_DB_HOST"] ?? "localhost",
    port: parseInt(process.env["DEVPORT_DB_PORT"] ?? "5432", 10),
    database: process.env["DEVPORT_DB_NAME"] ?? "devportdb",
    user: process.env["DEVPORT_DB_USER"] ?? "devport_user",
    password: process.env["DEVPORT_DB_PASSWORD"] ?? "devport_password",
  };
}

export function createPool(config: DbConfig): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

export async function ensurePgVector(pool: pg.Pool): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
}

export async function ensureHnswIndex(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_wiki_section_chunks_embedding
      ON wiki_section_chunks USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
}
