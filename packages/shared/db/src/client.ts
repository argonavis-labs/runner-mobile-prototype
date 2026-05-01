import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

// Railway-managed Postgres requires SSL; local docker doesn't. Detect by host:
// internal Railway hosts are *.railway.internal, public ones go through proxy
// hosts that also need SSL. Local docker uses 127.0.0.1 / localhost.
const host = (() => {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return "";
  }
})();
const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";

export const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });

export type DB = typeof db;
