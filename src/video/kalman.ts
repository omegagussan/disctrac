import { DEFAULT_FPS } from './frames.ts'
import type { Point } from './pointer.ts'

/**
 * A 4-state Kalman filter for a disc in flight: position and velocity in the
 * image plane, constant velocity with a drag term.
 *
 * Written by hand rather than using `cv.KalmanFilter`. OpenCV.js is already a
 * dependency, so this is not about size — it is that both customisations here
 * (drag in the transition matrix, and inflating the covariance mid-update when
 * the gate trips) mean reaching into matrix internals every frame, which is
 * awkward through a Mat-based API and slow to unit-test through WASM.
 *
 * See docs/adr_kalman_filter.md for the assumptions this rests on. The largest:
 * there is no acceleration term, so gravity is not modelled and all curvature
 * comes from measurements.
 */

/** Position in analysis-frame pixels, velocity in pixels per second. */
export interface DiscState {
  x: number
  y: number
  vx: number
  vy: number
}

export interface KalmanConfig {
  /** Seconds between frames. Uniform for a batch pass over decoded frames. */
  dt: number
  /** Velocity retained per frame. 1 is frictionless; below 1 brakes the disc. */
  drag: number
  /** Process noise on position, px^2. */
  positionNoise: number
  /** Process noise on velocity, (px/s)^2. Absorbs the unmodelled acceleration. */
  velocityNoise: number
  /** Measurement variance, px^2. */
  measurementNoise: number
  /** Mahalanobis d^2 above which a measurement is treated as a tree strike. */
  gateThreshold: number
  /** Covariance multiplier applied when the gate trips, raising the gain. */
  gateInflation: number
  /** Consecutive missed frames tolerated before the track is abandoned. */
  maxConsecutiveMisses: number
  /** Initial velocity variance, before any velocity has been observed. */
  initialVelocityVariance: number
}

export const DEFAULT_KALMAN_CONFIG: KalmanConfig = {
  dt: 1 / DEFAULT_FPS,
  drag: 0.995,
  positionNoise: 0.25,
  velocityNoise: 25,
  measurementNoise: 4,
  // chi-squared at 99% for 2 degrees of freedom.
  gateThreshold: 9.21,
  gateInflation: 100,
  maxConsecutiveMisses: 15,
  initialVelocityVariance: 1e4,
}

export interface Correction {
  /** False when the filter had no state to correct, or the measurement was unusable. */
  accepted: boolean
  /** True when the measurement was wildly inconsistent with the physics — a tree strike. */
  gated: boolean
  /** Squared Mahalanobis distance of the measurement from the prediction. */
  mahalanobis: number
  /** Measurement minus prediction, in pixels. */
  innovation: Point
}

export interface KalmanFilter {
  /** Advance the state one frame and return the predicted position. */
  predict(): DiscState
  /** Fold in a measurement. Initialises the filter if it has no state yet. */
  correct(measurement: Point): Correction
  /** Record a frame with no usable measurement. */
  miss(): void
  readonly state: DiscState | null
  readonly missStreak: number
  /** True once the miss streak exceeds the configured tolerance. */
  readonly isLost: boolean
  /** Position variance trace, for callers that want to widen a search radius. */
  readonly positionVariance: number
}

type Matrix = number[][]

const matMul = (a: Matrix, b: Matrix): Matrix =>
  a.map((row) => b[0].map((_, col) => row.reduce((sum, v, k) => sum + v * b[k][col], 0)))

const transpose = (m: Matrix): Matrix => m[0].map((_, col) => m.map((row) => row[col]))

const matVec = (m: Matrix, v: number[]): number[] =>
  m.map((row) => row.reduce((sum, value, k) => sum + value * v[k], 0))

const identity = (n: number): Matrix =>
  Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))

/** Closed-form 2x2 inverse. Null when singular, which callers treat as an unusable measurement. */
export function invert2x2(m: Matrix): Matrix | null {
  const determinant = m[0][0] * m[1][1] - m[0][1] * m[1][0]
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null
  return [
    [m[1][1] / determinant, -m[0][1] / determinant],
    [-m[1][0] / determinant, m[0][0] / determinant],
  ]
}

export function createKalmanFilter(config: KalmanConfig = DEFAULT_KALMAN_CONFIG): KalmanFilter {
  const { dt, drag } = config

  // Position advances by velocity; velocity decays by the drag factor.
  const F: Matrix = [
    [1, 0, dt, 0],
    [0, 1, 0, dt],
    [0, 0, drag, 0],
    [0, 0, 0, drag],
  ]
  // The detector sees position only; velocity is inferred, never observed.
  const H: Matrix = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ]
  const Ht = transpose(H)
  const Ft = transpose(F)
  const Q: Matrix = [
    [config.positionNoise, 0, 0, 0],
    [0, config.positionNoise, 0, 0],
    [0, 0, config.velocityNoise, 0],
    [0, 0, 0, config.velocityNoise],
  ]
  const I4 = identity(4)

  let x: number[] | null = null
  let P: Matrix = identity(4)
  let missStreak = 0

  const asState = (): DiscState | null =>
    x ? { x: x[0], y: x[1], vx: x[2], vy: x[3] } : null

  const initialise = (measurement: Point) => {
    x = [measurement.x, measurement.y, 0, 0]
    P = [
      [config.measurementNoise, 0, 0, 0],
      [0, config.measurementNoise, 0, 0],
      // Velocity is entirely unknown at this point, so say so loudly; the first
      // few measurements then move it freely instead of being dragged toward 0.
      [0, 0, config.initialVelocityVariance, 0],
      [0, 0, 0, config.initialVelocityVariance],
    ]
    missStreak = 0
  }

  return {
    predict() {
      if (!x) return { x: 0, y: 0, vx: 0, vy: 0 }
      x = matVec(F, x)
      P = matMul(matMul(F, P), Ft).map((row, i) => row.map((value, j) => value + Q[i][j]))
      return asState()!
    },

    correct(measurement: Point): Correction {
      if (!x) {
        initialise(measurement)
        return {
          accepted: true,
          gated: false,
          mahalanobis: 0,
          innovation: { x: 0, y: 0 },
        }
      }

      const innovation = { x: measurement.x - x[0], y: measurement.y - x[1] }
      const residual = [innovation.x, innovation.y]

      const covariance = (): Matrix => [
        [P[0][0] + config.measurementNoise, P[0][1]],
        [P[1][0], P[1][1] + config.measurementNoise],
      ]

      let S = covariance()
      let Sinv = invert2x2(S)
      if (!Sinv) {
        return { accepted: false, gated: false, mahalanobis: Number.POSITIVE_INFINITY, innovation }
      }

      const distanceOf = (inverse: Matrix) =>
        residual.reduce(
          (sum, value, i) => sum + value * (inverse[i][0] * residual[0] + inverse[i][1] * residual[1]),
          0,
        )
      const mahalanobis = distanceOf(Sinv)

      // A measurement this far from the prediction is not noise — it is the disc
      // having done something the physics model cannot express, i.e. hit a tree.
      // Inflating P raises the gain so the state follows the measurement instead
      // of gliding past it. Note this drives the gain *toward* 1, not to 1.
      const gated = mahalanobis > config.gateThreshold
      if (gated) {
        P = P.map((row) => row.map((value) => value * config.gateInflation))
        S = covariance()
        const inflated = invert2x2(S)
        if (!inflated) {
          return { accepted: false, gated: true, mahalanobis, innovation }
        }
        Sinv = inflated
      }

      const K = matMul(matMul(P, Ht), Sinv)
      x = x.map((value, i) => value + (K[i][0] * residual[0] + K[i][1] * residual[1]))
      P = matMul(
        I4.map((row, i) => row.map((value, j) => value - (K[i][0] * H[0][j] + K[i][1] * H[1][j]))),
        P,
      )
      missStreak = 0

      return { accepted: true, gated, mahalanobis, innovation }
    },

    miss() {
      missStreak += 1
    },

    get state() {
      return asState()
    },
    get missStreak() {
      return missStreak
    },
    get isLost() {
      return missStreak > config.maxConsecutiveMisses
    },
    get positionVariance() {
      return x ? P[0][0] + P[1][1] : Number.POSITIVE_INFINITY
    },
  }
}
