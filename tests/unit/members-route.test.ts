import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Next.js server-only APIs that the route pulls through supabaseServer.
vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: () => {},
  }),
}));

// Stub the env module so supabaseService() doesn't need real creds.
vi.mock("@/lib/env", () => ({
  env: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-stub",
    SUPABASE_SERVICE_ROLE_KEY: "service-stub",
  }),
  flag: {},
}));

type User = { id: string; email: string };

type State = {
  currentUser: User | null;
  project: { id: string; slug: string; name: string; org_id: string } | null;
  projectAccess: Record<string, boolean>;
  existingAuthUser: User | null;
  projectMemberInserts: Array<Record<string, unknown>>;
  invitationInserts: Array<Record<string, unknown>>;
  adminInviteCalls: Array<{ email: string; redirectTo?: string }>;
  adminInviteError: string | null;
  invitationInsertError: { code: string; message: string } | null;
};

const state: State = {
  currentUser: null,
  project: null,
  projectAccess: {},
  existingAuthUser: null,
  projectMemberInserts: [],
  invitationInserts: [],
  adminInviteCalls: [],
  adminInviteError: null,
  invitationInsertError: null,
};

function resetState() {
  state.currentUser = null;
  state.project = null;
  state.projectAccess = {};
  state.existingAuthUser = null;
  state.projectMemberInserts.length = 0;
  state.invitationInserts.length = 0;
  state.adminInviteCalls.length = 0;
  state.adminInviteError = null;
  state.invitationInsertError = null;
}

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.currentUser } }),
    },
    schema: () => ({
      from: (table: string) => buildFromMock(table, false),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn !== "has_project_access") throw new Error(`unexpected rpc ${fn}`);
        const key = `${args.min_role}`;
        return { data: state.projectAccess[key] === true, error: null };
      },
    }),
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    schema: (schemaName: string) => ({
      from: (table: string) => buildFromMock(table, true, schemaName),
    }),
    auth: {
      admin: {
        inviteUserByEmail: async (email: string, opts?: { redirectTo?: string }) => {
          state.adminInviteCalls.push({ email, redirectTo: opts?.redirectTo });
          if (state.adminInviteError) {
            return { data: null, error: { message: state.adminInviteError } };
          }
          return { data: { user: null }, error: null };
        },
      },
    },
  }),
}));

// Minimal chainable builder that returns the result shape each route step needs.
function buildFromMock(table: string, isService: boolean, schemaName: string = "opengeo") {
  const chain = {
    _select: "",
    _filters: [] as Array<{ col: string; val: unknown }>,
    select(cols: string) {
      chain._select = cols;
      return chain;
    },
    eq(col: string, val: unknown) {
      chain._filters.push({ col, val });
      return chain;
    },
    in(_col: string, _vals: unknown[]) {
      return chain;
    },
    is(_col: string, _val: unknown) {
      return chain;
    },
    order(_col: string) {
      return chain;
    },
    limit(_n: number) {
      return chain;
    },
    async maybeSingle() {
      if (table === "projects") {
        const slugFilter = chain._filters.find((f) => f.col === "slug");
        if (!slugFilter || !state.project || slugFilter.val !== state.project.slug) {
          return { data: null, error: null };
        }
        return { data: state.project, error: null };
      }
      return { data: null, error: null };
    },
    async single() {
      if (table === "project_invitations" && isService) {
        if (state.invitationInsertError) {
          return { data: null, error: state.invitationInsertError };
        }
        return { data: { id: "inv-id-1" }, error: null };
      }
      return { data: null, error: null };
    },
    insert(row: Record<string, unknown>) {
      if (table === "project_invitations") state.invitationInserts.push(row);
      return chain;
    },
    upsert(row: Record<string, unknown>) {
      if (table === "project_members") state.projectMemberInserts.push(row);
      return Promise.resolve({ error: null });
    },
    delete() {
      return {
        eq: () => Promise.resolve({ error: null }),
      };
    },
    // Terminal resolver for list queries — the route awaits on the builder directly.
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      if (table === "users" && isService && schemaName === "auth") {
        resolve({ data: state.existingAuthUser ? [state.existingAuthUser] : [], error: null });
        return;
      }
      if (table === "project_members") {
        resolve({ data: [], error: null });
        return;
      }
      if (table === "members") {
        resolve({ data: [], error: null });
        return;
      }
      if (table === "project_invitations") {
        resolve({ data: [], error: null });
        return;
      }
      resolve({ data: [], error: null });
    },
  };
  return chain;
}

const { POST, GET } = await import(
  "@/app/api/projects/[slug]/members/route"
);

describe("POST /api/projects/[slug]/members", () => {
  beforeEach(resetState);
  afterEach(resetState);

  function makeReq(body: unknown) {
    return new Request("http://localhost/api/projects/alpha/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function ctx() {
    return { params: Promise.resolve({ slug: "alpha" }) };
  }

  it("returns 401 when the caller is not authenticated", async () => {
    const res = await POST(makeReq({ email: "x@y.com", role: "viewer" }), ctx());
    expect(res.status).toBe(401);
  });

  it("returns 400 on an invalid body", async () => {
    state.currentUser = { id: "u-admin", email: "admin@a.test" };
    const res = await POST(makeReq({ email: "not-an-email" }), ctx());
    expect(res.status).toBe(400);
  });

  it("returns 404 when the project slug does not resolve", async () => {
    state.currentUser = { id: "u-admin", email: "admin@a.test" };
    state.project = null;
    const res = await POST(makeReq({ email: "x@y.com", role: "viewer" }), ctx());
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is authenticated but not admin on the project", async () => {
    state.currentUser = { id: "u-viewer", email: "v@a.test" };
    state.project = { id: "p1", slug: "alpha", name: "Alpha", org_id: "o1" };
    state.projectAccess = { admin: false };
    const res = await POST(makeReq({ email: "x@y.com", role: "viewer" }), ctx());
    expect(res.status).toBe(403);
  });

  it("upserts project_members (no email) when the invitee already has an account", async () => {
    state.currentUser = { id: "u-admin", email: "admin@a.test" };
    state.project = { id: "p1", slug: "alpha", name: "Alpha", org_id: "o1" };
    state.projectAccess = { admin: true };
    state.existingAuthUser = { id: "u-existing", email: "existing@b.test" };

    const res = await POST(makeReq({ email: "existing@b.test", role: "editor" }), ctx());
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(res.status).toBe(200);
    expect(body.result).toBe("member_added");
    expect(state.projectMemberInserts).toHaveLength(1);
    expect(state.projectMemberInserts[0]).toMatchObject({
      project_id: "p1",
      user_id: "u-existing",
      role: "editor",
    });
    expect(state.adminInviteCalls).toHaveLength(0);
  });

  it("creates an invitation and fires inviteUserByEmail when the invitee is new", async () => {
    state.currentUser = { id: "u-admin", email: "admin@a.test" };
    state.project = { id: "p1", slug: "alpha", name: "Alpha", org_id: "o1" };
    state.projectAccess = { admin: true };
    state.existingAuthUser = null;

    const res = await POST(makeReq({ email: "new@c.test", role: "viewer" }), ctx());
    const body = (await res.json()) as { ok: boolean; result: string };
    expect(res.status).toBe(200);
    expect(body.result).toBe("invitation_sent");
    expect(state.invitationInserts).toHaveLength(1);
    expect(state.invitationInserts[0]).toMatchObject({
      project_id: "p1",
      email: "new@c.test",
      role: "viewer",
    });
    expect(state.adminInviteCalls).toHaveLength(1);
    expect(state.adminInviteCalls[0].email).toBe("new@c.test");
    expect(state.adminInviteCalls[0].redirectTo).toContain("/auth/callback");
    expect(state.adminInviteCalls[0].redirectTo).toContain("next=%2Fprojects%2Falpha");
    expect(state.projectMemberInserts).toHaveLength(0);
  });

  it("reports invitation_created_email_failed when the admin email call errors", async () => {
    state.currentUser = { id: "u-admin", email: "admin@a.test" };
    state.project = { id: "p1", slug: "alpha", name: "Alpha", org_id: "o1" };
    state.projectAccess = { admin: true };
    state.adminInviteError = "rate limited";

    const res = await POST(makeReq({ email: "fresh@d.test", role: "viewer" }), ctx());
    const body = (await res.json()) as { ok: boolean; result: string; warning?: string };
    expect(res.status).toBe(200);
    expect(body.result).toBe("invitation_created_email_failed");
    expect(body.warning).toContain("rate limited");
  });

  it("returns 409 when inserting a duplicate pending invitation", async () => {
    state.currentUser = { id: "u-admin", email: "admin@a.test" };
    state.project = { id: "p1", slug: "alpha", name: "Alpha", org_id: "o1" };
    state.projectAccess = { admin: true };
    state.invitationInsertError = { code: "23505", message: "duplicate" };

    const res = await POST(makeReq({ email: "dup@e.test", role: "viewer" }), ctx());
    expect(res.status).toBe(409);
  });
});

describe("GET /api/projects/[slug]/members", () => {
  beforeEach(resetState);
  afterEach(resetState);

  function ctx() {
    return { params: Promise.resolve({ slug: "alpha" }) };
  }

  it("returns 401 when unauthenticated", async () => {
    const res = await GET(
      new Request("http://localhost/api/projects/alpha/members"),
      ctx(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller lacks viewer access", async () => {
    state.currentUser = { id: "u", email: "u@a.test" };
    state.project = { id: "p1", slug: "alpha", name: "Alpha", org_id: "o1" };
    state.projectAccess = { viewer: false, admin: false };
    const res = await GET(
      new Request("http://localhost/api/projects/alpha/members"),
      ctx(),
    );
    expect(res.status).toBe(403);
  });

  it("returns members + project info for a viewer; hides invitations", async () => {
    state.currentUser = { id: "u", email: "u@a.test" };
    state.project = { id: "p1", slug: "alpha", name: "Alpha", org_id: "o1" };
    state.projectAccess = { viewer: true, admin: false };

    const res = await GET(
      new Request("http://localhost/api/projects/alpha/members"),
      ctx(),
    );
    const body = (await res.json()) as {
      ok: boolean;
      invitations: unknown[];
      viewerCanAdmin: boolean;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.invitations).toEqual([]);
    expect(body.viewerCanAdmin).toBe(false);
  });
});
