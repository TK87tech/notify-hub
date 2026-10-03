/**
 * WCAG contrast maths over the theme tokens. Issue #31.
 *
 * The tokens are authored in `oklch`, which exists so a hue can be nudged without
 * re-deriving a hex value by hand - and which has the side effect that nobody can
 * eyeball whether a pair is readable. "Dark mode correct on every screen" and
 * "contrast meets WCAG AA" are not checkable by reading the CSS, so they get
 * computed instead.
 *
 * Luminance is taken from linear-light sRGB, which is what WCAG specifies. No
 * gamma encoding happens anywhere here: the values coming out of the OKLab
 * conversion are already linear, and encoding them only to decode them again
 * would be a place to lose precision.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses `oklch(L C H)`, `oklch(L C H / A)` and the `#rgb`/`#rrggbb` forms. */
export function parseColor(value: string): Rgb | undefined {
  const input = value.trim();

  const hex = input.match(/^#([0-9a-f]{3,8})$/i);

  if (hex) {
    return parseHex(hex[1]);
  }

  const oklch = input.match(
    /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*[\d.]+%?)?\s*\)$/i,
  );

  if (oklch) {
    const lightness = oklch[1].endsWith("%")
      ? Number.parseFloat(oklch[1]) / 100
      : Number.parseFloat(oklch[1]);

    return oklchToLinearRgb(lightness, Number.parseFloat(oklch[2]), Number.parseFloat(oklch[3]));
  }

  return undefined;
}

function parseHex(digits: string): Rgb | undefined {
  const expanded =
    digits.length === 3 || digits.length === 4
      ? digits
          .slice(0, 3)
          .split("")
          .map((d) => d + d)
          .join("")
      : digits.slice(0, 6);

  if (expanded.length !== 6) return undefined;

  return {
    // Hex is gamma-encoded sRGB, so it has to come back to linear before it is
    // used for luminance. Comparing a hex value against a linear one would report
    // contrast as far higher than it is.
    r: srgbToLinear(Number.parseInt(expanded.slice(0, 2), 16) / 255),
    g: srgbToLinear(Number.parseInt(expanded.slice(2, 4), 16) / 255),
    b: srgbToLinear(Number.parseInt(expanded.slice(4, 6), 16) / 255),
  };
}

/** OKLab to linear sRGB, via the LMS intermediary the specification defines. */
function oklchToLinearRgb(lightness: number, chroma: number, hueDegrees: number): Rgb {
  const hue = (hueDegrees * Math.PI) / 180;

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio, 1 to 21.
 *
 * The two luminances are sorted first so the ratio is never below 1, which would
 * otherwise show up as a negative number for a pair passed in the wrong order.
 */
export function contrastRatio(foreground: string, background: string): number | undefined {
  const fg = parseColor(foreground);
  const bg = parseColor(background);

  if (!fg || !bg) return undefined;

  const lighter = Math.max(luminance(fg), luminance(bg));
  const darker = Math.min(luminance(fg), luminance(bg));

  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for body text. Large text (18px+ or 14px+ bold) only needs 3:1. */
export const AA_TEXT = 4.5;

/** WCAG AA for non-text UI: icons, borders, focus rings. */
export const AA_NON_TEXT = 3;
