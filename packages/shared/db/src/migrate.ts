import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

async function run() {
  await pool.query(`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const { rowCount } = await pool.query("select 1 from _migrations where name = $1", [file]);
    if (rowCount && rowCount > 0) {
      console.log(`skip ${file}`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    console.log(`apply ${file}`);
    await pool.query("begin");
    try {
      await pool.query(sql);
      await pool.query("insert into _migrations (name) values ($1)", [file]);
      await pool.query("commit");
    } catch (err) {
      await pool.query("rollback");
      throw err;
    }
  }

  await pool.end();
  console.log("migrations done");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
