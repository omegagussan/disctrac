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
  it('follows the disc when the track is seeded from the click', () => {
    const window = truth.flightWindow
    const dt = 1001 / 30000
    const timestampFor = (frame: number) => (frame * 1001 * 1e6) / 30000
    const seedFrame = flightFrames[0]

    const tracker = createTracker({
      minArea: 12,
      // A disc cannot cross 60px between consecutive frames at this scale, so a
      // candidate further out than that is a different object, not a jump.
      maxAssociationDistance: 60,
      kalman: { dt },
      seed: {
        timestampUs: timestampFor(seedFrame.frame),
        x: seedFrame.disc.x,
        y: seedFrame.disc.y,
      },
    })

    // Every frame of the window is fed, as the app would; scoring happens only
    // on the frames that were annotated. Sampling every fourth frame for the
    // tracker itself would be unfair to it — the disc moves ~100px in that time,
    // so its first prediction would be a hundred pixels out.
    const annotated = new Map(flightFrames.map((entry) => [entry.frame, entry]))
    const errors: string[] = []
    for (let frame = window.startFrame; frame <= window.endFrame; frame += 1) {
      const { candidates } = detector.detect(frameFor(frame), ranges)
      const point = tracker.process(frame, timestampFor(frame), candidates)

      const entry = annotated.get(frame)
      if (!entry) continue
      const distance = Math.hypot(point.filtered.x - entry.disc.x, point.filtered.y - entry.disc.y)
      if (distance > 25) {
        errors.push(`frame ${frame}: filtered ${distance.toFixed(0)}px from truth`)
      }
    }

    expect(errors, `drifted on ${errors.length} frames:\n${errors.join('\n')}`).toEqual([])
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
