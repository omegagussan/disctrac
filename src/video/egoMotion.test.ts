import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { displacementAt } from './affine.ts'
import { createEgoMotionEstimator } from './egoMotion.ts'
import type { FramePixels } from './floodFill.ts'
import { loadFixtureFrame, loadTruth } from './fixtureFrames.ts'
import type { OpenCv } from './opencv.ts'

let cv: OpenCv
const truth = loadTruth('fixtures/truth/throw-02-field-release.json')
const frameFor = (n: number) => loadFixtureFrame(`${truth.frameDirectory}/frame-${n}.png`)

beforeAll(async () => {
  const nodeRequire = createRequire(import.meta.url)
  cv = await Promise.resolve(nodeRequire('@techstark/opencv-js') as PromiseLike<OpenCv>)
}, 120_000)

/**
 * Shift a frame's content by a known amount, replicating the edge pixels.
 * Filling with black instead would plant a hard edge for the corner detector to
 * latch onto, and the test would be measuring that artefact.
 */
function shiftFrame(frame: FramePixels, dx: number, dy: number): FramePixels {
  const data = new Uint8ClampedArray(frame.width * frame.height * 4)
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const sourceX = Math.min(frame.width - 1, Math.max(0, x - dx))
      const sourceY = Math.min(frame.height - 1, Math.max(0, y - dy))
      const from = (sourceY * frame.width + sourceX) * 4
      const to = (y * frame.width + x) * 4
      data[to] = frame.data[from]
      data[to + 1] = frame.data[from + 1]
      data[to + 2] = frame.data[from + 2]
      data[to + 3] = 255
    }
  }
  return { width: frame.width, height: frame.height, data }
}

describe('createEgoMotionEstimator', () => {
  it('reports no motion on the first frame, having nothing to compare with', () => {
    const estimator = createEgoMotionEstimator(cv)
    try {
      const first = estimator.estimate(frameFor(240))
      expect(first.ok).toBe(false)
      expect(first.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })
    } finally {
      estimator.dispose()
    }
  })

  it('finds no motion between a frame and itself', () => {
    const estimator = createEgoMotionEstimator(cv)
    try {
      const frame = frameFor(240)
      estimator.estimate(frame)
      const still = estimator.estimate(frame)

      expect(still.ok).toBe(true)
      expect(Math.abs(still.transform.tx)).toBeLessThan(0.5)
      expect(Math.abs(still.transform.ty)).toBeLessThan(0.5)
    } finally {
      estimator.dispose()
    }
  })

  /** The ground truth here is exact, because the shift is applied deliberately. */
  it.each([
    { dx: 12, dy: 0 },
    { dx: -18, dy: 0 },
    { dx: 0, dy: 9 },
    { dx: -14, dy: 7 },
  ])('recovers a known shift of ($dx, $dy)', ({ dx, dy }) => {
    const estimator = createEgoMotionEstimator(cv)
    try {
      const frame = frameFor(240)
      estimator.estimate(frame)
      const moved = estimator.estimate(shiftFrame(frame, dx, dy))

      expect(moved.ok).toBe(true)
      expect(moved.transform.tx).toBeCloseTo(dx, 0)
      expect(moved.transform.ty).toBeCloseTo(dy, 0)
      // A pure translation: no rotation or scale should be invented.
      expect(moved.transform.a).toBeCloseTo(1, 1)
      expect(moved.transform.b).toBeCloseTo(0, 1)
    } finally {
      estimator.dispose()
    }
  })

  it('keeps enough inliers to be trusted', () => {
    const estimator = createEgoMotionEstimator(cv)
    try {
      const frame = frameFor(240)
      estimator.estimate(frame)
      expect(estimator.estimate(shiftFrame(frame, 10, -5)).inliers).toBeGreaterThan(20)
    } finally {
      estimator.dispose()
    }
  })

  /**
   * The real thing. The camera pans left through this stretch, so background
   * content travels right: a positive x translation, frame after frame.
   *
   * The magnitudes are cross-checked against an independent method — aligning
   * column-brightness profiles between consecutive frames, which needs no
   * feature tracking at all — and that puts the motion at 23-35px per frame
   * across this range.
   */
  it('measures the pan on real consecutive frames', () => {
    const estimator = createEgoMotionEstimator(cv)
    try {
      const centre = { x: truth.frameWidth / 2, y: truth.frameHeight / 2 }
      const shifts: number[] = []
      for (let frame = 234; frame <= 250; frame += 1) {
        const motion = estimator.estimate(frameFor(frame))
        if (motion.ok) shifts.push(motion.transform.tx)
      }

      expect(shifts.length).toBeGreaterThan(10)
      // Overwhelmingly one direction, not noise about zero.
      const rightward = shifts.filter((tx) => tx > 0).length
      expect(rightward).toBeGreaterThan(shifts.length * 0.8)

      // And of the right size: an independent profile alignment measures 23-35px
      // per frame here, so anything outside this band is a broken estimate
      // rather than a differently-tuned one.
      const median = [...shifts].sort((first, second) => first - second)[Math.floor(shifts.length / 2)]
      expect(median).toBeGreaterThan(15)
      expect(median).toBeLessThan(50)

      const estimator2 = createEgoMotionEstimator(cv)
      try {
        estimator2.estimate(frameFor(234))
        const step = estimator2.estimate(frameFor(235))
        // The whip right after release is substantial, not sub-pixel drift.
        expect(displacementAt(step.transform, centre)).toBeGreaterThan(5)
      } finally {
        estimator2.dispose()
      }
    } finally {
      estimator.dispose()
    }
  })

  it('tolerates being disposed twice', () => {
    const estimator = createEgoMotionEstimator(cv)
    estimator.dispose()
    expect(() => estimator.dispose()).not.toThrow()
  })
})
