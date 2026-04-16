import { describe, expect, it } from "vitest";
import { odmStatusToOrtho, type OdmStatusCode } from "@/lib/odm/client";

describe("odmStatusToOrtho", () => {
  it("maps every NodeODM status code to an orthomosaic state", () => {
    const pairs: Array<[OdmStatusCode, "queued" | "processing" | "ready" | "failed"]> = [
      [10, "queued"],
      [20, "processing"],
      [30, "failed"],
      [40, "ready"],
      [50, "failed"],
    ];
    for (const [code, expected] of pairs) {
      expect(odmStatusToOrtho(code)).toBe(expected);
    }
  });
});
