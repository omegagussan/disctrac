import { DEFAULT_KALMAN_CONFIG, createKalmanFilter } from './kalman.ts'
import type { KalmanConfig, KalmanFilter } from './kalman.ts'
import type { Point } from './pointer.ts'

/**
 * Sequencing one frame of tracking: predict, associate, gate, correct or coast.
 *
 * Kept free of image processing so it can be tested with injected candidates.
 * The OpenCV pipeline's only job is to turn pixels into `Candidate`s; everything
 * about *which* candidate is the disc, and what to do when there isn't one,
 * lives here.
 */

/** A blob the detector considers a possible disc, in analysis-frame pixels. */
export interface Candidate {
  x: number
  y: number
  /** Contour area in pixels. */
  area: number
  /** Radius of a circle with the same area. */
  radius: number
}

export interface TrackPoint {
  frameIndex: number
  timestampUs: number
  /** Where the detector found the disc, or null if it didn't. */
  measured: Point | null
  /** The filtered estimate — what the trace is drawn from. */
  filtered: Point
  radius: number | null
  /** True when no candidate was accepted this frame and the filter coasted. */
  occluded: boolean
  /** True when the measurement was inconsistent enough to look like a tree strike. */
  gated: boolean
  mahalanobis: number
  /** True once the miss streak has run past the tolerance and the track was dropped. */
  lost: boolean
}

export interface TrackerSeed {
  /** Timestamp of the frame the disc was identified on. */
  timestampUs: number
  x: number
  y: number
}

export interface TrackerOptions {
  kalman?: Partial<KalmanConfig>
  /**
   * Where the disc is known to be, and when.
   *
   * Without this the first frame has no prediction, so association falls back to
   * the largest blob — and on real footage the disc is almost never the largest
   * thing matching its colour. Measured on the throw-02 fixture, the disc runs
   * from 783 px down to 23 px as it flies away while shirt and sunlit grass stay
   * in the thousands, so largest-wins starts the track on the wrong object every
   * time and never recovers. A seed removes the guess entirely: the user already
   * pointed at the disc when picking its colours.
   */
  seed?: TrackerSeed
  /** Contours smaller than this are compression noise, not a disc. */
  minArea?: number
  /**
   * Candidates further than this from the prediction are ignored entirely.
   * Unset means distance never disqualifies a candidate — only ranks it.
   */
  maxAssociationDistance?: number
}

export const DEFAULT_MIN_AREA = 12

/**
 * Pick the disc from the frame's candidates.
 *
 * With a prediction in hand, **nearest wins**; without one, largest does. Taking
 * the largest blob unconditionally is what lets a bright shirt or a patch of sky
 * capture the track mid-flight, since either can out-area a small distant disc.
 */
export function chooseCandidate(
  candidates: Candidate[],
  options: { minArea: number; prediction?: Point | null; maxDistance?: number },
): Candidate | null {
  const plausible = candidates.filter((candidate) => candidate.area >= options.minArea)
  if (plausible.length === 0) return null

  const { prediction, maxDistance } = options
  if (!prediction) {
    return plausible.reduce((best, candidate) => (candidate.area > best.area ? candidate : best))
  }

  const distanceTo = (candidate: Candidate) =>
    Math.hypot(candidate.x - prediction.x, candidate.y - prediction.y)

  const reachable =
    maxDistance === undefined
      ? plausible
      : plausible.filter((candidate) => distanceTo(candidate) <= maxDistance)
  if (reachable.length === 0) return null

  return reachable.reduce((best, candidate) =>
    distanceTo(candidate) < distanceTo(best) ? candidate : best,
  )
}

export interface Tracker {
  /** Feed one frame's candidates and get the resulting track point. */
  process(frameIndex: number, timestampUs: number, candidates: Candidate[]): TrackPoint
  readonly points: TrackPoint[]
}

export function createTracker(options: TrackerOptions = {}): Tracker {
  const kalmanConfig: KalmanConfig = { ...DEFAULT_KALMAN_CONFIG, ...options.kalman }
  const minArea = options.minArea ?? DEFAULT_MIN_AREA

  let filter: KalmanFilter = createKalmanFilter(kalmanConfig)
  const points: TrackPoint[] = []
  const seed = options.seed
  let seeded = false

  return {
    process(frameIndex, timestampUs, candidates) {
      // A track that has been lost is not worth extrapolating from; the next
      // candidate starts a fresh one rather than being dragged toward a stale
      // position the disc left long ago.
      if (filter.isLost) {
        filter = createKalmanFilter(kalmanConfig)
      }

      // Nothing is tracked before the disc has been identified; extrapolating
      // backwards from a seed would be inventing history.
      if (seed && !seeded && timestampUs < seed.timestampUs) {
        const point: TrackPoint = {
          frameIndex,
          timestampUs,
          measured: null,
          filtered: { x: 0, y: 0 },
          radius: null,
          occluded: true,
          gated: false,
          mahalanobis: 0,
          lost: true,
        }
        points.push(point)
        return point
      }

      if (seed && !seeded) {
        filter.correct({ x: seed.x, y: seed.y })
        seeded = true
      }

      const prediction = filter.state ? filter.predict() : null
      const chosen = chooseCandidate(candidates, {
        minArea,
        prediction,
        maxDistance: options.maxAssociationDistance,
      })

      let gated = false
      let mahalanobis = 0
      if (chosen) {
        const correction = filter.correct(chosen)
        gated = correction.gated
        mahalanobis = correction.mahalanobis
      } else {
        filter.miss()
      }

      const state = filter.state
      const point: TrackPoint = {
        frameIndex,
        timestampUs,
        measured: chosen ? { x: chosen.x, y: chosen.y } : null,
        // With no state and no candidate there is nothing to report but the
        // origin; callers filter on `lost` rather than trusting the position.
        filtered: state ? { x: state.x, y: state.y } : { x: 0, y: 0 },
        radius: chosen ? chosen.radius : null,
        occluded: chosen === null,
        gated,
        mahalanobis,
        lost: filter.isLost || state === null,
      }
      points.push(point)
      return point
    },

    get points() {
      return points
    },
  }
}

/** Points worth drawing: the filter had a real estimate for them. */
export function drawablePoints(points: TrackPoint[]): TrackPoint[] {
  return points.filter((point) => !point.lost)
}
