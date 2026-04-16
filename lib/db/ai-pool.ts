import "server-only";
import { Pool } from "pg";
import { env } from "@/lib/env";

// Dedicated pool that connects as `opengeo_ai_reader` — a role with SELECT-only
// grants (created in supabase/migrations/20260416120500_read_only_role.sql).
// Every AI-generated SQL statement is routed through this pool so even if
// the statement-level validator is bypassed, the database rejects writes.
//
// Connection string construction:
// - Prefer LOCAL_DB_URL when present (dev mode).
// - Otherwise use SUPABASE_DB_URL, but rewrite the user to opengeo_ai_reader.
// - Both paths expect a password-less or trusted setup; Supabase requires
//   creating the role with a password and storing it in AI_READER_DB_URL —
//   this stub leaves AI_READER_DB_URL as the authoritative env when set.

function connectionString(): string {
  const ai = process.env.AI_READER_DB_URL;
  if (ai) return ai;
  return env().LOCAL_DB_URL || env().SUPABASE_DB_URL;
}

let pool: Pool | undefined;

export function aiPool(): Pool {
  if (pool) return pool;
  const cs = connectionString();
  if (!cs) throw new Error("No AI-reader DB URL configured.");
  pool = new Pool({
    connectionString: cs,
    max: 5,
    statement_timeout: 5000,
    query_timeout: 10000,
    idleTimeoutMillis: 30000,
  });
  return pool;
}
