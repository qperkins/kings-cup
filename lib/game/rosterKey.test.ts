import { describe, expect, it } from "vitest";
import { rosterKey } from "./rosterKey";

describe("rosterKey", () => {
  it("is stable when only the order changes (so a reorder doesn't remount the list)", () => {
    expect(rosterKey(["a", "b", "c"])).toBe(rosterKey(["c", "a", "b"]));
  });
  it("changes when a player joins or leaves (remount ends an in-flight drag)", () => {
    expect(rosterKey(["a", "b", "c"])).not.toBe(rosterKey(["a", "b"]));
    expect(rosterKey(["a", "b"])).not.toBe(rosterKey(["a", "b", "d"]));
  });
  it("does not mutate its input", () => {
    const ids = ["b", "a"];
    rosterKey(ids);
    expect(ids).toEqual(["b", "a"]);
  });
});
