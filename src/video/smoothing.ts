import type { Point } from './pointer.ts'

/**
 * Smoothing a flight path.
 *
 * A disc's path is smooth. It can wobble a little in wind, but it cannot jink:
 * any sharp kink in a tracked path is measurement noise — a centroid shifting as
 * motion blur changes the blob's shape, or the association picking a slightly
 * different pixel cluster. Drawing the raw polyline draws that noise.
 *
 * Two choices worth knowing about:
 *
 * The fit is **parametric in time** — x(t) and y(t) fitted separately — not
 * y as a function of x. With the camera panning, the path doubles back on
 * itself horizontally, and y = f(x) cannot represent that at all.
 *
 * The fit is **local**, over a sliding window, rather than one polynomial across
 * the whole flight. A single global cubic imposes a shape: where the real path
 * disagrees, the drawn line leaves the disc entirely. A local fit removes the
 * jitter while staying on the data.
 */

export interface SmoothingOptions {
  /** Polynomial degree fitted within each window. 2 follows curvature; 1 is a moving line. */
  degree?: number
  /** Number of samples per fit. Forced odd so the window is centred. */
  window?: number
}

export const DEFAULT_SMOOTHING: Required<SmoothingOptions> = {
  degree: 2,
  // ~0.3s at 30fps: long enough to average out centroid jitter, short enough
  // that a real turn in the flight survives.
  window: 9,
}

/**
 * Least-squares polynomial fit, returning coefficients lowest-order first.
 *
 * Solved through the normal equations. That is ill-conditioned for high degrees
 * or large abscissae, which is exactly why callers here pass small centred
 * offsets and degree 2 or 3.
 */
export function fitPolynomial(xs: number[], ys: number[], degree: number): number[] {
  const terms = degree + 1
  // Moments up to 2*degree: sum of x^k. Building these is cheaper than forming
  // the full design matrix and multiplying it out.
  const moments = new Array<number>(2 * degree + 1).fill(0)
  const targets = new Array<number>(terms).fill(0)

  for (let index = 0; index < xs.length; index += 1) {
    let power = 1
    for (let k = 0; k <= 2 * degree; k += 1) {
      moments[k] += power
      if (k < terms) targets[k] += ys[index] * power
      power *= xs[index]
    }
  }

  const matrix: number[][] = []
  for (let row = 0; row < terms; row += 1) {
    matrix.push(Array.from({ length: terms }, (_, col) => moments[row + col]))
  }

  return solve(matrix, targets)
}

/** Gaussian elimination with partial pivoting. Returns zeros for a singular system. */
function solve(matrix: number[][], targets: number[]): number[] {
  const size = targets.length
  const augmented = matrix.map((row, index) => [...row, targets[index]])

  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) return new Array<number>(size).fill(0)
    ;[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = augmented[row][column] / augmented[column][column]
      for (let col = column; col <= size; col += 1) {
        augmented[row][col] -= factor * augmented[column][col]
      }
    }
  }

  return augmented.map((row, index) => row[size] / row[index])
}

export function evaluatePolynomial(coefficients: number[], x: number): number {
  let result = 0
  let power = 1
  for (const coefficient of coefficients) {
    result += coefficient * power
    power *= x
  }
  return result
}

/**
 * Smooth a path sampled at even intervals.
 *
 * Sample index stands in for time, which is exact for consecutive frames and
 * keeps the fit well conditioned — offsets are small integers centred on zero
 * rather than microsecond timestamps.
 */
export function smoothPath(points: Point[], options: SmoothingOptions = {}): Point[] {
  const degree = options.degree ?? DEFAULT_SMOOTHING.degree
  const requested = options.window ?? DEFAULT_SMOOTHING.window
  // An even window has no centre sample to evaluate at.
  const window = requested % 2 === 0 ? requested + 1 : requested

  // With no more samples than the polynomial has freedom, the fit passes through
  // every point and smooths nothing.
  if (points.length <= degree + 1 || window <= degree + 1) return points

  const half = (window - 1) / 2
  return points.map((point, index) => {
    const lower = Math.max(0, index - half)
    const upper = Math.min(points.length - 1, index + half)
    const count = upper - lower + 1
    const localDegree = Math.min(degree, count - 1)
    if (count <= localDegree + 1) return point

    const offsets: number[] = []
    const xs: number[] = []
    const ys: number[] = []
    for (let at = lower; at <= upper; at += 1) {
      offsets.push(at - index)
      xs.push(points[at].x)
      ys.push(points[at].y)
    }

    // Offsets are centred on this sample, so evaluating at 0 is just the
    // constant term — but going through evaluate keeps the intent obvious.
    return {
      x: evaluatePolynomial(fitPolynomial(offsets, xs, localDegree), 0),
      y: evaluatePolynomial(fitPolynomial(offsets, ys, localDegree), 0),
    }
  })
}
