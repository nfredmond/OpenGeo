import { describe, expect, it, vi } from "vitest";

// Regression guard: `logAiEvent` must target the `opengeo` schema. PostgREST
// defaults to `public` when no schema is selected, which silently 404s the
// insert — every AI decision would vanish from the /review audit log.

vi.mock("@/lib/env", () => ({
  env: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "service-stub",
  }),
  flag: {},
}));

type InsertPayload = Record<string, unknown>;

const schemaCalls: string[] = [];
const inserts: Array<{ schema: string; table: string; payload: InsertPayload }> = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    schema: (schemaName: string) => {
      schemaCalls.push(schemaName);
      return {
        from: (table: string) => ({
          insert: async (payload: InsertPayload) => {
            inserts.push({ schema: schemaName, table, payload });
            return { error: null };
          },
        }),
      };
    },
    from: () => {
      throw new Error("schema-less .from() is a regression");
    },
  }),
}));

const { logAiEvent } = await import("@/lib/ai/logger");

describe("logAiEvent", () => {
  it("writes to opengeo.ai_events, not public.ai_events", async () => {
    schemaCalls.length = 0;
    inserts.length = 0;

    await logAiEvent({
      orgId: null,
      actorId: "user-1",
      kind: "nl_sql",
      model: "claude-opus-4-7",
      prompt: "example",
      responseSummary: "ok",
    });

    expect(schemaCalls).toEqual(["opengeo"]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      schema: "opengeo",
      table: "ai_events",
      payload: { kind: "nl_sql", model: "claude-opus-4-7", actor: "user-1" },
    });
  });
});
