import { describe, expect, it } from 'vitest'
import { DEFAULT_TOLERANCE, emptyMask, floodFillMask, mergeBounds, unionMasks } from './floodFill.ts'
import { HSV_METRIC, OKLAB_METRIC } from './metric.ts'
import { GRASS, ORANGE, RED, WHITE, makeFrame } from './testing.ts'

/** 5x5 white frame with a 3x3 red block inset by one pixel. */
const blockFrame = () =>
  makeFrame(5, 5, (x, y) => (x >= 1 && x <= 3 && y >= 1 && y <= 3 ? RED : WHITE))

describe('floodFillMask', () => {
  it('selects exactly the region containing the seed', () => {
    const mask = floodFillMask(blockFrame(), 2, 2)
    expect(mask.pixelCount).toBe(9)
    expect(mask.bounds).toEqual({ minX: 1, minY: 1, maxX: 3, maxY: 3 })
  })

  it('selects the surrounding region when seeded outside the block', () => {
    const mask = floodFillMask(blockFrame(), 0, 0)
    expect(mask.pixelCount).toBe(16)
    expect(mask.bounds).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 4 })
    // The block itself must be excluded even though its bounds are enclosed.
    expect(mask.data[2 * 5 + 2]).toBe(0)
  })

  it('marks only 0 or 1, never a stray value', () => {
    const mask = floodFillMask(blockFrame(), 2, 2)
    expect([...new Set(mask.data)].sort()).toEqual([0, 1])
  })

  it.each([
    ['negative x', -1, 2],
    ['negative y', 2, -1],
    ['x past the edge', 5, 2],
    ['y past the edge', 2, 5],
  ])('returns an empty mask for a seed with %s', (_label, x, y) => {
    const mask = floodFillMask(blockFrame(), x, y)
    expect(mask.pixelCount).toBe(0)
    expect(mask.bounds).toBeNull()
  })

  it('floors fractional seed coordinates', () => {
    const mask = floodFillMask(blockFrame(), 2.9, 2.1)
    expect(mask.pixelCount).toBe(9)
  })

  it('does not join regions that touch only diagonally', () => {
    // Two 2x2 red squares meeting at a corner; 4-connectivity must keep them apart.
    const frame = makeFrame(4, 4, (x, y) => {
      const inFirst = x <= 1 && y <= 1
      const inSecond = x >= 2 && y >= 2
      return inFirst || inSecond ? RED : WHITE
    })
    const mask = floodFillMask(frame, 0, 0)
    expect(mask.pixelCount).toBe(4)
    expect(mask.bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 })
  })

  it('takes only the seed colour when tolerance is zero', () => {
    // One pixel differs by a single channel step — invisible, but not identical.
    const frame = makeFrame(3, 1, (x) => (x === 1 ? [254, 255, 255] : WHITE))
    const mask = floodFillMask(frame, 0, 0, 0)
    expect(mask.pixelCount).toBe(1)
  })

  it('absorbs sensor noise at the default tolerance', () => {
    const frame = makeFrame(3, 1, (x) => (x === 1 ? [250, 250, 250] : WHITE))
    const mask = floodFillMask(frame, 0, 0, DEFAULT_TOLERANCE)
    expect(mask.pixelCount).toBe(3)
  })

  /**
   * The reason fills compare against the seed rather than each pixel's
   * neighbour: on a gradient, neighbour-comparison walks the whole ramp in
   * imperceptible steps and escapes the object entirely.
   */
  it('stops partway along a gradient instead of creeping to the far end', () => {
    const frame = makeFrame(64, 1, (x) => {
      const value = 255 - x * 4
      return [value, value, value]
    })
    const mask = floodFillMask(frame, 0, 0, DEFAULT_TOLERANCE)

    expect(mask.pixelCount).toBeGreaterThan(1)
    expect(mask.pixelCount).toBeLessThan(64)
    expect(mask.data[63]).toBe(0)
  })

  it('keeps a disc separate from grass at the default tolerance', () => {
    const frame = makeFrame(9, 9, (x, y) => {
      const dx = x - 4
      const dy = y - 4
      return dx * dx + dy * dy <= 4 ? ORANGE : GRASS
    })
    const mask = floodFillMask(frame, 4, 4, DEFAULT_TOLERANCE)
    // The disc is 13 pixels at this radius; grass must not be swept in.
    expect(mask.pixelCount).toBe(13)
  })
})

describe('unionMasks', () => {
  it('combines counts and bounds of disjoint selections', () => {
    const frame = blockFrame()
    const block = floodFillMask(frame, 2, 2)
    const surround = floodFillMask(frame, 0, 0)
    const union = unionMasks(block, surround)

    expect(union.pixelCount).toBe(25)
    expect(union.bounds).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 4 })
  })

  it('does not double-count overlapping selections', () => {
    const frame = blockFrame()
    const first = floodFillMask(frame, 2, 2)
    const union = unionMasks(first, floodFillMask(frame, 2, 2))
    expect(union.pixelCount).toBe(9)
  })

  it('treats an empty mask as a no-op', () => {
    const block = floodFillMask(blockFrame(), 2, 2)
    const union = unionMasks(block, emptyMask(5, 5))
    expect(union.pixelCount).toBe(9)
    expect(union.bounds).toEqual(block.bounds)
  })

  it('refuses masks of different sizes', () => {
    expect(() => unionMasks(emptyMask(4, 4), emptyMask(5, 5))).toThrow(/different sizes/)
  })
})

describe('mergeBounds', () => {
  it('returns the other side when one is null', () => {
    const bounds = { minX: 1, minY: 2, maxX: 3, maxY: 4 }
    expect(mergeBounds(null, bounds)).toEqual(bounds)
    expect(mergeBounds(bounds, null)).toEqual(bounds)
    expect(mergeBounds(null, null)).toBeNull()
  })

  it('takes the outer extent of both', () => {
    expect(
      mergeBounds({ minX: 5, minY: 0, maxX: 9, maxY: 2 }, { minX: 1, minY: 4, maxX: 6, maxY: 7 }),
    ).toEqual({ minX: 1, minY: 0, maxX: 9, maxY: 7 })
  })
})

/**
 * A disc lit on one side and shaded on the other, sitting on grass. This is the
 * case that motivates having two metrics at all: the pixels belong to one disc,
 * but their lightness differs by half.
 */
describe('metric choice on a half-shaded disc', () => {
  const SHADED_ORANGE: [number, number, number] = [115, 60, 15]

  const halfShadedDisc = () =>
    makeFrame(9, 9, (x, y) => {
      const dx = x - 4
      const dy = y - 4
      if (dx * dx + dy * dy > 4) return GRASS
      return dx < 0 ? ORANGE : SHADED_ORANGE
    })

  // Seeded on the sunlit side; the disc is 13 pixels, 4 of them sunlit.
  it('splits the disc under OKLab, taking only the lit side', () => {
    const mask = floodFillMask(halfShadedDisc(), 3, 4, OKLAB_METRIC.defaultTolerance, OKLAB_METRIC)
    expect(mask.pixelCount).toBe(4)
  })

  it('holds the disc together under HSV', () => {
    const mask = floodFillMask(halfShadedDisc(), 3, 4, HSV_METRIC.defaultTolerance, HSV_METRIC)
    expect(mask.pixelCount).toBe(13)
    expect(mask.bounds).toEqual({ minX: 2, minY: 2, maxX: 6, maxY: 6 })
  })

  it.each([
    ['OKLab', OKLAB_METRIC],
    ['HSV', HSV_METRIC],
  ])('does not spill into the grass under %s', (_label, metric) => {
    const mask = floodFillMask(halfShadedDisc(), 3, 4, metric.defaultTolerance, metric)
    // Corner pixel is grass, far outside the disc.
    expect(mask.data[0]).toBe(0)
  })
})
