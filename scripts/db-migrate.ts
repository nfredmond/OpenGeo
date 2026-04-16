#!/usr/bin/env tsx
/**
 * Applies every .sql file in supabase/migrations/ in filename order.
 * Forward-only. Uses a _migrations table to track what has been applied.
 *
 * Usage:
 *   pnpm db:migrate:local   # against LOCAL_DB_URL (docker compose)
 *   pnpm db:migrate:remote  # against SUPABASE_DB_URL (live Supabase project)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

const mode = (process.argv[2] ?? "local").toLowerCase();
const url =
  mode === "remote" ? process.env.SUPABASE_DB_URL : process.env.LOCAL_DB_URL;

if (!url) {
  console.error(
    `Missing ${mode === "remote" ? "SUPABASE_DB_URL" : "LOCAL_DB_URL"} in environment.`,
  );
  process.exit(1);
}

const client = new Client({ connectionString: url });

async function main() {
  await client.connect();
  console.log(`Connected — mode=${mode}`);

  await client.query(`
    create table if not exists opengeo_migrations (
      name text primary key,
      applied_at timestamptz not null default now(),
      checksum text not null
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const applied = await client.query(
      "select checksum from opengeo_migrations where name = $1",
      [file],
    );
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const checksum = await hash(sql);

    if (applied.rows.length > 0) {
      if (applied.rows[0].checksum !== checksum) {
        console.error(
          `Migration ${file} already applied but checksum differs. Refusing. Create a new forward migration instead of editing this one.`,
        );
        process.exit(2);
      }
      console.log(`skip ${file}`);
      continue;
    }

    console.log(`apply ${file}`);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into opengeo_migrations (name, checksum) values ($1, $2)",
        [file, checksum],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      console.error(`FAIL ${file}:`, err);
      process.exit(3);
    }
  }

  console.log("Done.");
  await client.end();
}

async function hash(content: string) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content).digest("hex");
}

main().catch(async (err) => {
  console.error(err);
  try {
    await client.end();
  } catch {}
  process.exit(1);
});
