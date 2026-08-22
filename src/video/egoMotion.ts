import type { Mat } from '@techstark/opencv-js'
import type { Affine } from './affine.ts'
import { IDENTITY } from './affine.ts'
import type { FramePixels } from './floodFill.ts'
import type { OpenCv } from './opencv.ts'

/**
 * Estimating how the camera moved between frames.
 *
 * The disc's apparent motion is its own motion plus the camera's. On a follow
 * pan the camera's part dominates — the fixture's tracked x runs 380 to 268 and
 * back to 444 while the disc only ever flies one way — so a motion model applied
 * to raw screen coordinates is modelling the operator's arms.
 *
 * Sparse rather than dense flow: a few hundred corners tracked with pyramidal
 * Lucas-Kanade is enough to recover a global transform, where computing flow for
 * every pixel would cost orders of magnitude more for no extra information.
 * RANSAC then fits the transform, which matters because the frame contains
 * moving foreground — the disc, the player — that must be rejected as outliers
 * rather than averaged in.
 *
 * Two pieces are hand-rolled because this OpenCV build does not ship them, even
 * though its TypeScript declarations do: `goodFeaturesToTrack` (reimplemented
 * below on `cornerMinEigenVal`, which is what it uses internally) and
 * `estimateAffinePartial2D` (substituted with `estimateAffine2D`). The latter
 * costs a little rigour — 6 degrees of freedom where a camera only has 4, so it
 * can express a shear no lens produces — but RANSAC over a few hundred
 * background corners does not have the freedom to exploit that in practice.
 */

export interface EgoMotionOptions {
  /** Corners tracked at once. */
  maxFeatures?: number
  /** Re-detect corners when fewer than this survive. */
  minFeatures?: number
  qualityLevel?: number
  minDistance?: number
  /** Lucas-Kanade search window. Smaller is faster but loses fast motion. */
  winSize?: number
  /** Pyramid levels. More survives larger jumps between frames. */
  maxLevel?: number
  /** Frames are scaled by this before tracking; camera motion is global and needs no detail. */
  scale?: number
  ransacThreshold?: number
}

const DEFAULTS: Required<EgoMotionOptions> = {
  maxFeatures: 200,
  minFeatures: 40,
  qualityLevel: 0.01,
  minDistance: 8,
  winSize: 15,
  maxLevel: 2,
  scale: 0.5,
  ransacThreshold: 3,
}

/**
 * One tracked corner's movement between frames, for inspection.
 *
 * Position is where the corner sat in the previous frame; the delta is how far
 * it moved. `inlier` says whether RANSAC accepted it as background — the useful
 * signal when judging an estimate by eye, since a working fit shows the
 * background moving as one and the disc and player rejected.
 */
export interface FlowSample {
  x: number
  y: number
  dx: number
  dy: number
  inlier: boolean
}

export interface EgoMotion {
  /** Where a point in the previous frame appears in this one. */
  transform: Affine
  /** Corners that survived tracking and RANSAC. Low means an untrustworthy estimate. */
  inliers: number
  /** Every tracked corner, in the units of the frames given to the estimator. */
  samples: FlowSample[]
  /** False when the estimate fell back to the identity. */
  ok: boolean
}

/** A single-channel image. Small: camera motion is global and needs no detail. */
export interface GreyFrame {
  width: number
  height: number
  data: Uint8Array
}

/**
 * Greyscale and downscale in one pass.
 *
 * Done here rather than through OpenCV so a caller can prepare frames while
 * decoding and keep only these — a 320x180 grey frame is 58KB against 920KB of
 * RGBA, which is the difference between buffering a whole clip and not.
 */
export function toGreyscale(frame: FramePixels, scale = 1): GreyFrame {
  const width = Math.max(1, Math.round(frame.width * scale))
  const height = Math.max(1, Math.round(frame.height * scale))
  const data = new Uint8Array(width * height)
  const blockX = frame.width / width
  const blockY = frame.height / height

  for (let y = 0; y < height; y += 1) {
    const fromY = Math.floor(y * blockY)
    const toY = Math.min(frame.height, Math.max(fromY + 1, Math.floor((y + 1) * blockY)))
    for (let x = 0; x < width; x += 1) {
      const fromX = Math.floor(x * blockX)
      const toX = Math.min(frame.width, Math.max(fromX + 1, Math.floor((x + 1) * blockX)))
      let total = 0
      let count = 0
      for (let sy = fromY; sy < toY; sy += 1) {
        for (let sx = fromX; sx < toX; sx += 1) {
          const at = (sy * frame.width + sx) * 4
          total += frame.data[at] * 0.299 + frame.data[at + 1] * 0.587 + frame.data[at + 2] * 0.114
          count += 1
        }
      }
      data[y * width + x] = total / count
    }
  }

  return { width, height, data }
}

export interface EgoMotionEstimator {
  /** Motion between greyscale frames, with translation in *their* pixels. */
  estimateGrey(grey: GreyFrame): EgoMotion
  /** Motion between full frames, with translation in frame pixels. */
  estimate(frame: FramePixels): EgoMotion
  dispose(): void
}

export function createEgoMotionEstimator(
  cv: OpenCv,
  options: EgoMotionOptions = {},
): EgoMotionEstimator {
  const settings = { ...DEFAULTS, ...options }

  let previous: Mat | null = null
  let previousPoints: Mat | null = null

  const release = () => {
    previous?.delete()
    previousPoints?.delete()
    previous = null
    previousPoints = null
  }

  const toMat = (grey: GreyFrame): Mat => {
    const mat = new cv.Mat(grey.height, grey.width, cv.CV_8UC1)
    mat.data.set(grey.data)
    return mat
  }

  /**
   * Stand-in for `goodFeaturesToTrack`, which this build omits.
   *
   * Same recipe: score every pixel by the smaller eigenvalue of its structure
   * tensor, keep those above a fraction of the best score, then take the
   * strongest while enforcing a minimum spacing so the corners are spread over
   * the frame rather than clustered on one high-contrast edge.
   */
  const detectCorners = (image: Mat): Mat => {
    const response = new cv.Mat()
    try {
      cv.cornerMinEigenVal(image, response, 3, 3)

      const scores = response.data32F
      let strongest = 0
      for (let index = 0; index < scores.length; index += 1) {
        if (scores[index] > strongest) strongest = scores[index]
      }
      if (strongest <= 0) return cv.matFromArray(0, 1, cv.CV_32FC2, [])

      const floor = strongest * settings.qualityLevel
      const candidates: { x: number; y: number; score: number }[] = []
      const width = response.cols
      // The border is where the eigenvalue filter runs out of neighbourhood.
      for (let y = 3; y < response.rows - 3; y += 1) {
        for (let x = 3; x < width - 3; x += 1) {
          const score = scores[y * width + x]
          if (score >= floor) candidates.push({ x, y, score })
        }
      }
      candidates.sort((first, second) => second.score - first.score)

      // Spatial suppression through a grid keyed on the spacing, so accepting a
      // corner is a handful of bucket lookups rather than a scan of everything
      // accepted so far.
      const spacing = Math.max(1, settings.minDistance)
      const taken = new Map<string, { x: number; y: number }[]>()
      const chosen: number[] = []
      for (const candidate of candidates) {
        if (chosen.length >= settings.maxFeatures * 2) break
        const gx = Math.floor(candidate.x / spacing)
        const gy = Math.floor(candidate.y / spacing)
        let crowded = false
        for (let dy = -1; dy <= 1 && !crowded; dy += 1) {
          for (let dx = -1; dx <= 1 && !crowded; dx += 1) {
            for (const near of taken.get(`${gx + dx},${gy + dy}`) ?? []) {
              if (Math.hypot(near.x - candidate.x, near.y - candidate.y) < spacing) crowded = true
            }
          }
        }
        if (crowded) continue
        const key = `${gx},${gy}`
        taken.set(key, [...(taken.get(key) ?? []), candidate])
        chosen.push(candidate.x, candidate.y)
      }

      const count = Math.min(settings.maxFeatures, chosen.length / 2)
      return cv.matFromArray(count, 1, cv.CV_32FC2, chosen.slice(0, count * 2))
    } finally {
      response.delete()
    }
  }

  return {
    estimateGrey(grey): EgoMotion {
      const current = toMat(grey)

      // Nothing to compare against yet; seed the corners and report no motion.
      if (!previous || !previousPoints || previousPoints.rows < 6) {
        previous?.delete()
        previousPoints?.delete()
        previous = current
        previousPoints = detectCorners(current)
        return { transform: IDENTITY, inliers: 0, samples: [], ok: false }
      }

      const nextPoints = new cv.Mat()
      const status = new cv.Mat()
      const error = new cv.Mat()
      let result: EgoMotion = { transform: IDENTITY, inliers: 0, samples: [], ok: false }
      let survivors: Mat | null = null

      try {
        cv.calcOpticalFlowPyrLK(
          previous,
          current,
          previousPoints,
          nextPoints,
          status,
          error,
          new cv.Size(settings.winSize, settings.winSize),
          settings.maxLevel,
        )

        const fromValues: number[] = []
        const toValues: number[] = []
        for (let index = 0; index < status.rows; index += 1) {
          if (status.data[index] !== 1) continue
          fromValues.push(previousPoints.data32F[index * 2], previousPoints.data32F[index * 2 + 1])
          toValues.push(nextPoints.data32F[index * 2], nextPoints.data32F[index * 2 + 1])
        }

        const matched = fromValues.length / 2
        if (matched >= 6) {
          const from = cv.matFromArray(matched, 1, cv.CV_32FC2, fromValues)
          const to = cv.matFromArray(matched, 1, cv.CV_32FC2, toValues)
          const inlierMask = new cv.Mat()
          try {
            const estimated = cv.estimateAffine2D(
              from,
              to,
              inlierMask,
              cv.RANSAC,
              settings.ransacThreshold,
            ) as Mat

            if (estimated && !estimated.empty()) {
              let inliers = 0
              const samples: FlowSample[] = []
              for (let index = 0; index < matched; index += 1) {
                const inlier = inlierMask.rows > index && inlierMask.data[index] !== 0
                if (inlier) inliers += 1
                samples.push({
                  x: fromValues[index * 2],
                  y: fromValues[index * 2 + 1],
                  dx: toValues[index * 2] - fromValues[index * 2],
                  dy: toValues[index * 2 + 1] - fromValues[index * 2 + 1],
                  inlier,
                })
              }
              // The estimate was made at tracking scale. The linear part is
              // scale-free; the translation is not.
              result = {
                transform: {
                  a: estimated.doubleAt(0, 0),
                  b: estimated.doubleAt(0, 1),
                  tx: estimated.doubleAt(0, 2),
                  c: estimated.doubleAt(1, 0),
                  d: estimated.doubleAt(1, 1),
                  ty: estimated.doubleAt(1, 2),
                },
                inliers,
                samples,
                ok: true,
              }
            }
            estimated?.delete()
          } finally {
            from.delete()
            to.delete()
            inlierMask.delete()
          }

          // Carry the tracked corners forward so detection runs rarely.
          survivors = cv.matFromArray(matched, 1, cv.CV_32FC2, toValues)
        }
      } finally {
        nextPoints.delete()
        status.delete()
        error.delete()
      }

      previous.delete()
      previous = current
      previousPoints.delete()
      previousPoints =
        survivors && survivors.rows >= settings.minFeatures ? survivors : detectCorners(current)
      if (survivors && survivors !== previousPoints) survivors.delete()

      return result
    },

    estimate(frame): EgoMotion {
      const motion = this.estimateGrey(toGreyscale(frame, settings.scale))
      if (!motion.ok || settings.scale === 1) return motion
      // The estimate was made at tracking scale. The linear part is scale-free;
      // the translation is not.
      const up = 1 / settings.scale
      return {
        ...motion,
        transform: {
          ...motion.transform,
          tx: motion.transform.tx * up,
          ty: motion.transform.ty * up,
        },
        samples: motion.samples.map((sample) => ({
          x: sample.x * up,
          y: sample.y * up,
          dx: sample.dx * up,
          dy: sample.dy * up,
          inlier: sample.inlier,
        })),
      }
    },

    dispose: release,
  }
}
