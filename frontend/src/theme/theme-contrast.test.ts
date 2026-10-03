/**
 * Reads the real `index.css` and checks the token pairs the app actually renders.
 *
 * Issue #31 asks for WCAG AA contrast. A pair can only be judged once it is
 * resolved to colours, and the only place those colours live is the stylesheet -
 * so this reads the stylesheet rather than a copy of the values, which would
 * happily keep passing after someone edits the tokens.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { AA_NON_TEXT, AA_TEXT, contrastRatio } from "./contrast";

// Vite's CSS plugin hands back an empty string for `index.css?raw`, so the file is
// read from disk. Resolved against the Vite root rather than this module's URL,
// because jsdom rewrites `import.meta.url` to an http URL and `new URL` then
// rejects it as a non-file scheme.
const stylesheet = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

type Theme = Record<string, string>;

/**
 * Extracts custom properties from the block opened by `selector`.
 *
 * Brace counting rather than a regex, because `:root` appears twice in this file
 * - once for the light theme and once nested inside the `prefers-color-scheme`
 * query - and a regex cannot tell which one it matched.
 */
function readBlock(selector: string): Theme {
  const start = stylesheet.indexOf(`${selector} {`);

  if (start === -1) throw new Error(`${selector} block not found in index.css`);

  const open = stylesheet.indexOf("{", start);
  let depth = 0;

  for (let i = open; i < stylesheet.length; i += 1) {
    if (stylesheet[i] === "{") depth += 1;

    if (stylesheet[i] === "}") {
      depth -= 1;

      if (depth === 0) return parseDeclarations(stylesheet.slice(open + 1, i));
    }
  }

  throw new Error(`unterminated ${selector} block in index.css`);
}

function parseDeclarations(block: string): Theme {
  const theme: Theme = {};

  // `color-scheme: light dark;` and the `@media` nested inside `:root` are not
  // custom properties, so anything that is not `--name: value` is skipped.
  for (const line of block.split(";")) {
    const declaration = line.match(/--([\w-]+)\s*:\s*(.+?)\s*$/s);

    if (declaration) theme[declaration[1]] = declaration[2].trim();
  }

  return theme;
}

const light = readBlock(":root");
const dark = readBlock(".dark");

/** Pairs whose foreground is rendered as body text. */
const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["foreground", "background"],
  ["muted-foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-accent-foreground", "sidebar-accent"],
  ["destructive", "background"],
];

/**
 * Pairs that are meaningful non-text UI, so AA asks for 3:1.
 *
 * `--ring` is checked un-composited on purpose. Components pair a solid
 * `focus-visible:border-ring` with a softer `ring-ring/50` halo, and the solid
 * border is what carries the indicator - so that is the pair that has to clear
 * 3:1. `--sidebar-ring` matters separately because the sidebar draws a solid
 * `ring-sidebar-ring` against `--sidebar`, not against the page background.
 */
const NON_TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["ring", "background"],
  ["sidebar-ring", "sidebar"],
  ["status-info", "background"],
  ["status-success", "background"],
  ["status-warning", "background"],
];

const THEMES: ReadonlyArray<readonly [string, Theme]> = [
  ["light", light],
  ["dark", dark],
];

describe.each(THEMES)("%s theme token contrast", (_name, theme) => {
  it.each(TEXT_PAIRS)("%s on %s meets WCAG AA for text", (foreground, background) => {
    const ratio = contrastRatio(theme[foreground], theme[background]);

    expect(
      ratio,
      `--${foreground} (${theme[foreground]}) on --${background} (${theme[background]})`,
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(NON_TEXT_PAIRS)("%s on %s meets WCAG AA for non-text UI", (foreground, background) => {
    const ratio = contrastRatio(theme[foreground], theme[background]);

    expect(
      ratio,
      `--${foreground} (${theme[foreground]}) on --${background} (${theme[background]})`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe("contrast maths", () => {
  it("returns 21 for black on white", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
  });

  it("returns 1 for a colour against itself", () => {
    expect(contrastRatio("oklch(0.5 0 0)", "oklch(0.5 0 0)")).toBeCloseTo(1, 5);
  });

  it("does not depend on the order the pair is given in", () => {
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(contrastRatio("#000", "#fff")!, 10);
  });

  it("reads hex as gamma-encoded sRGB rather than linear", () => {
    // Treating 0x80 as linear would inflate the ratio; this pins the conversion.
    expect(contrastRatio("#767676", "#fff")).toBeCloseTo(4.54, 1);
  });

  it("handles an oklch alpha suffix", () => {
    expect(contrastRatio("oklch(0.145 0 0)", "oklch(1 0 0 / 10%)")).toBeGreaterThan(1);
  });

  it("returns undefined for a colour it cannot read", () => {
    expect(contrastRatio("rebeccapurple", "#fff")).toBeUndefined();
  });
});
