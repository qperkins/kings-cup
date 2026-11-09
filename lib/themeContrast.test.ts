import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Reads the real stylesheet, so a palette tweak that breaks contrast fails here.
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

type RGB = [number, number, number];
function oklch(l: number, c: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h), b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((v) => Math.min(1, Math.max(0, v))) as RGB; // linear sRGB, clipped
}
const lum = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ratio = (x: RGB, y: RGB) => {
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
const parse = (s: string): RGB => {
  const m = s.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!m) throw new Error(`cannot parse ${s}`);
  return oklch(+m[1], +m[2], +m[3]);
};

const THEMES = ["ocean", "forest", "sunset", "grape", "red", "pink", "midnight"] as const;
const hueOf = (id: string) => {
  const m = css.match(new RegExp(`\\[data-bg="${id}"\\]\\s*\\{\\s*--cue-h:\\s*(\\d+)`));
  return m ? +m[1] : 85; // default theme
};
const pageOf = (id: string, dark: boolean): RGB[] => {
  const re = new RegExp(`${dark ? "\\.dark " : ""}\\[data-bg="${id}"\\]\\s*\\{\\s*--page-from:\\s*(oklch\\([^)]*\\));\\s*--page-via:\\s*(oklch\\([^)]*\\))`);
  const m = css.match(re);
  if (!m) throw new Error(`no ${dark ? "dark " : ""}page colors for ${id}`);
  return [parse(m[1]), parse(m[2])];
};
// First (light-mode) --cue-* declaration in the stylesheet; the dark overrides come later.
const num = (name: string) => {
  const m = css.match(new RegExp(`--${name}: oklch\\(([\\d.]+) ([\\d.]+) var\\(--cue-h\\)\\)`));
  if (!m) throw new Error(`--${name} not found`);
  return [+m[1], +m[2]] as const;
};
const cueLight = (h: number) => {
  const at = (name: string) => { const [l, c] = num(name); return oklch(l, c, h); };
  return { fill: at("cue"), fg: at("cue-fg"), edge: at("cue-edge"), text: at("cue-text") };
};

describe("theme accent contrast (from globals.css)", () => {
  it("light-mode cue-text keeps >= 4.5:1 on every tinted page (was 4.16 on Red at L=0.40)", () => {
    for (const id of THEMES.filter((t) => t !== "midnight")) {
      const cue = cueLight(hueOf(id));
      for (const page of pageOf(id, false)) expect(ratio(cue.text, page), id).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("light-mode button text on the fill is AA and its edge is >= 3:1 against the page", () => {
    for (const id of THEMES.filter((t) => t !== "midnight")) {
      const cue = cueLight(hueOf(id));
      expect(ratio(cue.fg, cue.fill), `${id} text`).toBeGreaterThanOrEqual(4.5);
      for (const page of pageOf(id, false)) expect(ratio(cue.edge, page), `${id} edge`).toBeGreaterThanOrEqual(3);
    }
  });
  it("each theme has its own accent hue, and Navy is dark blue (hue ~250, not purple)", () => {
    const hues = ["default", ...THEMES].map(hueOf);
    expect(new Set(hues.filter((_, i) => i !== 7)).size).toBe(7); // navy intentionally reuses default's gold
    expect(css).toMatch(/\[data-bg="midnight"\] \{ --page-from: oklch\(0\.25 0\.07 250\)/);
  });
  it("accent buttons get a visible keyboard focus outline in the theme's edge color", () => {
    // The default ring (ring-ring/50) measured ~1.2-1.8:1 against these pages.
    expect(css).toMatch(/\.cue-bg:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--cue-edge/);
    // ...and that edge color is itself >= 3:1 against each light page (covered above) so the outline is visible.
  });
});
