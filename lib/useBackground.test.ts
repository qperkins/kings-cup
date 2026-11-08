import { describe, expect, it } from "vitest";
import { BACKGROUNDS, pageClass } from "./useBackground";

describe("pageClass", () => {
  it("always includes the gradient class and extras", () => {
    expect(pageClass("default", "min-h-screen")).toBe("page-bg min-h-screen");
  });

  it("makes only Midnight a dark surface", () => {
    for (const b of BACKGROUNDS) {
      expect(pageClass(b.id).split(" ").includes("dark")).toBe(b.id === "midnight");
    }
  });
});
