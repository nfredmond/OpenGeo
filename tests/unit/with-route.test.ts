import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { log } = await import("@/lib/observability/logger");
const { withRoute } = await import("@/lib/observability/with-route");

describe("withRoute", () => {
  beforeEach(() => {
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.error).mockClear();
  });

  it("redacts share tokens from route logs", async () => {
    const handler = withRoute("share.layers", () => Response.json({ ok: true }));

    const res = await handler(
      new Request("http://localhost/api/share/secret-token.abcdef/layers"),
      { params: Promise.resolve({ token: "secret-token.abcdef" }) },
    );

    expect(res.status).toBe(200);
    expect(log.info).toHaveBeenCalledWith(
      "route.complete",
      expect.objectContaining({
        route: "share.layers",
        path: "/api/share/:token/layers",
      }),
    );
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(
      "secret-token.abcdef",
    );
  });
});
