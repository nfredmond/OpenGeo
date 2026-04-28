import { describe, expect, it, vi } from "vitest";
import {
  cleanupTempSmoke,
  CookieJar,
  hostedSmokeExitCode,
  parseHostedSmokeArgs,
  pmtilesPublicFetchProof,
  redactSensitive,
  runHostedSmoke,
  splitSetCookieHeader,
  type SupabaseAdminLike,
} from "@/scripts/hosted-smoke";

describe("hosted-smoke helpers", () => {
  it("parses defaults and normalizes base URL", () => {
    expect(parseHostedSmokeArgs([])).toEqual({
      baseUrl: "https://opengeo.vercel.app",
      scope: "all",
      json: false,
    });

    expect(
      parseHostedSmokeArgs([
        "--",
        "--base-url",
        "https://example.com/",
        "--scope=all",
        "--json",
      ]),
    ).toEqual({
      baseUrl: "https://example.com",
      scope: "all",
      json: true,
    });
  });

  it("parses the public PMTiles scope", () => {
    expect(
      parseHostedSmokeArgs([
        "--scope=public-pmtiles",
        "--pmtiles-url",
        "https://assets.example.com/pmtiles/layer/smoke.pmtiles#ignored",
        "--json",
      ]),
    ).toEqual({
      baseUrl: "https://opengeo.vercel.app",
      scope: "public-pmtiles",
      json: true,
      pmtilesUrl: "https://assets.example.com/pmtiles/layer/smoke.pmtiles",
    });
  });

  it("rejects unsupported scopes", () => {
    expect(() => parseHostedSmokeArgs(["--scope=pmtiles"])).toThrow(/Unsupported/);
  });

  it("requires a public PMTiles URL only for the public PMTiles scope", () => {
    expect(() => parseHostedSmokeArgs(["--scope=public-pmtiles"])).toThrow(/--pmtiles-url/);
    expect(() =>
      parseHostedSmokeArgs([
        "--scope=public-pmtiles",
        "--pmtiles-url=ftp://assets.example.com/layer.pmtiles",
      ]),
    ).toThrow(/http or https/);
    expect(() =>
      parseHostedSmokeArgs(["--pmtiles-url=https://assets.example.com/layer.pmtiles"]),
    ).toThrow(/--scope=public-pmtiles/);
  });

  it("redacts configured secret values from output", () => {
    const text = "token=s3cr3t cookie=abc123 public=ok";
    const redacted = redactSensitive(text, ["s3cr3t", "abc123"]);

    expect(redacted).toBe("token=[redacted] cookie=[redacted] public=ok");
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).not.toContain("abc123");
  });

  it("splits combined Set-Cookie headers without splitting Expires dates", () => {
    const combined =
      "a=1; Path=/; HttpOnly, b=2; Expires=Fri, 24 Apr 2026 19:00:00 GMT; Path=/, c=3; Path=/";

    expect(splitSetCookieHeader(combined)).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Expires=Fri, 24 Apr 2026 19:00:00 GMT; Path=/",
      "c=3; Path=/",
    ]);
  });

  it("stores cookie jar values as a request Cookie header", () => {
    const jar = new CookieJar();

    jar.add([
      "sb-access-token=aaa; Path=/; HttpOnly",
      "sb-refresh-token=bbb; Path=/; HttpOnly",
    ]);

    expect(jar.size).toBe(2);
    expect(jar.header()).toBe("sb-access-token=aaa; sb-refresh-token=bbb");
  });

  it("reports a secret-safe public PMTiles range proof", () => {
    const header = new TextEncoder().encode("PMTiles fixture bytes");

    expect(
      pmtilesPublicFetchProof({
        url: "https://assets.example.com/pmtiles/layer/smoke.pmtiles?unused=1",
        status: 206,
        header,
      }),
    ).toBe("public=assets.example.com range=206 magic=PMTiles");
  });

  it("rejects public PMTiles responses that do not honor byte ranges", () => {
    const header = new TextEncoder().encode("PMTiles fixture bytes");

    expect(() =>
      pmtilesPublicFetchProof({
        url: "https://assets.example.com/pmtiles/layer/smoke.pmtiles",
        status: 200,
        header,
      }),
    ).toThrow(/expected HTTP 206/);
  });

  it("rejects public PMTiles responses without the PMTiles magic header", () => {
    const header = new TextEncoder().encode("not-pmtiles");

    expect(() =>
      pmtilesPublicFetchProof({
        url: "https://assets.example.com/pmtiles/layer/smoke.pmtiles",
        status: 206,
        header,
      }),
    ).toThrow(/unexpected magic header/);
  });

  it("runs the public PMTiles smoke without hosted credentials", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new TextEncoder().encode("PMTiles fixture bytes"), { status: 206 });
    }) as unknown as typeof fetch;

    const report = await runHostedSmoke(
      {
        baseUrl: "https://opengeo.vercel.app",
        scope: "public-pmtiles",
        json: true,
        pmtilesUrl: "https://assets.example.com/pmtiles/layer/smoke.pmtiles",
      },
      {
        fetch: fetchImpl,
        stdout: vi.fn(),
        stderr: vi.fn(),
        now: () => new Date("2026-04-25T00:00:00.000Z"),
        adminClient: {} as SupabaseAdminLike,
        env: { NODE_ENV: "test" },
      },
    );

    expect(report.ok).toBe(true);
    expect(report.cleanup).toEqual([]);
    expect(report.steps).toMatchObject([
      {
        step: "public-pmtiles",
        ok: true,
        note: "public=assets.example.com range=206 magic=PMTiles",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://assets.example.com/pmtiles/layer/smoke.pmtiles",
      { headers: { range: "bytes=0-15" } },
    );
  });

  it("cleans temporary resources in the expected order", async () => {
    const calls: string[] = [];
    const adminClient = fakeAdmin(calls);
    const fetchImpl = vi.fn(async () => {
      calls.push("r2");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const cleanup = await cleanupTempSmoke(
      {
        userId: "user-1",
        orgIds: new Set(["org-1"]),
        projectIds: new Set(["project-1"]),
        r2ObjectKeys: ["pmtiles/layer/smoke.pmtiles"],
      },
      {
        adminClient,
        fetch: fetchImpl,
        env: {
          NODE_ENV: "test",
          R2_ACCOUNT_ID: "account",
          R2_ACCESS_KEY_ID: "access",
          R2_SECRET_ACCESS_KEY: "secret",
          R2_BUCKET: "opengeo",
        },
      },
    );

    expect(cleanup.every((item) => item.ok)).toBe(true);
    expect(calls).toEqual(["r2", "delete:projects", "delete:orgs", "auth:user-1"]);
  });

  it("maps smoke reports to process exit codes", () => {
    expect(hostedSmokeExitCode({ ok: true })).toBe(0);
    expect(hostedSmokeExitCode({ ok: false })).toBe(1);
  });
});

function fakeAdmin(calls: string[]): SupabaseAdminLike {
  return {
    auth: {
      admin: {
        createUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
        generateLink: async () => ({ data: { properties: { hashed_token: "hash" } }, error: null }),
        deleteUser: async (userId: string) => {
          calls.push(`auth:${userId}`);
          return { error: null };
        },
      },
    },
    schema: () => ({
      from: (table: string) => fakeQuery(table, calls),
    }),
  };
}

function fakeQuery(table: string, calls: string[]) {
  const chain = {
    select() {
      return chain;
    },
    eq() {
      return chain;
    },
    in() {
      calls.push(`delete:${table}`);
      return chain;
    },
    delete() {
      return chain;
    },
    limit() {
      return chain;
    },
    async maybeSingle() {
      return { data: null, error: null };
    },
    then(resolve: (value: { data: unknown[]; error: null }) => void) {
      resolve({ data: [], error: null });
    },
  };
  return chain;
}
