import { describe, expect, it } from 'vitest'
import type { Point } from './pointer.ts'
import { evaluatePolynomial, fitPolynomial, smoothPath } from './smoothing.ts'

const meanDistance = (a: Point[], b: Point[]) =>
  a.reduce((sum, point, index) => sum + Math.hypot(point.x - b[index].x, point.y - b[index].y), 0) /
  a.length

describe('fitPolynomial', () => {
  it.each([
    { name: 'a line', coefficients: [3, -2] },
    { name: 'a parabola', coefficients: [1, 0.5, -0.25] },
    { name: 'a cubic', coefficients: [-2, 1, 0.1, 0.05] },
  ])('recovers the coefficients of $name exactly', ({ coefficients }) => {
    const xs = [-4, -3, -2, -1, 0, 1, 2, 3, 4]
    const ys = xs.map((x) => evaluatePolynomial(coefficients, x))

    const fitted = fitPolynomial(xs, ys, coefficients.length - 1)
    for (let index = 0; index < coefficients.length; index += 1) {
      expect(fitted[index]).toBeCloseTo(coefficients[index], 6)
    }
  })

  it('averages through noise rather than chasing it', () => {
    const xs = [-2, -1, 0, 1, 2]
    // A flat line at 10 with noise symmetric about the centre, so the fitted
    // slope must come out at zero.
    const ys = [12, 8, 10, 8, 12]
    const [constant, slope] = fitPolynomial(xs, ys, 1)
    expect(constant).toBeCloseTo(10, 6)
    expect(slope).toBeCloseTo(0, 6)
  })

  it('returns zeros for a system it cannot solve', () => {
    // Every abscissa identical: no unique line through the data.
    expect(fitPolynomial([2, 2, 2], [1, 2, 3], 1)).toEqual([0, 0])
  })
})

describe('smoothPath', () => {
  const line = Array.from({ length: 20 }, (_, index) => ({ x: index * 5, y: 100 + index * 2 }))

  it('leaves a straight path untouched', () => {
    const smoothed = smoothPath(line)
    expect(meanDistance(smoothed, line)).toBeLessThan(1e-9)
  })

  it('leaves a parabola untouched, since it fits the model exactly', () => {
    const parabola = Array.from({ length: 20 }, (_, index) => ({
      x: index * 4,
      y: 50 + 0.5 * index * index,
    }))
    expect(meanDistance(smoothPath(parabola), parabola)).toBeLessThan(1e-9)
  })

  /** The reason for smoothing at all: a disc cannot jink, so a kink is noise. */
  it('pulls a noisy path back toward the truth', () => {
    // Deterministic zig-zag noise, so the test cannot flake.
    const noisy = line.map((point, index) => ({
      x: point.x + (index % 2 === 0 ? 6 : -6),
      y: point.y + (index % 3 === 0 ? -5 : 4),
    }))

    const before = meanDistance(noisy, line)
    const after = meanDistance(smoothPath(noisy), line)

    expect(before).toBeGreaterThan(6)
    expect(after).toBeLessThan(before / 2)
  })

  it('flattens a single impossible spike', () => {
    const spike = 90
    const spiked = line.map((point, index) =>
      index === 10 ? { x: point.x + spike, y: point.y } : point,
    )
    const smoothed = smoothPath(spiked)
    // The fit is pulled by the spike as well as pulling on it, so it cannot
    // vanish entirely — but two thirds of it must go.
    expect(Math.abs(smoothed[10].x - line[10].x)).toBeLessThan(spike / 3)
  })

  /**
   * With the camera panning, the path doubles back horizontally. Fitting y as a
   * function of x could not represent this at all; fitting x(t) and y(t)
   * separately handles it without noticing.
   */
  it('handles a path that doubles back on itself', () => {
    const hairpin = [
      ...Array.from({ length: 10 }, (_, index) => ({ x: 200 - index * 10, y: 100 + index })),
      ...Array.from({ length: 10 }, (_, index) => ({ x: 110 + index * 10, y: 110 + index })),
    ]
    const smoothed = smoothPath(hairpin)

    expect(smoothed).toHaveLength(hairpin.length)
    // The turn survives: x still falls then rises.
    expect(smoothed[5].x).toBeLessThan(smoothed[0].x)
    expect(smoothed[19].x).toBeGreaterThan(smoothed[10].x)
    expect(smoothed.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
  })

  it('keeps the endpoints near where the path actually starts and ends', () => {
    const smoothed = smoothPath(line)
    expect(Math.hypot(smoothed[0].x - line[0].x, smoothed[0].y - line[0].y)).toBeLessThan(1e-9)
    const last = line.length - 1
    expect(Math.hypot(smoothed[last].x - line[last].x, smoothed[last].y - line[last].y)).toBeLessThan(1e-9)
  })

  it.each([
    ['fewer points than the fit needs', 3],
    ['a single point', 1],
    ['nothing at all', 0],
  ])('returns %s unchanged', (_label, count) => {
    const short = line.slice(0, count)
    expect(smoothPath(short)).toEqual(short)
  })

  it('treats an even window as the next odd one, so it stays centred', () => {
    const noisy = line.map((point, index) => ({ ...point, y: point.y + (index % 2 ? 4 : -4) }))
    expect(smoothPath(noisy, { window: 8 })).toEqual(smoothPath(noisy, { window: 9 }))
  })

  it('smooths harder with a longer window', () => {
    const noisy = line.map((point, index) => ({ ...point, y: point.y + (index % 2 ? 8 : -8) }))
    const short = meanDistance(smoothPath(noisy, { window: 5 }), line)
    const long = meanDistance(smoothPath(noisy, { window: 15 }), line)
    expect(long).toBeLessThan(short)
  })
})
