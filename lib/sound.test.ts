import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyTurnExternally } from "./sound";

function fakeDocument(hidden: boolean) {
  const listeners = new Set<() => void>();
  const doc = {
    hidden,
    title: "King's Cup",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    show() {
      doc.hidden = false;
      [...listeners].forEach((fn) => fn());
    },
  };
  return doc;
}

afterEach(() => vi.unstubAllGlobals());

describe("notifyTurnExternally", () => {
  it("vibrates, and leaves the title alone while the tab is visible", () => {
    const doc = fakeDocument(false);
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate });
    vi.stubGlobal("document", doc);
    notifyTurnExternally("Ann");
    expect(vibrate).toHaveBeenCalledWith(200);
    expect(doc.title).toBe("King's Cup");
  });

  it("flashes the title while hidden and restores it when shown", () => {
    const doc = fakeDocument(true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", doc);
    notifyTurnExternally("Ann");
    expect(doc.title).toContain("Your turn, Ann");
    doc.show();
    expect(doc.title).toBe("King's Cup");
  });

  it("regression: two notifications while hidden still restore the ORIGINAL title", () => {
    const doc = fakeDocument(true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", doc);
    notifyTurnExternally("Ann");
    notifyTurnExternally("Ann");
    doc.show();
    expect(doc.title).toBe("King's Cup");
  });
});
