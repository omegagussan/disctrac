import { describe, expect, it } from 'vitest'
import {
  IDENTITY,
  applyAffine,
  composeAffine,
  displacementAt,
  invertAffine,
  linearPart,
} from './affine.ts'

const translation = (tx: number, ty: number) => ({ ...IDENTITY, tx, ty })
const rotation = (radians: number) => ({
  a: Math.cos(radians),
  b: -Math.sin(radians),
  c: Math.sin(radians),
  d: Math.cos(radians),
  tx: 0,
  ty: 0,
})

describe('applyAffine', () => {
  it('leaves a point where it is under the identity', () => {
    expect(applyAffine(IDENTITY, { x: 12, y: -3 })).toEqual({ x: 12, y: -3 })
  })

  it('shifts by the translation', () => {
    expect(applyAffine(translation(10, -4), { x: 1, y: 1 })).toEqual({ x: 11, y: -3 })
  })

  it('rotates a quarter turn', () => {
    const turned = applyAffine(rotation(Math.PI / 2), { x: 1, y: 0 })
    expect(turned.x).toBeCloseTo(0, 12)
    expect(turned.y).toBeCloseTo(1, 12)
  })
})

describe('composeAffine', () => {
  it('applies the inner transform first', () => {
    // Scale by two, then shift: the shift must not be scaled.
    const scale = { a: 2, b: 0, c: 0, d: 2, tx: 0, ty: 0 }
    const combined = composeAffine(translation(5, 5), scale)
    expect(applyAffine(combined, { x: 1, y: 1 })).toEqual({ x: 7, y: 7 })
  })

  it('is not commutative', () => {
    const scale = { a: 2, b: 0, c: 0, d: 2, tx: 0, ty: 0 }
    const shift = translation(5, 5)
    expect(applyAffine(composeAffine(shift, scale), { x: 1, y: 1 })).not.toEqual(
      applyAffine(composeAffine(scale, shift), { x: 1, y: 1 }),
    )
  })

  it('composing with the identity changes nothing', () => {
    const some = { a: 1.2, b: 0.3, c: -0.2, d: 0.9, tx: 4, ty: -7 }
    expect(composeAffine(some, IDENTITY)).toEqual(some)
    expect(composeAffine(IDENTITY, some)).toEqual(some)
  })

  it('accumulates a run of small motions, as frame-to-frame camera motion does', () => {
    let cumulative = IDENTITY
    for (let step = 0; step < 10; step += 1) cumulative = composeAffine(translation(3, -1), cumulative)
    expect(applyAffine(cumulative, { x: 0, y: 0 })).toEqual({ x: 30, y: -10 })
  })
})

describe('invertAffine', () => {
  it.each([
    ['a translation', translation(17, -9)],
    ['a rotation', rotation(0.4)],
    ['a rotation with scale and shift', { a: 1.1, b: -0.2, c: 0.2, d: 1.1, tx: 8, ty: 3 }],
  ])('round-trips %s', (_label, transform) => {
    const inverse = invertAffine(transform)!
    const point = { x: 123, y: -45 }
    const there = applyAffine(transform, point)
    const back = applyAffine(inverse, there)
    expect(back.x).toBeCloseTo(point.x, 9)
    expect(back.y).toBeCloseTo(point.y, 9)
  })

  it('returns null for a transform that collapses the plane', () => {
    expect(invertAffine({ a: 1, b: 2, c: 2, d: 4, tx: 0, ty: 0 })).toBeNull()
  })
})

describe('linearPart', () => {
  /** A pan moves where the disc appears, not how fast it is travelling. */
  it('drops the translation so velocities are not shifted', () => {
    const transform = { a: 1.1, b: -0.2, c: 0.2, d: 1.1, tx: 50, ty: -30 }
    const velocity = { x: 10, y: 0 }
    const moved = applyAffine(linearPart(transform), velocity)
    expect(moved).toEqual(applyAffine({ ...transform, tx: 0, ty: 0 }, velocity))
    expect(moved.x).toBeLessThan(20)
  })
})

describe('displacementAt', () => {
  it('measures how far a point is moved', () => {
    expect(displacementAt(translation(3, 4), { x: 0, y: 0 })).toBeCloseTo(5, 9)
    expect(displacementAt(IDENTITY, { x: 100, y: 100 })).toBe(0)
  })
})
