import type { Point } from './pointer.ts'

/**
 * 2x3 affine transforms, for carrying camera motion between frames.
 *
 * Maps (x, y) to (a*x + b*y + tx, c*x + d*y + ty). Enough to express the pan,
 * rotation and zoom a handheld camera produces, which is exactly what
 * `estimateAffinePartial2D` recovers.
 */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

export function applyAffine(transform: Affine, point: Point): Point {
  return {
    x: transform.a * point.x + transform.b * point.y + transform.tx,
    y: transform.c * point.x + transform.d * point.y + transform.ty,
  }
}

/** Applies `inner` first, then `outer`. */
export function composeAffine(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.b * inner.c,
    b: outer.a * inner.b + outer.b * inner.d,
    c: outer.c * inner.a + outer.d * inner.c,
    d: outer.c * inner.b + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.b * inner.ty + outer.tx,
    ty: outer.c * inner.tx + outer.d * inner.ty + outer.ty,
  }
}

/** Null when the transform collapses the plane and cannot be undone. */
export function invertAffine(transform: Affine): Affine | null {
  const determinant = transform.a * transform.d - transform.b * transform.c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null

  const a = transform.d / determinant
  const b = -transform.b / determinant
  const c = -transform.c / determinant
  const d = transform.a / determinant
  return {
    a,
    b,
    c,
    d,
    tx: -(a * transform.tx + b * transform.ty),
    ty: -(c * transform.tx + d * transform.ty),
  }
}

/**
 * The linear part alone, with translation dropped.
 *
 * Velocities rotate and scale with the camera but must not be shifted by it: a
 * pan moves where the disc appears, not how fast it is going.
 */
export function linearPart(transform: Affine): Affine {
  return { ...transform, tx: 0, ty: 0 }
}

/** How far this transform moves the given point — a rough magnitude for logging and tests. */
export function displacementAt(transform: Affine, point: Point): number {
  const moved = applyAffine(transform, point)
  return Math.hypot(moved.x - point.x, moved.y - point.y)
}
