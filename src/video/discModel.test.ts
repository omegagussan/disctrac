import { describe, expect, it } from 'vitest'
import { labToHex } from './color.ts'
import { buildDiscColorModel, cropMaskedRegion, maskedLabs } from './discModel.ts'
import { emptyMask, floodFillMask, unionMasks } from './floodFill.ts'
import { ORANGE, RED, WHITE, makeFrame } from './testing.ts'

/** 10x10, red on the left half, white on the right. */
const twoToneFrame = () => makeFrame(10, 10, (x) => (x < 5 ? RED : WHITE))

/** Both halves selected, built the way the UI builds it: two fills, unioned. */
const twoToneMask = () => {
  const frame = twoToneFrame()
  return unionMasks(floodFillMask(frame, 0, 0), floodFillMask(frame, 9, 0))
}

describe('buildDiscColorModel', () => {
  it('describes a uniform selection with a single tight mode', () => {
    const frame = makeFrame(6, 6, () => ORANGE)
    const model = buildDiscColorModel(frame, floodFillMask(frame, 3, 3))

    expect(model.modes).toHaveLength(1)
    expect(model.modes[0].weight).toBeCloseTo(1, 6)
    expect(model.modes[0].spread).toBeCloseTo(0, 6)
    expect(labToHex(model.modes[0].lab)).toBe('#e6781e')
    expect(model.pixelCount).toBe(36)
  })

  /**
   * The whole point of the multi-modal representation: a two-tone disc must not
   * collapse to the average of its colours, which here would be a pink that
   * appears nowhere on the disc.
   */
  it('keeps a two-tone selection as two distinct modes', () => {
    const model = buildDiscColorModel(twoToneFrame(), twoToneMask())

    expect(model.modes).toHaveLength(2)
    expect(model.modes.map((mode) => labToHex(mode.lab)).sort()).toEqual(['#ff0000', '#ffffff'])
    for (const mode of model.modes) {
      expect(mode.weight).toBeCloseTo(0.5, 6)
    }
  })

  it('gives weights that sum to 1', () => {
    const model = buildDiscColorModel(twoToneFrame(), twoToneMask())
    const total = model.modes.reduce((sum, mode) => sum + mode.weight, 0)
    expect(total).toBeCloseTo(1, 6)
  })

  it('returns nothing for an empty mask', () => {
    expect(buildDiscColorModel(twoToneFrame(), emptyMask(10, 10))).toEqual({
      modes: [],
      pixelCount: 0,
    })
  })

  it('merges modes that are too close to tell apart', () => {
    // Two greys 2/255 apart: separate clusters geometrically, one colour visually.
    const frame = makeFrame(10, 1, (x) => (x < 5 ? [200, 200, 200] : [202, 202, 202]))
    const mask = unionMasks(floodFillMask(frame, 0, 0, 0), floodFillMask(frame, 9, 0, 0))
    const model = buildDiscColorModel(frame, mask)

    expect(model.modes).toHaveLength(1)
    expect(model.modes[0].weight).toBeCloseTo(1, 6)
  })

  it('drops a speck too small to be part of the disc', () => {
    // 99 white pixels and 1 red: the red is 1% of the selection, under the 2% floor.
    const frame = makeFrame(10, 10, (x, y) => (x === 0 && y === 0 ? RED : WHITE))
    const mask = unionMasks(floodFillMask(frame, 0, 0, 0), floodFillMask(frame, 5, 5, 0))
    const model = buildDiscColorModel(frame, mask)

    expect(model.pixelCount).toBe(100)
    expect(model.modes).toHaveLength(1)
    expect(labToHex(model.modes[0].lab)).toBe('#ffffff')
  })

  it('never exceeds the mode cap', () => {
    const palette: [number, number, number][] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [255, 0, 255],
      [0, 255, 255],
    ]
    const frame = makeFrame(6, 4, (x) => palette[x])
    let mask = emptyMask(6, 4)
    for (let x = 0; x < 6; x += 1) mask = unionMasks(mask, floodFillMask(frame, x, 0, 0))

    const model = buildDiscColorModel(frame, mask)
    expect(model.modes.length).toBeLessThanOrEqual(4)
    expect(model.modes.length).toBeGreaterThan(1)
  })

  it('honours an explicit maxModes', () => {
    const model = buildDiscColorModel(twoToneFrame(), twoToneMask(), { maxModes: 1 })
    expect(model.modes).toHaveLength(1)
  })

  /**
   * Clustering seeds deterministically on purpose — random seeding would make the
   * same click yield different modes run to run, which is untestable and reads as
   * a bug to the user.
   */
  it('gives identical results for identical input', () => {
    const frame = twoToneFrame()
    expect(buildDiscColorModel(frame, twoToneMask())).toEqual(
      buildDiscColorModel(frame, twoToneMask()),
    )
  })

  it('sorts modes by descending weight', () => {
    // 75% white, 25% red.
    const frame = makeFrame(8, 4, (x) => (x < 2 ? RED : WHITE))
    let mask = emptyMask(8, 4)
    for (const x of [0, 4]) mask = unionMasks(mask, floodFillMask(frame, x, 0, 0))

    const model = buildDiscColorModel(frame, mask)
    const weights = model.modes.map((mode) => mode.weight)
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
    expect(labToHex(model.modes[0].lab)).toBe('#ffffff')
  })
})

describe('maskedLabs', () => {
  it('reads only the selected pixels', () => {
    const frame = twoToneFrame()
    const labs = maskedLabs(frame, floodFillMask(frame, 0, 0))
    expect(labs).toHaveLength(50)
    for (const lab of labs) {
      expect(labToHex(lab)).toBe('#ff0000')
    }
  })
})

describe('cropMaskedRegion', () => {
  it('crops to the selection bounds', () => {
    // 3x3 red block inset in a 7x7 frame.
    const frame = makeFrame(7, 7, (x, y) => (x >= 2 && x <= 4 && y >= 1 && y <= 3 ? RED : WHITE))
    const region = cropMaskedRegion(frame, floodFillMask(frame, 3, 2))

    expect(region).not.toBeNull()
    expect(region!.width).toBe(3)
    expect(region!.height).toBe(3)
    expect(region!.data).toHaveLength(3 * 3 * 4)
  })

  it('makes unselected pixels transparent so the cutout shows the disc alone', () => {
    // An L-shape: its bounding box includes a corner that is not selected.
    const frame = makeFrame(4, 4, (x, y) => {
      const inShape = (x === 0 && y <= 2) || (y === 2 && x <= 2)
      return inShape ? RED : WHITE
    })
    const region = cropMaskedRegion(frame, floodFillMask(frame, 0, 0))
    expect(region).not.toBeNull()

    // Top-right of the bounding box is background, so it must be transparent.
    const cornerAlpha = region!.data[(0 * region!.width + 2) * 4 + 3]
    expect(cornerAlpha).toBe(0)

    // A selected pixel keeps its colour at full opacity.
    const selected = region!.data.slice(0, 4)
    expect([...selected]).toEqual([255, 0, 0, 255])
  })

  it('returns null when nothing is selected', () => {
    expect(cropMaskedRegion(twoToneFrame(), emptyMask(10, 10))).toBeNull()
  })
})
