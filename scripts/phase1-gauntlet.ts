#!/usr/bin/env tsx
/**
 * Phase 1 exit gauntlet — walks the AI-native loop end-to-end against the
 * locally seeded database. Pure read + AI calls; no writes.
 *
 * Proves:
 *   1. Seed data is discoverable (Grass Valley demo project + building layer).
 *   2. NL→SQL generates a statement the guard accepts.
 *   3. That SQL actually returns feature rows when executed on the read-only
 *      AI pool against real seeded geometry.
 *   4. The guard rejects an INSERT if something tries to sneak one through.
 *   5. NL→style returns an allowed-key patch for a simple paint request.
 *   6. NL→style grounds data-driven expressions on a property key that
 *      actually exists on the layer (no fabrication).
 *
 * Requires (all from .env.local via dotenv-cli):
 *   LOCAL_DB_URL       Postgres connection string for the docker compose DB.
 *   ANTHROPIC_API_KEY  Real key — this hits Claude.
 *
 * Usage:
 *   pnpm db:migrate:local && pnpm db:seed:local   # once
 *   pnpm gauntlet
 *
 * Exits 0 iff every step passes. Exit code and stdout are stable enough to
 * wire into CI once we have a seeded Postgres in the CI runner.
 */
import { Client } from "pg";
import { nlToSql, validateSql } from "../lib/ai/nl-sql";
import { nlToStyle, type LayerContext } from "../lib/ai/nl-style";
import { aiPool } from "../lib/db/ai-pool";

type Result = {
  step: string;
  ok: boolean;
  note: string;
  ms: number;
};

const results: Result[] = [];

async function check(step: string, fn: () => Promise<string>) {
  const started = Date.now();
  try {
    const note = await fn();
    const ms = Date.now() - started;
    results.push({ step, ok: true, note, ms });
    console.log(`  ✓ ${step}${note ? ` — ${note}` : ""} (${ms}ms)`);
  } catch (e) {
    const ms = Date.now() - started;
    const msg = (e as Error).message;
    results.push({ step, ok: false, note: msg, ms });
    console.log(`  ✗ ${step} — ${msg} (${ms}ms)`);
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "× ANTHROPIC_API_KEY is not set. Add it to .env.local before running the gauntlet.",
    );
    process.exit(1);
  }
  if (!process.env.LOCAL_DB_URL) {
    console.error(
      "× LOCAL_DB_URL is not set. Run the seed first: pnpm db:migrate:local && pnpm db:seed:local.",
    );
    process.exit(1);
  }

  const host = process.env.LOCAL_DB_URL.split("@")[1]?.split("/")[0] ?? "local";
  console.log("OpenGeo Phase 1 exit gauntlet");
  console.log(`  db: ${host}`);
  console.log(`  model: ${process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7"}`);
  console.log();

  const db = new Client({ connectionString: process.env.LOCAL_DB_URL });
  await db.connect();

  try {
    await check("Seed data present", async () => {
      const { rows } = await db.query<{
        id: string;
        name: string;
        feature_count: number;
      }>(
        `select l.id, l.name, l.feature_count
           from opengeo.layers l
           join opengeo.datasets d on d.id = l.dataset_id
           join opengeo.projects p on p.id = d.project_id
          where p.slug = 'grass-valley-demo' and l.name = 'Downtown buildings'`,
      );
      if (!rows.length) {
        throw new Error(
          "Downtown buildings layer missing — run pnpm db:seed:local first",
        );
      }
      return `Downtown buildings (${rows[0].feature_count} features)`;
    });

    // NL→SQL half: generate, validate, execute.
    let generatedSql = "";
    await check("NL→SQL: guard accepts a grounded prompt", async () => {
      const gen = await nlToSql(
        "Return every feature whose properties->>'kind' equals 'building'. Limit 100.",
      );
      const gate = validateSql(gen.sql);
      if (!gate.ok) throw new Error(`guard rejected: ${gate.reason}`);
      generatedSql = gen.sql;
      const headline = gen.rationale.slice(0, 60).replace(/\s+/g, " ").trim();
      return `rationale: "${headline}${gen.rationale.length > 60 ? "…" : ""}"`;
    });

    await check("NL→SQL: query returns building rows", async () => {
      if (!generatedSql) throw new Error("no SQL from previous step");
      const wrapped = `with inner_q as (${generatedSql.trim().replace(/;+\s*$/, "")})
        select count(*)::int as n from inner_q where geom is not null`;
      const r = await aiPool().query<{ n: number }>(wrapped);
      const n = r.rows[0]?.n ?? 0;
      if (n === 0) throw new Error("zero rows returned against seeded geometry");
      return `${n} building feature(s)`;
    });

    await check("NL→SQL: guard rejects an INSERT", async () => {
      const fake = "insert into opengeo.features (geom) values ('POINT(0 0)')";
      const gate = validateSql(fake);
      if (gate.ok) throw new Error("guard let an INSERT through");
      return `rejected: "${gate.reason.slice(0, 50)}…"`;
    });

    // NL→style half: simple paint + data-driven grounding.
    const layerContext: LayerContext = {
      geometryKind: "polygon",
      sampleProperties: [
        { key: "kind", sampleValues: ["building"] },
        { key: "label", sampleValues: ["building #1", "building #2"] },
        { key: "index", sampleValues: ["0", "1", "2"] },
      ],
    };

    await check("NL→style: simple polygon paint patch", async () => {
      const r = await nlToStyle(
        layerContext,
        "dark red fill with thin white stroke at 40% opacity",
      );
      const fill = r.patch.paint?.["fill-color"];
      if (!fill) {
        throw new Error(
          `no fill-color in patch — rationale: "${r.rationale.slice(0, 80)}"`,
        );
      }
      return `fill-color=${JSON.stringify(fill)}`;
    });

    await check(
      "NL→style: data-driven expression grounds on real property key",
      async () => {
        const r = await nlToStyle(
          layerContext,
          "color features by their 'kind' property — distinct color per kind",
        );
        const paint = r.patch.paint ?? {};
        const serialized = JSON.stringify(paint);
        if (serialized === "{}") {
          throw new Error(
            `empty patch — rationale: "${r.rationale.slice(0, 80)}"`,
          );
        }
        if (!/\bkind\b/.test(serialized)) {
          throw new Error(
            `expression doesn't reference 'kind': ${serialized.slice(0, 120)}`,
          );
        }
        return `expression references 'kind'`;
      },
    );
  } finally {
    await db.end();
    try {
      await aiPool().end();
    } catch {
      // Pool may already be torn down if a step failed early.
    }
  }

  console.log();
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);
  const verdict = passed === total ? "PASS" : "FAIL";
  console.log(
    `Phase 1 gauntlet: ${verdict} (${passed}/${total} steps, ${totalMs}ms)`,
  );
  if (passed < total) process.exitCode = 1;
}

main().catch((err) => {
  console.error("gauntlet crashed:", err);
  process.exit(1);
});
