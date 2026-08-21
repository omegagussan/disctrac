import { describe, expect, it } from 'vitest'
import { labDistance, labToHex, oklabToSrgb, srgbToOklab } from './color.ts'

describe('srgbToOklab', () => {
  // Anchors that follow from the transform itself: equal linear RGB has no
  // chroma, and white is defined as L = 1.
  it('maps white to L=1 with no chroma', () => {
    const lab = srgbToOklab(255, 255, 255)
    expect(lab.L).toBeCloseTo(1, 5)
    expect(lab.a).toBeCloseTo(0, 5)
    expect(lab.b).toBeCloseTo(0, 5)
  })

  it('maps black to the origin', () => {
    const lab = srgbToOklab(0, 0, 0)
    expect(lab.L).toBeCloseTo(0, 6)
    expect(lab.a).toBeCloseTo(0, 6)
    expect(lab.b).toBeCloseTo(0, 6)
  })

  it('leaves greys free of chroma', () => {
    const lab = srgbToOklab(128, 128, 128)
    expect(lab.a).toBeCloseTo(0, 6)
    expect(lab.b).toBeCloseTo(0, 6)
    expect(lab.L).toBeCloseTo(0.599871, 5)
  })

  // Values cross-checked against an independent implementation of the same
  // published transform, so this catches a transposed coefficient.
  it.each([
    { name: 'red', rgb: [255, 0, 0], L: 0.627955, a: 0.224863, b: 0.125846 },
    { name: 'green', rgb: [0, 255, 0], L: 0.86644, a: -0.233888, b: 0.179498 },
    { name: 'blue', rgb: [0, 0, 255], L: 0.452014, a: -0.032457, b: -0.311528 },
    { name: 'grass', rgb: [110, 124, 62], L: 0.560044, a: -0.043641, b: 0.076195 },
    { name: 'orange disc', rgb: [230, 120, 30], L: 0.685934, a: 0.098794, b: 0.131061 },
  ])('matches the reference transform for $name', ({ rgb, L, a, b }) => {
    const lab = srgbToOklab(rgb[0], rgb[1], rgb[2])
    expect(lab.L).toBeCloseTo(L, 5)
    expect(lab.a).toBeCloseTo(a, 5)
    expect(lab.b).toBeCloseTo(b, 5)
  })
})

describe('oklabToSrgb', () => {
  it.each([
    [255, 255, 255],
    [0, 0, 0],
    [255, 0, 0],
    [110, 124, 62],
    [230, 120, 30],
    [17, 200, 240],
  ])('round-trips rgb(%i, %i, %i)', (r, g, b) => {
    expect(oklabToSrgb(srgbToOklab(r, g, b))).toEqual({ r, g, b })
  })

  it('clamps out-of-gamut colours instead of returning nonsense channels', () => {
    const rgb = oklabToSrgb({ L: 0.9, a: 0.4, b: -0.4 })
    for (const channel of [rgb.r, rgb.g, rgb.b]) {
      expect(channel).toBeGreaterThanOrEqual(0)
      expect(channel).toBeLessThanOrEqual(255)
      expect(Number.isInteger(channel)).toBe(true)
    }
  })
})

describe('labDistance', () => {
  it('is zero for a colour against itself', () => {
    expect(labDistance(srgbToOklab(230, 120, 30), srgbToOklab(230, 120, 30))).toBe(0)
  })

  it('is symmetric', () => {
    const first = srgbToOklab(255, 0, 0)
    const second = srgbToOklab(0, 0, 255)
    expect(labDistance(first, second)).toBeCloseTo(labDistance(second, first), 12)
  })

  /**
   * The property the default tolerance depends on: sensor noise on a flat
   * surface must fall well below it, while a disc against grass must sit well
   * above. If this inverts, flood fill either leaks or selects nothing.
   */
  it('separates disc-vs-background by far more than sensor noise', () => {
    const noise = labDistance(srgbToOklab(255, 255, 255), srgbToOklab(250, 250, 250))
    const discVsGrass = labDistance(srgbToOklab(230, 120, 30), srgbToOklab(110, 124, 62))

    expect(noise).toBeLessThan(0.02)
    expect(discVsGrass).toBeGreaterThan(0.15)
    expect(discVsGrass).toBeGreaterThan(noise * 10)
  })
})

describe('labToHex', () => {
  it.each([
    [[255, 0, 0], '#ff0000'],
    [[255, 255, 255], '#ffffff'],
    [[0, 0, 0], '#000000'],
    [[17, 200, 240], '#11c8f0'],
  ])('renders rgb(%s) as %s', (rgb, hex) => {
    const [r, g, b] = rgb as number[]
    expect(labToHex(srgbToOklab(r, g, b))).toBe(hex)
  })
})
