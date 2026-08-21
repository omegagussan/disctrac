import { oklabToSrgb } from './color.ts'
import type { ColorMode } from './discModel.ts'
import type { HsvWeights } from './hsv.ts'
import { DEFAULT_HSV_WEIGHTS, rgbToHsv } from './hsv.ts'

/**
 * Turning a colour mode into OpenCV `inRange` bounds.
 *
 * Two unit systems collide here. `src/video/hsv.ts` works in H 0..360 and S,V
 * 0..1; OpenCV's 8-bit HSV uses **H 0..179** (hue halved to fit a byte) and
 * **S,V 0..255**. Mixing them produces a silently empty or absurdly permissive
 * mask rather than an error, so the conversion lives here, alone, and is tested.
 */

/** Inclusive bounds in OpenCV's 8-bit HSV units. */
export interface CvHsvRange {
  lower: [number, number, number]
  upper: [number, number, number]
}

export const CV_HUE_MAX = 179
export const CV_HUE_PERIOD = 180

/**
 * Rounding always widens, never narrows: a lower bound floors and an upper bound
 * ceils. Rounding a threshold inward would silently reject colours the tolerance
 * was asked to accept, and it also shifts the band off centre, since half-way
 * ties all break the same direction.
 */
const clampLower = (value: number) => Math.max(0, Math.min(255, Math.floor(value)))
const clampUpper = (value: number) => Math.max(0, Math.min(255, Math.ceil(value)))

/**
 * Bounds enclosing the colours that `hsvDistance` would accept within
 * `tolerance` of this mode.
 *
 * The per-axis half-widths are derived from the *same* weights the distance
 * function uses, by asking what change along each axis alone would consume the
 * whole tolerance. The result is the box circumscribing the metric's ellipsoid,
 * so it is deliberately a little more permissive than the metric itself — a box
 * cannot express saturation-gated hue or a chroma-dependent lightness weight.
 * That looseness is the known cost of thresholding with `inRange`.
 *
 * Returns **two** ranges when the hue band crosses the 0/179 seam, which happens
 * readily: the fixture's orange disc sits at hue 27 degrees, i.e. 13.5 in
 * OpenCV units, so any usable tolerance straddles the wrap.
 */
export function modeToHsvBounds(
  mode: ColorMode,
  tolerance: number,
  weights: HsvWeights = DEFAULT_HSV_WEIGHTS,
): CvHsvRange[] {
  const { r, g, b } = oklabToSrgb(mode.lab)
  const hsv = rgbToHsv(r, g, b)
  const chroma = hsv.s

  // Hue's contribution to the distance is scaled by chroma, so the tolerance
  // buys a wider hue band the greyer the colour — and buys no constraint at all
  // once chroma reaches zero, where hue is meaningless.
  const hueHalfDegrees =
    chroma > 0 && weights.hue > 0
      ? Math.min(180, (tolerance * 180) / (chroma * weights.hue))
      : 180

  const saturationHalf = weights.saturation > 0 ? tolerance / weights.saturation : 1
  const valueWeight =
    weights.valueAtNoChroma + (weights.valueAtFullChroma - weights.valueAtNoChroma) * chroma
  const valueHalf = valueWeight > 0 ? tolerance / valueWeight : 1

  const saturation: [number, number] = [
    clampLower((hsv.s - saturationHalf) * 255),
    clampUpper((hsv.s + saturationHalf) * 255),
  ]
  const value: [number, number] = [
    clampLower((hsv.v - valueHalf) * 255),
    clampUpper((hsv.v + valueHalf) * 255),
  ]

  const build = (hueLower: number, hueUpper: number): CvHsvRange => ({
    lower: [hueLower, saturation[0], value[0]],
    upper: [hueUpper, saturation[1], value[1]],
  })

  // Half the band in OpenCV units, because hue itself is halved.
  const hueHalf = hueHalfDegrees / 2
  if (hueHalf >= CV_HUE_PERIOD / 2) {
    // The band covers the whole circle; splitting it would be meaningless.
    return [build(0, CV_HUE_MAX)]
  }

  const centre = hsv.h / 2
  const lower = centre - hueHalf
  const upper = centre + hueHalf

  if (lower < 0) {
    return [
      build(0, Math.ceil(upper)),
      build(Math.floor(lower + CV_HUE_PERIOD), CV_HUE_MAX),
    ]
  }
  if (upper > CV_HUE_MAX) {
    return [
      build(Math.floor(lower), CV_HUE_MAX),
      build(0, Math.ceil(upper - CV_HUE_PERIOD)),
    ]
  }
  return [build(Math.floor(lower), Math.ceil(upper))]
}

/** Bounds for every mode in a model, flattened — each is OR'd into the mask. */
export function modelToHsvBounds(
  modes: ColorMode[],
  tolerance: number,
  weights: HsvWeights = DEFAULT_HSV_WEIGHTS,
): CvHsvRange[] {
  return modes.flatMap((mode) => modeToHsvBounds(mode, tolerance, weights))
}
