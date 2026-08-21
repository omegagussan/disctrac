import { describe, expect, it } from 'vitest'
import { HSV_METRIC, METRICS, OKLAB_METRIC, metricByName } from './metric.ts'

const SUNLIT: [number, number, number] = [230, 120, 30]
const SHADED: [number, number, number] = [115, 60, 15]
const GRASS: [number, number, number] = [110, 124, 62]

const measure = (
  metric: typeof OKLAB_METRIC | typeof HSV_METRIC,
  first: [number, number, number],
  second: [number, number, number],
) =>
  (metric as { project(r: number, g: number, b: number): unknown; distance(a: unknown, b: unknown): number })
    .distance(
      metric.project(first[0], first[1], first[2]),
      metric.project(second[0], second[1], second[2]),
    )

describe.each([
  ['OKLab', OKLAB_METRIC],
  ['HSV', HSV_METRIC],
])('%s metric', (_name, metric) => {
  it('rates a colour against itself as identical', () => {
    expect(measure(metric, SUNLIT, SUNLIT)).toBe(0)
  })

  it('keeps the disc distinguishable from the grass behind it', () => {
    expect(measure(metric, SUNLIT, GRASS)).toBeGreaterThan(metric.defaultTolerance)
  })

  it('carries a usable default tolerance', () => {
    expect(metric.defaultTolerance).toBeGreaterThan(0)
    expect(metric.defaultTolerance).toBeLessThan(1)
  })
})

/**
 * The reason both metrics exist. Neither is better in general: OKLab counts the
 * lightness drop from shade at full weight and so splits one disc into two
 * regions, while HSV discounts it and holds the disc together.
 */
describe('shade resilience', () => {
  it('excludes a shaded disc under OKLab', () => {
    expect(measure(OKLAB_METRIC, SUNLIT, SHADED)).toBeGreaterThan(OKLAB_METRIC.defaultTolerance)
  })

  it('includes the same shaded disc under HSV', () => {
    expect(measure(HSV_METRIC, SUNLIT, SHADED)).toBeLessThanOrEqual(HSV_METRIC.defaultTolerance)
  })
})

describe('metricByName', () => {
  it.each([
    ['hsv', HSV_METRIC],
    ['oklab', OKLAB_METRIC],
  ] as const)('resolves %s', (name, expected) => {
    expect(metricByName(name)).toBe(expected)
  })
})

describe('METRICS', () => {
  it('lists both, HSV first as the default offered', () => {
    expect(METRICS.map((metric) => metric.name)).toEqual(['hsv', 'oklab'])
  })

  it('gives every metric a label and a description for the UI', () => {
    for (const metric of METRICS) {
      expect(metric.label.length).toBeGreaterThan(0)
      expect(metric.description.length).toBeGreaterThan(0)
    }
  })
})
