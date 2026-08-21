import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HSV_WEIGHTS,
  hsvDistance,
  hsvToRgb,
  hueDistance,
  rgbToHsv,
} from './hsv.ts'

const ORANGE_SUNLIT = rgbToHsv(230, 120, 30)
const ORANGE_SHADED = rgbToHsv(115, 60, 15)
const GRASS = rgbToHsv(110, 124, 62)
const WHITE = rgbToHsv(255, 255, 255)
const MID_GREY = rgbToHsv(128, 128, 128)

describe('rgbToHsv', () => {
  it.each([
    { name: 'red', rgb: [255, 0, 0], h: 0, s: 1, v: 1 },
    { name: 'cyan', rgb: [0, 255, 255], h: 180, s: 1, v: 1 },
    { name: 'grass', rgb: [110, 124, 62], h: 73.548, s: 0.5, v: 0.486275 },
    { name: 'orange disc', rgb: [230, 120, 30], h: 27, s: 0.869565, v: 0.901961 },
  ])('converts $name', ({ rgb, h, s, v }) => {
    const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2])
    expect(hsv.h).toBeCloseTo(h, 3)
    expect(hsv.s).toBeCloseTo(s, 5)
    expect(hsv.v).toBeCloseTo(v, 5)
  })

  it.each([
    ['white', [255, 255, 255], 1],
    ['mid grey', [128, 128, 128], 0.501961],
    ['black', [0, 0, 0], 0],
  ])('reports no saturation for %s, leaving hue undefined at 0', (_label, rgb, value) => {
    const hsv = rgbToHsv((rgb as number[])[0], (rgb as number[])[1], (rgb as number[])[2])
    expect(hsv.s).toBe(0)
    expect(hsv.h).toBe(0)
    expect(hsv.v).toBeCloseTo(value as number, 5)
  })

  /** The property the whole feature rests on. */
  it('holds hue and saturation fixed when only brightness changes', () => {
    expect(ORANGE_SHADED.h).toBeCloseTo(ORANGE_SUNLIT.h, 6)
    expect(ORANGE_SHADED.s).toBeCloseTo(ORANGE_SUNLIT.s, 6)
    expect(ORANGE_SHADED.v).toBeLessThan(ORANGE_SUNLIT.v / 1.9)
  })
})

describe('hsvToRgb', () => {
  it.each([
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [230, 120, 30],
    [110, 124, 62],
    [255, 255, 255],
    [128, 128, 128],
    [0, 0, 0],
  ])('round-trips rgb(%i, %i, %i)', (r, g, b) => {
    expect(hsvToRgb(rgbToHsv(r, g, b))).toEqual({ r, g, b })
  })

  it('normalises hue outside 0..360', () => {
    expect(hsvToRgb({ h: 387, s: 1, v: 1 })).toEqual(hsvToRgb({ h: 27, s: 1, v: 1 }))
    expect(hsvToRgb({ h: -333, s: 1, v: 1 })).toEqual(hsvToRgb({ h: 27, s: 1, v: 1 }))
  })
})

describe('hueDistance', () => {
  it('wraps around the circle rather than subtracting', () => {
    expect(hueDistance(350, 10)).toBeCloseTo(20, 9)
    expect(hueDistance(10, 350)).toBeCloseTo(20, 9)
  })

  it('is zero for the same hue', () => {
    expect(hueDistance(27, 27)).toBe(0)
  })

  it('caps at 180 degrees, the furthest two hues can be', () => {
    expect(hueDistance(0, 180)).toBeCloseTo(180, 9)
    expect(hueDistance(0, 181)).toBeCloseTo(179, 9)
  })

  it('normalises angles outside 0..360', () => {
    expect(hueDistance(725, 5)).toBeCloseTo(0, 9)
    expect(hueDistance(-10, 350)).toBeCloseTo(0, 9)
  })
})

describe('hsvDistance', () => {
  it('is zero for a colour against itself', () => {
    expect(hsvDistance(ORANGE_SUNLIT, ORANGE_SUNLIT)).toBe(0)
  })

  it('is symmetric', () => {
    expect(hsvDistance(ORANGE_SUNLIT, GRASS)).toBeCloseTo(hsvDistance(GRASS, ORANGE_SUNLIT), 12)
  })

  /**
   * The three properties that make HSV usable here. Numbers cross-checked
   * against an independent implementation of the same weighting.
   */
  it('rates the same disc in sun and shade as close', () => {
    expect(hsvDistance(ORANGE_SUNLIT, ORANGE_SHADED)).toBeCloseTo(0.1569, 3)
  })

  it('keeps the disc far from the grass behind it', () => {
    expect(hsvDistance(ORANGE_SUNLIT, GRASS)).toBeCloseTo(0.4699, 3)
    expect(hsvDistance(ORANGE_SHADED, GRASS)).toBeCloseTo(0.3922, 3)
  })

  /**
   * Without the chroma-adaptive value weight this is where HSV falls over: a
   * white disc and grey dirt share a meaningless hue and zero saturation, so a
   * fixed low value weight would call them the same thing.
   */
  it('keeps a white disc far from grey, where hue carries no information', () => {
    expect(hsvDistance(WHITE, MID_GREY)).toBeCloseTo(0.498, 3)
  })

  it('ignores hue entirely when either colour is unsaturated', () => {
    const greyish = { h: 0, s: 0, v: 0.5 }
    const sameGreyOtherHue = { h: 200, s: 0, v: 0.5 }
    expect(hsvDistance(greyish, sameGreyOtherHue)).toBe(0)
  })

  it('weights lightness fully at zero chroma and lightly at full chroma', () => {
    const darkGrey = { h: 0, s: 0, v: 0.2 }
    const lightGrey = { h: 0, s: 0, v: 0.8 }
    const darkSaturated = { h: 27, s: 1, v: 0.2 }
    const lightSaturated = { h: 27, s: 1, v: 0.8 }

    const greyGap = hsvDistance(darkGrey, lightGrey)
    const saturatedGap = hsvDistance(darkSaturated, lightSaturated)

    expect(greyGap).toBeCloseTo(0.6 * DEFAULT_HSV_WEIGHTS.valueAtNoChroma, 6)
    expect(saturatedGap).toBeCloseTo(0.6 * DEFAULT_HSV_WEIGHTS.valueAtFullChroma, 6)
    expect(saturatedGap).toBeLessThan(greyGap)
  })

  it('honours custom weights', () => {
    const ignoreValue = { ...DEFAULT_HSV_WEIGHTS, valueAtFullChroma: 0, valueAtNoChroma: 0 }
    expect(hsvDistance(ORANGE_SUNLIT, ORANGE_SHADED, ignoreValue)).toBeCloseTo(0, 9)
  })
})
