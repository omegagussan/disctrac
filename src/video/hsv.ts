/**
 * HSV, for matching a disc across changing light.
 *
 * Under roughly multiplicative shading — the same disc in sun and in shade — hue
 * and saturation hold still while value collapses. Measured on fixture colours,
 * an orange disc at half brightness keeps h=27.00 and s=0.8696 exactly, and only
 * v moves (0.902 -> 0.451). Matching mainly on hue and saturation therefore
 * follows a disc through shade in a way OKLab distance, which counts that
 * lightness drop at full weight, does not.
 */

export interface Hsv {
  /** Degrees, 0..360. Meaningless when `s` is near 0. */
  h: number
  /** 0..1 */
  s: number
  /** 0..1 */
  v: number
}

/** Channels are 0..255. */
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const red = r / 255
  const green = g / 255
  const blue = b / 255

  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min

  let h = 0
  if (delta > 0) {
    if (max === red) h = 60 * (((green - blue) / delta + 6) % 6)
    else if (max === green) h = 60 * ((blue - red) / delta + 2)
    else h = 60 * ((red - green) / delta + 4)
  }

  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

/** Inverse of {@link rgbToHsv}, rounded to 0..255 channels. */
export function hsvToRgb(hsv: Hsv): { r: number; g: number; b: number } {
  const h = ((hsv.h % 360) + 360) % 360
  const c = hsv.v * hsv.s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = hsv.v - c

  const sextant = Math.floor(h / 60) % 6
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ]
  const [r, g, b] = table[sextant]
  const to255 = (value: number) => Math.round(Math.min(1, Math.max(0, value + m)) * 255)
  return { r: to255(r), g: to255(g), b: to255(b) }
}

/** Shortest angular distance in degrees, 0..180. Hue wraps, so 350 and 10 are 20 apart. */
export function hueDistance(first: number, second: number): number {
  const raw = Math.abs(((first % 360) + 360) % 360 - (((second % 360) + 360) % 360))
  return Math.min(raw, 360 - raw)
}

export interface HsvWeights {
  hue: number
  saturation: number
  /** Weight applied to value when the colours are fully saturated. */
  valueAtFullChroma: number
  /** Weight applied to value when the colours carry no chroma at all. */
  valueAtNoChroma: number
}

export const DEFAULT_HSV_WEIGHTS: HsvWeights = {
  hue: 1,
  saturation: 1,
  valueAtFullChroma: 0.25,
  valueAtNoChroma: 1,
}

/**
 * Weighted HSV distance, roughly 0..1.
 *
 * Two adjustments carry the whole design:
 *
 * 1. Hue is scaled by the *lower* of the two saturations. A grey pixel has an
 *    arbitrary hue, so letting it contribute would match colours by noise.
 * 2. The value weight slides with chroma. For a saturated disc, lightness is
 *    mostly illumination and is discounted — that is the shade resilience. For a
 *    white or grey disc there is no hue or saturation signal left, so lightness
 *    is all there is and counts fully. A fixed low value weight would make a
 *    white disc match grey dirt.
 */
export function hsvDistance(
  first: Hsv,
  second: Hsv,
  weights: HsvWeights = DEFAULT_HSV_WEIGHTS,
): number {
  const chroma = Math.min(first.s, second.s)

  const hue = (hueDistance(first.h, second.h) / 180) * chroma * weights.hue
  const saturation = (first.s - second.s) * weights.saturation
  const valueWeight =
    weights.valueAtNoChroma + (weights.valueAtFullChroma - weights.valueAtNoChroma) * chroma
  const value = (first.v - second.v) * valueWeight

  return Math.sqrt(hue * hue + saturation * saturation + value * value)
}
