import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDiscColorModel } from './discModel.ts'
import type { DiscColorModel } from './discModel.ts'
import { createDiscDetector } from './detectDisc.ts'
import type { DiscDetector } from './detectDisc.ts'
import type { FramePixels } from './floodFill.ts'
import { floodFillMask } from './floodFill.ts'
import { loadFixtureFrame, loadTruth } from './fixtureFrames.ts'
import type { TruthFrame } from './fixtureFrames.ts'
import { modelToHsvBounds } from './hsvBounds.ts'
import { HSV_METRIC } from './metric.ts'
import type { OpenCv } from './opencv.ts'
import type { Trace, TracePoint } from '../cv-protocol.ts'
import type { Affine } from './affine.ts'
import { IDENTITY, applyAffine, composeAffine, invertAffine } from './affine.ts'
import { createEgoMotionEstimator, toGreyscale } from './egoMotion.ts'
import { renderTrace } from './renderTrace.ts'
import { createTraceRecorder } from './traceRecorder.ts'
import { createTracker } from './tracker.ts'

/**
 * Detection measured against hand-annotated ground truth from the real fixture.
 *
 * Synthetic frames prove the pipeline runs; they cannot prove it works. This
 * clip is deliberately unkind — a bright yellow shirt beside an orange disc,
 * dry yellow grass behind, and a disc only a dozen pixels across in flight.
 *
 * See fixtures/truth/throw-02-field-release.json for how the positions were
 * obtained and how precise they are.
 */

let cv: OpenCv
const truth = loadTruth('fixtures/truth/throw-02-field-release.json')

const frameFor = (frame: number): FramePixels =>
  loadFixtureFrame(`${truth.frameDirectory}/frame-${frame}.png`)

/** Comfortably wider than the annotation's stated precision. */
const TOLERANCE_PX = 15

/** How far the filtered estimate may sit from truth, in analysis-frame pixels. */
const TRACK_TOLERANCE_PX = 25

const flightFrames = truth.frames.filter((entry) => entry.phase === 'flight')
const inHandFrames = truth.frames.filter((entry) => entry.phase === 'in-hand')

const distanceTo = (target: TruthFrame, point: { x: number; y: number }) =>
  Math.hypot(point.x - target.disc.x, point.y - target.disc.y)

beforeAll(async () => {
  const nodeRequire = createRequire(import.meta.url)
  cv = await Promise.resolve(nodeRequire('@techstark/opencv-js') as PromiseLike<OpenCv>)
}, 120_000)

/**
 * The model is built exactly as the app builds it: flood fill outward from the
 * point a user would click, then cluster the selected pixels.
 */
function modelFromClick(frame: FramePixels, at: { x: number; y: number }): DiscColorModel {
  const mask = floodFillMask(frame, at.x, at.y, HSV_METRIC.defaultTolerance, HSV_METRIC)
  return buildDiscColorModel(frame, mask)
}

describe('detecting the disc in real footage', () => {
  let detector: DiscDetector
  let model: DiscColorModel
  let ranges: ReturnType<typeof modelToHsvBounds>

  beforeAll(() => {
    // Frame 234 is where the disc is largest and clearest in flight — the frame
    // a user would naturally pick it on.
    const reference = flightFrames[0]
    model = modelFromClick(frameFor(reference.frame), reference.disc)
    ranges = modelToHsvBounds(model.modes, HSV_METRIC.defaultTolerance)
    // 2% of a 640x360 frame is ~4600px — far above a disc, far below a shirt.
    detector = createDiscDetector(cv, { minArea: 12, maxArea: truth.frameWidth * truth.frameHeight * 0.02 })
  })

  it('builds a plausible colour model from the click', () => {
    expect(model.modes.length).toBeGreaterThan(0)
    expect(model.pixelCount).toBeGreaterThan(20)
  })

  /**
   * While the disc is still in hand it sits right beside a shirt of almost the
   * same hue — the hardest case for colour alone, and where the old largest-blob
   * association went wrong first.
   */
  it('finds the disc even while it is held next to the shirt', () => {
    for (const entry of inHandFrames) {
      const { candidates } = detector.detect(frameFor(entry.frame), ranges)
      const nearest = Math.min(
        ...candidates.map((candidate) => distanceTo(entry, candidate)),
      )
      expect(nearest, `frame ${entry.frame}: nearest candidate ${nearest.toFixed(0)}px away`)
        .toBeLessThanOrEqual(TOLERANCE_PX)
    }
  })

  it('finds the disc on nearly every frame of the flight', () => {
    const misses: string[] = []
    for (const entry of flightFrames) {
      const { candidates } = detector.detect(frameFor(entry.frame), ranges)
      const nearest = candidates.reduce<{ distance: number } | null>((best, candidate) => {
        const distance = distanceTo(entry, candidate)
        return !best || distance < best.distance ? { distance } : best
      }, null)

      if (!nearest || nearest.distance > TOLERANCE_PX) {
        misses.push(
          `frame ${entry.frame}: ${candidates.length} candidates, nearest ${
            nearest ? nearest.distance.toFixed(1) : 'none'
          }px away`,
        )
      }
    }
    // Frame 266 is the exception and is expected: the disc has crossed onto dark
    // tree cover and shrunk to a couple of dozen pixels. Pinning the count stops
    // a regression hiding behind a vague "mostly works".
    expect(misses.length, `missed ${misses.length}/${flightFrames.length}:\n${misses.join('\n')}`)
      .toBeLessThanOrEqual(1)
  })

  /**
   * The bug behind the gibberish trace, pinned.
   *
   * Largest-blob-wins cannot start this track: the disc runs from 783px down to
   * 23px across the flight while shirt and sunlit grass stay in the thousands,
   * so the biggest match is never the disc. Seeding from the point the user
   * clicked removes the guess, and from there proximity carries the track.
   */
  const timestampFor = (frame: number) => (frame * 1001 * 1e6) / 30000

  const TRACKING_SCALE = 0.5

  /** Camera motion for every frame of the window, as the worker computes it. */
  function cameraMotion(): { toFrame: Affine[]; toWorld: Affine[] } {
    const window = truth.flightWindow
    const estimator = createEgoMotionEstimator(cv)
    const toFrame: Affine[] = []
    let cumulative: Affine = IDENTITY
    try {
      for (let frame = window.startFrame; frame <= window.endFrame; frame += 1) {
        const motion = estimator.estimateGrey(toGreyscale(frameFor(frame), TRACKING_SCALE))
        if (motion.ok) {
          cumulative = composeAffine(
            {
              ...motion.transform,
              tx: motion.transform.tx / TRACKING_SCALE,
              ty: motion.transform.ty / TRACKING_SCALE,
            },
            cumulative,
          )
        }
        toFrame.push(cumulative)
      }
    } finally {
      estimator.dispose()
    }
    return { toFrame, toWorld: toFrame.map((t) => invertAffine(t) ?? IDENTITY) }
  }

  /** Runs the real pipeline over the flight window and returns the trace. */
  function trackFlight(): Trace {
    const window = truth.flightWindow
    const dt = 1001 / 30000
    const seedFrame = flightFrames[0]
    const { toFrame, toWorld } = cameraMotion()
    const indexOf = (frame: number) => frame - window.startFrame

    const seedWorld = applyAffine(toWorld[indexOf(seedFrame.frame)], seedFrame.disc)

    const tracker = createTracker({
      minArea: 12,
      // A disc cannot cross 60px between consecutive frames at this scale, so a
      // candidate further out than that is a different object, not a jump.
      maxAssociationDistance: truth.frameWidth * 0.2,
      kalman: { dt },
      seed: {
        timestampUs: timestampFor(seedFrame.frame),
        x: seedWorld.x,
        y: seedWorld.y,
      },
    })

    // Every frame of the window is fed, as the app would. Sampling every fourth
    // frame would be unfair to the filter — the disc moves ~100px in that time,
    // so its first prediction would be a hundred pixels out.
    const points: TracePoint[] = []
    for (let frame = window.startFrame; frame <= window.endFrame; frame += 1) {
      const index = indexOf(frame)
      const detected = detector.detect(frameFor(frame), ranges)
      // Candidates arrive as screen positions; the tracker works with the camera
      // divided out.
      const candidates = detected.candidates.map((candidate) => {
        const world = applyAffine(toWorld[index], candidate)
        return { ...candidate, x: world.x, y: world.y }
      })
      const point = tracker.process(frame, timestampFor(frame), candidates)
      points.push({
        toFrame: toFrame[index],
        frameIndex: point.frameIndex,
        timestampUs: point.timestampUs,
        measured: point.measured,
        filtered: point.filtered,
        radius: point.radius,
        occluded: point.occluded,
        gated: point.gated,
        lost: point.lost,
      })
    }

    return {
      points,
      analysisWidth: truth.frameWidth,
      analysisHeight: truth.frameHeight,
      sourceWidth: 1280,
      sourceHeight: 720,
      dt,
      timings: { frames: points.length, readbackMs: 0, detectMs: 0, motionMs: 0, trackMs: 0, totalMs: 0 },
    }
  }

  /**
   * Why dividing out the camera matters, argued with the annotations alone —
   * no detector, no tracker.
   *
   * On screen the disc's horizontal motion reverses, because the operator pans
   * to follow it. Any curve fitted to that is fitting the camera. With the
   * camera removed the same annotated positions march steadily one way, which
   * is what a thrown disc does and what makes a fit meaningful.
   */
  it('turns a reversing screen path into a one-way flight', () => {
    const { toWorld } = cameraMotion()
    const indexOf = (frame: number) => frame - truth.flightWindow.startFrame

    const screenX = flightFrames.map((entry) => entry.disc.x)
    const worldX = flightFrames.map(
      (entry) => applyAffine(toWorld[indexOf(entry.frame)], entry.disc).x,
    )

    const reversals = (values: number[]) => {
      let count = 0
      for (let index = 2; index < values.length; index += 1) {
        const before = Math.sign(values[index - 1] - values[index - 2])
        const after = Math.sign(values[index] - values[index - 1])
        if (before !== 0 && after !== 0 && before !== after) count += 1
      }
      return count
    }

    expect(reversals(screenX)).toBeGreaterThan(0)
    expect(reversals(worldX)).toBe(0)

    // And strictly one way, frame after frame.
    for (let index = 1; index < worldX.length; index += 1) {
      expect(worldX[index]).toBeLessThan(worldX[index - 1])
    }

    // The camera was hiding most of the travel: on screen the disc appears to
    // move barely at all overall, while it actually crosses the best part of a
    // frame width.
    expect(Math.abs(screenX[screenX.length - 1] - screenX[0])).toBeLessThan(100)
    expect(Math.abs(worldX[worldX.length - 1] - worldX[0])).toBeGreaterThan(500)
  })

  it('follows the disc when the track is seeded from the click', () => {
    const trace = trackFlight()
    const byFrame = new Map(trace.points.map((point) => [point.frameIndex, point]))

    const errors: string[] = []
    for (const entry of flightFrames) {
      const point = byFrame.get(entry.frame)!
      // The estimate is in world coordinates; truth is a screen position.
      const onScreen = applyAffine(point.toFrame ?? IDENTITY, point.filtered)
      const distance = Math.hypot(onScreen.x - entry.disc.x, onScreen.y - entry.disc.y)
      if (distance > TRACK_TOLERANCE_PX) {
        errors.push(`frame ${entry.frame}: filtered ${distance.toFixed(0)}px from truth`)
      }
    }

    // Frame 266 is the known exception, and the same one detection misses: the
    // disc has crossed onto dark tree cover, so the filter coasts. Pinning the
    // count stops a regression hiding behind a vague "mostly works".
    expect(errors.length, `drifted on ${errors.length} frames:\n${errors.join('\n')}`)
      .toBeLessThanOrEqual(1)
  })

  /**
   * The last unverified link. Detection and tracking were measured against the
   * annotations, but whether the right thing reaches the screen was not — and
   * two of the three bugs in this feature lived in the drawing, not the maths.
   *
   * This runs the real pipeline, renders through the same code the component
   * uses, rasterises what was drawn, and checks that painted pixels actually sit
   * on the disc.
   */
  it('draws the path over the disc, at twice the analysis scale', () => {
    const trace = trackFlight()
    // Same aspect ratio as the analysis frame, at 2x — so a frame coordinate of
    // (x, y) must be painted at (2x, 2y).
    const element = { width: truth.frameWidth * 2, height: truth.frameHeight * 2 }

    const byFrame = new Map(trace.points.map((point) => [point.frameIndex, point]))
    // Two tolerances compose here: the track may sit TRACK_TOLERANCE_PX from
    // truth, and the element is twice the analysis frame. Demanding tighter than
    // that would be asking the drawing to be more accurate than what it draws.
    const allowed = TRACK_TOLERANCE_PX * 2

    const unpainted: string[] = []
    const misdrawn: string[] = []
    for (const entry of flightFrames) {
      const recorder = createTraceRecorder()
      renderTrace(recorder, {
        trace,
        element,
        currentTimeUs: timestampFor(entry.frame),
        showMarkers: true,
      })

      // End to end, with smoothing on as the app has it. This is also what
      // proves smoothing does not pull the line off the disc.
      const expected = { x: entry.disc.x * 2, y: entry.disc.y * 2 }
      if (!recorder.paintedNear(expected, allowed, element)) {
        unpainted.push(
          `frame ${entry.frame}: nothing painted within ${allowed}px of (${expected.x.toFixed(0)}, ${expected.y.toFixed(0)}); nearest line ${recorder.distanceToPath(expected).toFixed(0)}px away`,
        )
      }

      // Drawing fidelity on its own, with smoothing off: the line must pass
      // through exactly what the tracker reported, scaled. This isolates a
      // projection or timing error from both the tracker and the smoother.
      const raw = createTraceRecorder()
      renderTrace(raw, {
        trace,
        element,
        currentTimeUs: timestampFor(entry.frame),
        showMarkers: true,
        smoothing: null,
      })
      const tracked = byFrame.get(entry.frame)!
      const trackedOnScreen = applyAffine(tracked.toFrame ?? IDENTITY, tracked.filtered)
      const projected = { x: trackedOnScreen.x * 2, y: trackedOnScreen.y * 2 }
      const offBy = raw.distanceToPath(projected)
      if (offBy > 3) {
        misdrawn.push(`frame ${entry.frame}: line ${offBy.toFixed(1)}px from the tracked position`)
      }
    }

    expect(unpainted, `not drawn on the disc for ${unpainted.length} frames:\n${unpainted.join('\n')}`)
      .toEqual([])
    expect(misdrawn, `drawn away from the track on ${misdrawn.length} frames:\n${misdrawn.join('\n')}`)
      .toEqual([])
  })

  it('never draws a line across the frame', () => {
    const trace = trackFlight()
    const element = { width: truth.frameWidth * 2, height: truth.frameHeight * 2 }
    const recorder = createTraceRecorder()
    renderTrace(recorder, { trace, element, currentTimeUs: 0, showMarkers: false })

    // The bound exists to catch a bridged hole, not to constrain the flight.
    // In world coordinates the disc genuinely covers up to ~60 analysis pixels
    // in a frame, which is ~150 here at 2x, so legitimate motion reaches that.
    // Bridging even a two-frame hole would be several hundred.
    expect(recorder.longestPiece()).toBeLessThan(250)
  })

  /** A disc is a small object. Anything covering much of the frame is not one. */
  it('never reports a candidate the size of a person', () => {
    const frameArea = truth.frameWidth * truth.frameHeight
    const oversized: string[] = []
    for (const entry of truth.frames) {
      const { candidates } = detector.detect(frameFor(entry.frame), ranges)
      for (const candidate of candidates) {
        if (candidate.area > frameArea * 0.02) {
          oversized.push(
            `frame ${entry.frame}: ${candidate.area.toFixed(0)}px (${(
              (candidate.area / frameArea) *
              100
            ).toFixed(1)}% of frame)`,
          )
        }
      }
    }
    expect(oversized, `oversized blobs:\n${oversized.join('\n')}`).toEqual([])
  })
})
