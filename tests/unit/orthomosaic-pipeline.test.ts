import { beforeEach, describe, expect, it, vi } from "vitest";

// Sleep is replaced with an instant resolve so the 120-poll loop fires in
// microseconds. FatalError/RetryableError stay as real throwable classes so
// instanceof checks in user code keep working.
vi.mock("workflow", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  FatalError: class FatalError extends Error {
    constructor(m: string) {
      super(m);
      this.name = "FatalError";
    }
  },
  RetryableError: class RetryableError extends Error {
    constructor(m: string) {
      super(m);
      this.name = "RetryableError";
    }
  },
}));

type OrthoFixture = {
  id: string;
  status: "queued" | "processing" | "ready" | "failed";
  odm_job_id: string | null;
};

const defaultOrtho: OrthoFixture = {
  id: "ortho-1",
  status: "queued",
  odm_job_id: "odm-1",
};

// Module-level state so mocks can see the fixtures the test body sets. Cleared
// in beforeEach.
let orthoFixture: OrthoFixture | null = defaultOrtho;
let selectError: { message: string } | null = null;
const updates: Array<{ patch: Record<string, unknown>; id: unknown }> = [];

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    schema: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: orthoFixture, error: selectError }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: unknown) => {
            updates.push({ patch, id });
            return { error: null };
          },
        }),
      }),
    }),
  }),
}));

const pollSequence: Array<{
  code: number;
  progress: number;
  errorMessage?: string;
}> = [];

vi.mock("@/lib/odm/client", () => ({
  odmGetTaskInfo: async () => {
    const next = pollSequence.shift();
    if (!next) throw new Error("pollSequence exhausted — test bug");
    return {
      status: { code: next.code, errorMessage: next.errorMessage },
      progress: next.progress,
    };
  },
  odmAssetUrl: (jobId: string, asset: string) =>
    `https://odm.example/task/${jobId}/${asset}`,
  odmStatusToOrtho: (code: number) => {
    if (code === 40) return "ready";
    if (code === 30) return "failed";
    if (code === 20) return "processing";
    return "queued";
  },
}));

// Must be imported after the mocks are registered so the workflow picks up
// our fakes instead of the real supabase + odm client.
const { orthomosaicPipelineWorkflow } = await import(
  "@/workflows/orthomosaic-pipeline"
);

describe("orthomosaicPipelineWorkflow", () => {
  beforeEach(() => {
    updates.length = 0;
    pollSequence.length = 0;
    orthoFixture = { ...defaultOrtho };
    selectError = null;
  });

  it("marks an ortho ready and writes all asset URLs when ODM completes", async () => {
    pollSequence.push({ code: 40, progress: 100 });

    const result = await orthomosaicPipelineWorkflow("ortho-1");

    expect(result).toEqual({
      orthomosaicId: "ortho-1",
      status: "ready",
      attempts: 1,
    });
    const ready = updates.find((u) => u.patch.status === "ready");
    expect(ready).toBeDefined();
    expect(ready!.patch).toMatchObject({
      status: "ready",
      cog_url: expect.stringContaining("orthophoto.tif"),
      dsm_url: expect.stringContaining("dsm.tif"),
      dtm_url: expect.stringContaining("dtm.tif"),
      pointcloud_url: expect.stringContaining(".laz"),
      error: null,
    });
  });

  it("marks an ortho failed and preserves the ODM error message", async () => {
    pollSequence.push({ code: 30, progress: 50, errorMessage: "GPS drift" });

    const result = await orthomosaicPipelineWorkflow("ortho-1");

    expect(result).toEqual({
      orthomosaicId: "ortho-1",
      status: "failed",
      attempts: 1,
    });
    const failed = updates.find((u) => u.patch.status === "failed");
    expect(failed!.patch.error).toBe("GPS drift");
  });

  it("writes a status transition once when queued → processing → ready", async () => {
    // First poll mirrors the fixture's "queued" state, so we expect no write.
    // Second poll flips to "processing" — one writeStatus. Third poll lands
    // "ready" — writeReady takes over.
    pollSequence.push({ code: 10, progress: 0 });
    pollSequence.push({ code: 20, progress: 30 });
    pollSequence.push({ code: 40, progress: 100 });

    await orthomosaicPipelineWorkflow("ortho-1");

    const transitions = updates.map((u) => u.patch.status);
    expect(transitions).toEqual(["processing", "ready"]);
  });

  it("substitutes a default message when NodeODM reports failed without detail", async () => {
    pollSequence.push({ code: 30, progress: 50 });

    await orthomosaicPipelineWorkflow("ortho-1");

    const failed = updates.find((u) => u.patch.status === "failed");
    expect(failed!.patch.error).toBe("NodeODM reported failure.");
  });

  it("times out after MAX_POLL_ATTEMPTS and throws FatalError", async () => {
    // 120 queued responses so the orchestrator exhausts its attempt budget
    // without ever hitting a terminal state. Push a couple extra to guard
    // against off-by-one regressions.
    for (let i = 0; i < 125; i++) {
      pollSequence.push({ code: 10, progress: 0 });
    }

    await expect(orthomosaicPipelineWorkflow("ortho-1")).rejects.toThrow(
      /did not reach a terminal state/,
    );
    const timeoutWrite = updates.find((u) => u.patch.status === "failed");
    expect(timeoutWrite!.patch.error).toMatch(/timed out/);
  });

  it("throws FatalError when the ortho row is missing", async () => {
    orthoFixture = null;

    await expect(
      orthomosaicPipelineWorkflow("missing-id"),
    ).rejects.toThrow(/not found/);
  });

  it("throws FatalError when the ortho row has no odm_job_id", async () => {
    orthoFixture = { ...defaultOrtho, odm_job_id: null };

    await expect(orthomosaicPipelineWorkflow("ortho-1")).rejects.toThrow(
      /no odm_job_id/,
    );
  });
});
