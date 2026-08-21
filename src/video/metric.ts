import type { Lab } from './color.ts'
import { labDistance, srgbToOklab } from './color.ts'
import type { Hsv } from './hsv.ts'
import { hsvDistance, rgbToHsv } from './hsv.ts'

export type MetricName = 'oklab' | 'hsv'

/**
 * How "are these two colours the same thing?" gets answered.
 *
 * Two spaces, because neither wins outright. OKLab counts a lightness change at
 * full weight, which is right when the disc is evenly lit and wrong the moment
 * half of it falls into shade. HSV discounts lightness and follows the disc into
 * shade, but has nothing to say about a white disc, where hue and saturation
 * carry no signal at all.
 */
export interface ColorMetric<TVector = unknown> {
  readonly name: MetricName
  readonly label: string
  readonly description: string
  /**
   * Distances are not comparable between metrics — the same number means
   * different things — so each metric carries the tolerance that suits it.
   */
  readonly defaultTolerance: number
  project(r: number, g: number, b: number): TVector
  distance(first: TVector, second: TVector): number
}

export const OKLAB_METRIC: ColorMetric<Lab> = {
  name: 'oklab',
  label: 'OKLab',
  description: 'Perceptual distance. Tightest selection when the disc is evenly lit.',
  defaultTolerance: 0.12,
  project: srgbToOklab,
  distance: labDistance,
}

export const HSV_METRIC: ColorMetric<Hsv> = {
  name: 'hsv',
  label: 'HSV',
  description: 'Discounts brightness, so a disc half in shade still selects as one disc.',
  defaultTolerance: 0.2,
  project: rgbToHsv,
  distance: (first, second) => hsvDistance(first, second),
}

export const METRICS: ColorMetric[] = [HSV_METRIC, OKLAB_METRIC]

export function metricByName(name: MetricName): ColorMetric {
  return name === 'hsv' ? HSV_METRIC : OKLAB_METRIC
}
