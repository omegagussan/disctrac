/**
 * Colour maths in OKLab.
 *
 * Flood fill and clustering both need "are these two colours close?", and plain
 * RGB distance answers that badly — it rates dark navy and black as far apart
 * while calling two obviously different greens neighbours. OKLab is roughly
 * perceptually uniform, so one tolerance value behaves consistently across the
 * bright grass and deep shade the fixtures contain.
 *
 * Transform constants are Björn Ottosson's published OKLab definition.
 */

export interface Lab {
  L: number
  a: number
  b: number
}

export interface Rgb {
  r: number
  g: number
  b: number
}

/** sRGB channel (0..1, gamma-encoded) to linear light. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** Linear light back to a gamma-encoded sRGB channel (0..1). */
function toGamma(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

/** Channels are 0..255. */
export function srgbToOklab(r: number, g: number, b: number): Lab {
  const lr = toLinear(r / 255)
  const lg = toLinear(g / 255)
  const lb = toLinear(b / 255)

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

/** Inverse of {@link srgbToOklab}. Out-of-gamut results are clamped to 0..255. */
export function oklabToSrgb(lab: Lab): Rgb {
  const l = (lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3
  const m = (lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3
  const s = (lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3

  const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(toGamma(value) * 255)))

  return {
    r: clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

/** Euclidean distance in OKLab. Roughly 0..1 for colours a human would call distinct. */
export function labDistance(first: Lab, second: Lab): number {
  const dL = first.L - second.L
  const da = first.a - second.a
  const db = first.b - second.b
  return Math.sqrt(dL * dL + da * da + db * db)
}

/** `#rrggbb`, for CSS swatches. */
export function labToHex(lab: Lab): string {
  const { r, g, b } = oklabToSrgb(lab)
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}
