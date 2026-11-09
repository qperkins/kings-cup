import { describe, expect, it } from "vitest";
import { mateBadgeLabel } from "./mateBadge";

describe("mateBadgeLabel", () => {
  it("is empty without mates", () => expect(mateBadgeLabel([])).toBe(""));
  it("shows the initial for a single mate", () => expect(mateBadgeLabel(["cat"])).toBe("C"));
  it("shows a count for several mates (stays narrow next to the Host tag)", () => {
    expect(mateBadgeLabel(["Ben", "Cat"])).toBe("2");
    expect(mateBadgeLabel(["Ben", "Cat", "Dee"])).toBe("3");
  });
});
