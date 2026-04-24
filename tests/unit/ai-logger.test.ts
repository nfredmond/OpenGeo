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
const rpcCalls: Array<{ schema: string; fn: string; args: Record<string, unknown> }> = [];
const selects: Array<{ schema: string; table: string; columns: string }> = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    schema: (schemaName: string) => {
      schemaCalls.push(schemaName);
      return {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ schema: schemaName, fn, args });
          return { data: "project-1", error: null };
        },
        from: (table: string) => ({
          select: (columns: string) => {
            selects.push({ schema: schemaName, table, columns });
            return {
              eq: () => ({
                maybeSingle: async () => ({ data: { org_id: "org-1" }, error: null }),
              }),
            };
          },
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
    rpcCalls.length = 0;
    selects.length = 0;

    await logAiEvent({
      orgId: "org-explicit",
      actorId: "user-1",
      kind: "nl_sql",
      model: "claude-opus-4-7",
      prompt: "example",
      responseSummary: "ok",
    });

    expect(schemaCalls).toEqual(["opengeo"]);
    expect(rpcCalls).toEqual([]);
    expect(selects).toEqual([]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      schema: "opengeo",
      table: "ai_events",
      payload: {
        org_id: "org-explicit",
        kind: "nl_sql",
        model: "claude-opus-4-7",
        actor: "user-1",
      },
    });
  });

  it("resolves the actor org when callers omit orgId", async () => {
    schemaCalls.length = 0;
    inserts.length = 0;
    rpcCalls.length = 0;
    selects.length = 0;

    await logAiEvent({
      orgId: null,
      actorId: "user-1",
      kind: "nl_sql",
      model: "claude-opus-4-7",
      prompt: "example",
      responseSummary: "ok",
    });

    expect(rpcCalls).toEqual([
      {
        schema: "opengeo",
        fn: "default_project_for",
        args: { p_user_id: "user-1" },
      },
    ]);
    expect(selects).toEqual([
      { schema: "opengeo", table: "projects", columns: "org_id" },
    ]);
    expect(inserts[0]).toMatchObject({
      schema: "opengeo",
      table: "ai_events",
      payload: { org_id: "org-1", actor: "user-1" },
    });
  });
});
