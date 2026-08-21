import { describe, expect, it } from 'vitest'
import { CV_HUE_MAX, modelToHsvBounds, modeToHsvBounds } from './hsvBounds.ts'
import { CYAN, MID_GREY, ORANGE, RED, WHITE, modeFromRgb } from './testing.ts'

describe('modeToHsvBounds', () => {
  /**
   * The wrap case is not hypothetical: the fixture disc is hue 27 degrees, which
   * is 13.5 in OpenCV's halved units, so a tolerance band around it crosses the
   * 0/179 seam. Bounds are cross-checked against an independent implementation.
   */
  it('splits an orange disc into two ranges across the hue seam', () => {
    const ranges = modeToHsvBounds(modeFromRgb(ORANGE), 0.2)

    expect(ranges).toHaveLength(2)
    expect(ranges[0]).toEqual({ lower: [0, 170, 83], upper: [35, 255, 255] })
    expect(ranges[1]).toEqual({ lower: [172, 170, 83], upper: [179, 255, 255] })
  })

  it('needs only one range for the same disc at a tight tolerance', () => {
    // The band no longer reaches the seam, so the split disappears.
    const ranges = modeToHsvBounds(modeFromRgb(ORANGE), 0.05)

    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toEqual({ lower: [8, 208, 193], upper: [19, 235, 255] })
  })

  it('leaves a mid-circle hue unsplit', () => {
    const ranges = modeToHsvBounds(modeFromRgb(CYAN), 0.2)

    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toEqual({ lower: [72, 204, 50], upper: [108, 255, 255] })
  })

  /**
   * A grey mode has no meaningful hue, so constraining hue at all would filter
   * on noise. The band opens to the whole circle and saturation/value carry the
   * discrimination instead.
   */
  it('accepts every hue for an unsaturated mode', () => {
    const ranges = modeToHsvBounds(modeFromRgb(MID_GREY), 0.2)

    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toEqual({ lower: [0, 0, 77], upper: [179, 51, 179] })
  })

  it('halves hue into OpenCV units rather than passing degrees through', () => {
    // Cyan is 180 degrees, which must land at 90 — the centre of OpenCV's range,
    // not off the end of it. Rounding outward keeps the band centred exactly.
    const [range] = modeToHsvBounds(modeFromRgb(CYAN), 0.05)
    expect(range).toEqual({ lower: [85, 242, 204], upper: [95, 255, 255] })
    expect((range.lower[0] + range.upper[0]) / 2).toBe(90)
  })

  it('never rounds a bound inward, which would reject accepted colours', () => {
    // Widening is safe; narrowing silently contradicts the tolerance.
    const [range] = modeToHsvBounds(modeFromRgb(CYAN), 0.05)
    expect(range.lower[0]).toBeLessThanOrEqual(85.5)
    expect(range.upper[0]).toBeGreaterThanOrEqual(94.5)
  })

  it('clamps saturation and value into a byte', () => {
    // White sits at the top of the value axis, so the upper bound must clamp.
    const ranges = modeToHsvBounds(modeFromRgb(WHITE), 0.3)
    for (const range of ranges) {
      for (const channel of [1, 2] as const) {
        expect(range.lower[channel]).toBeGreaterThanOrEqual(0)
        expect(range.upper[channel]).toBeLessThanOrEqual(255)
      }
    }
  })

  it.each([
    ['orange', ORANGE, 0.2],
    ['red', RED, 0.2],
    ['cyan', CYAN, 0.4],
    ['grey', MID_GREY, 0.1],
    ['white', WHITE, 0.25],
  ])('keeps hue inside 0..179 for %s', (_label, rgb, tolerance) => {
    for (const range of modeToHsvBounds(modeFromRgb(rgb), tolerance)) {
      expect(range.lower[0]).toBeGreaterThanOrEqual(0)
      expect(range.upper[0]).toBeLessThanOrEqual(CV_HUE_MAX)
      expect(range.lower[0]).toBeLessThanOrEqual(range.upper[0])
    }
  })

  it('widens the band as tolerance grows', () => {
    const width = (tolerance: number) => {
      const ranges = modeToHsvBounds(modeFromRgb(CYAN), tolerance)
      return ranges.reduce((sum, range) => sum + (range.upper[0] - range.lower[0]), 0)
    }
    expect(width(0.2)).toBeGreaterThan(width(0.05))
  })

  it('ignores weights that would divide by zero', () => {
    const ranges = modeToHsvBounds(modeFromRgb(ORANGE), 0.2, {
      hue: 0,
      saturation: 0,
      valueAtFullChroma: 0,
      valueAtNoChroma: 0,
    })
    // With every axis unweighted the box degenerates to "anything".
    expect(ranges).toEqual([{ lower: [0, 0, 0], upper: [179, 255, 255] }])
  })
})

describe('modelToHsvBounds', () => {
  it('flattens every mode, including the split ones', () => {
    // Orange splits into two; cyan stays one.
    const ranges = modelToHsvBounds([modeFromRgb(ORANGE, 0.6), modeFromRgb(CYAN, 0.4)], 0.2)
    expect(ranges).toHaveLength(3)
  })

  it('returns nothing for a model with no modes', () => {
    expect(modelToHsvBounds([], 0.2)).toEqual([])
  })
})
