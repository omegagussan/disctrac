import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDiscDetector } from './detectDisc.ts'
import type { FramePixels } from './floodFill.ts'
import { modelToHsvBounds, modeToHsvBounds } from './hsvBounds.ts'
import type { OpenCv } from './opencv.ts'
import { GRASS, ORANGE, WHITE, makeFrame, modeFromRgb } from './testing.ts'

/**
 * Exercises the real OpenCV build, which is why this file is slower than the
 * pure suites. The detector is DOM-free precisely so this is possible in Node —
 * only the demux and decode glue around it needs a browser.
 */

let cv: OpenCv

/**
 * Loaded through Node's own resolver rather than the bundler's, and awaited
 * rather than polled.
 *
 * Two quirks force this shape. OpenCV.js exports a **thenable** that resolves to
 * the initialised namespace — `onRuntimeInitialized` never fires and `Mat` stays
 * undefined until it resolves. And a module namespace carrying a `then` export
 * makes the bundler's loader treat the module itself as a promise, failing with
 * "Promise.prototype.then called on incompatible receiver", so importing
 * ./opencv.ts here is not an option even though the app does exactly that.
 *
 * `createDiscDetector` takes `cv` as a parameter and imports only its types,
 * which is what lets the detector stay agnostic about all of this.
 */
beforeAll(async () => {
  const nodeRequire = createRequire(import.meta.url)
  cv = await Promise.resolve(nodeRequire('@techstark/opencv-js') as PromiseLike<OpenCv>)
}, 120_000)

const SIZE = 64
const CENTRE = 32

const inCircle = (x: number, y: number, cx: number, cy: number, radius: number) =>
  (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2

/** An orange disc of the given radius on grass. */
const discOnGrass = (radius: number, cx = CENTRE, cy = CENTRE): FramePixels =>
  makeFrame(SIZE, SIZE, (x, y) => (inCircle(x, y, cx, cy, radius) ? ORANGE : GRASS))

const orangeRanges = (tolerance = 0.2) => modeToHsvBounds(modeFromRgb(ORANGE), tolerance)

describe('createDiscDetector', () => {
  it('finds an orange disc against grass', () => {
    const detector = createDiscDetector(cv)
    try {
      const { candidates } = detector.detect(discOnGrass(10), orangeRanges())

      expect(candidates).toHaveLength(1)
      expect(candidates[0].x).toBeCloseTo(CENTRE, 0)
      expect(candidates[0].y).toBeCloseTo(CENTRE, 0)
      // A rasterised radius-10 circle is ~314 px; the contour polygon runs
      // through pixel centres so it reads slightly under.
      expect(candidates[0].area).toBeGreaterThan(250)
      expect(candidates[0].area).toBeLessThan(340)
      expect(candidates[0].radius).toBeGreaterThan(8.9)
      expect(candidates[0].radius).toBeLessThan(10.5)
    } finally {
      detector.dispose()
    }
  })

  it('finds nothing in a frame of pure background', () => {
    const detector = createDiscDetector(cv)
    try {
      const grassOnly = makeFrame(SIZE, SIZE, () => GRASS)
      const { candidates, maskedPixels } = detector.detect(grassOnly, orangeRanges())

      expect(candidates).toEqual([])
      expect(maskedPixels).toBe(0)
    } finally {
      detector.dispose()
    }
  })

  /**
   * The reason the mask is OR'd rather than replaced: a two-tone disc must come
   * out as one object, not two, and its hue band also splits across the 0/179
   * seam into two ranges.
   */
  it('treats a two-tone disc as a single object', () => {
    const detector = createDiscDetector(cv)
    try {
      const twoTone = makeFrame(SIZE, SIZE, (x, y) => {
        if (!inCircle(x, y, CENTRE, CENTRE, 12)) return GRASS
        return x < CENTRE ? ORANGE : WHITE
      })
      const ranges = modelToHsvBounds([modeFromRgb(ORANGE, 0.5), modeFromRgb(WHITE, 0.5)], 0.2)

      const { candidates } = detector.detect(twoTone, ranges)

      expect(candidates).toHaveLength(1)
      expect(candidates[0].x).toBeCloseTo(CENTRE, 0)
      expect(candidates[0].area).toBeGreaterThan(380)
    } finally {
      detector.dispose()
    }
  })

  it('misses half the disc when only one of its colours is modelled', () => {
    const detector = createDiscDetector(cv)
    try {
      const twoTone = makeFrame(SIZE, SIZE, (x, y) => {
        if (!inCircle(x, y, CENTRE, CENTRE, 12)) return GRASS
        return x < CENTRE ? ORANGE : WHITE
      })
      // Only the orange mode: the white half is background as far as this goes.
      const { candidates } = detector.detect(twoTone, orangeRanges())

      expect(candidates).toHaveLength(1)
      expect(candidates[0].area).toBeLessThan(280)
      expect(candidates[0].x).toBeLessThan(CENTRE)
    } finally {
      detector.dispose()
    }
  })

  it('reports every disc in the frame', () => {
    const detector = createDiscDetector(cv)
    try {
      const twoDiscs = makeFrame(SIZE, SIZE, (x, y) =>
        inCircle(x, y, 16, 16, 7) || inCircle(x, y, 48, 48, 7) ? ORANGE : GRASS,
      )
      const { candidates } = detector.detect(twoDiscs, orangeRanges())

      expect(candidates).toHaveLength(2)
      const xs = candidates.map((candidate) => Math.round(candidate.x)).sort((a, b) => a - b)
      expect(xs).toEqual([16, 48])
    } finally {
      detector.dispose()
    }
  })

  it('drops contours below the area floor', () => {
    const detector = createDiscDetector(cv, { minArea: 500, openKernel: 0 })
    try {
      const { candidates } = detector.detect(discOnGrass(10), orangeRanges())
      expect(candidates).toEqual([])
    } finally {
      detector.dispose()
    }
  })

  /** Opening is what stops scattered single pixels being reported as discs. */
  it('opens away isolated speckle but keeps the disc', () => {
    const speckled = makeFrame(SIZE, SIZE, (x, y) => {
      if (inCircle(x, y, CENTRE, CENTRE, 10)) return ORANGE
      // 2x2 orange blocks dotted around the background. A single pixel would
      // not do: its contour area is 0, so the area floor drops it before
      // morphology is consulted, and the test would prove nothing.
      const isSpeckle = [
        [4, 4],
        [58, 6],
        [8, 55],
      ].some(([sx, sy]) => (x === sx || x === sx + 1) && (y === sy || y === sy + 1))
      return isSpeckle ? ORANGE : GRASS
    })

    const withOpening = createDiscDetector(cv, { minArea: 1, openKernel: 3 })
    const withoutOpening = createDiscDetector(cv, { minArea: 1, openKernel: 0 })
    try {
      expect(withoutOpening.detect(speckled, orangeRanges()).candidates.length).toBeGreaterThan(1)
      expect(withOpening.detect(speckled, orangeRanges()).candidates).toHaveLength(1)
    } finally {
      withOpening.dispose()
      withoutOpening.dispose()
    }
  })

  it('reuses its buffers across frames and survives a size change', () => {
    const detector = createDiscDetector(cv)
    try {
      expect(detector.detect(discOnGrass(10), orangeRanges()).candidates).toHaveLength(1)
      expect(detector.detect(discOnGrass(10), orangeRanges()).candidates).toHaveLength(1)

      // A different frame size must force reallocation rather than corrupting.
      const wider = makeFrame(96, 48, (x, y) => (inCircle(x, y, 48, 24, 9) ? ORANGE : GRASS))
      const { candidates } = detector.detect(wider, orangeRanges())
      expect(candidates).toHaveLength(1)
      expect(candidates[0].x).toBeCloseTo(48, 0)
      expect(candidates[0].y).toBeCloseTo(24, 0)
    } finally {
      detector.dispose()
    }
  })

  it('tolerates being disposed twice', () => {
    const detector = createDiscDetector(cv)
    detector.dispose()
    expect(() => detector.dispose()).not.toThrow()
  })
})
