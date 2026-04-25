import { describe, expect, it } from "vitest";

const bridge = (await import("../../scripts/pmtiles-local-bridge.mjs")) as {
  parseBridgeArgs: (args: string[]) => {
    command: string;
    options: Set<string>;
  };
  parseBridgeWatchIntervalSeconds: (options: Set<string>) => number;
};

describe("pmtiles-local-bridge CLI helpers", () => {
  it("defaults to start", () => {
    const parsed = bridge.parseBridgeArgs([]);

    expect(parsed.command).toBe("start");
    expect(parsed.options.size).toBe(0);
  });

  it("parses repair options", () => {
    const parsed = bridge.parseBridgeArgs([
      "repair",
      "--update-vercel",
      "--force-recreate",
    ]);

    expect(parsed.command).toBe("repair");
    expect(parsed.options.has("--update-vercel")).toBe(true);
    expect(parsed.options.has("--force-recreate")).toBe(true);
  });

  it("parses watch interval options", () => {
    const parsed = bridge.parseBridgeArgs([
      "watch",
      "--update-vercel",
      "--interval=120",
      "--once",
    ]);

    expect(parsed.command).toBe("watch");
    expect(parsed.options.has("--update-vercel")).toBe(true);
    expect(parsed.options.has("--once")).toBe(true);
    expect(bridge.parseBridgeWatchIntervalSeconds(parsed.options)).toBe(120);
  });

  it("defaults the watch interval to five minutes", () => {
    expect(bridge.parseBridgeWatchIntervalSeconds(new Set())).toBe(300);
  });
});
