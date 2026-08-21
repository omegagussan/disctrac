import { describe, expect, it } from 'vitest'
import { DEFAULT_KALMAN_CONFIG } from './kalman.ts'
import type { Candidate } from './tracker.ts'
import { chooseCandidate, createTracker, drawablePoints } from './tracker.ts'

const DT = DEFAULT_KALMAN_CONFIG.dt

const candidate = (x: number, y: number, area = 50): Candidate => ({
  x,
  y,
  area,
  radius: Math.sqrt(area / Math.PI),
})

/** A disc crossing the frame at a constant 300 px/s horizontally. */
const truthAt = (frame: number) => ({ x: 100 + 300 * DT * frame, y: 200 })

const steadyTracker = () =>
  createTracker({ kalman: { drag: 1, measurementNoise: 1, velocityNoise: 1 } })

describe('chooseCandidate', () => {
  it('returns null when there is nothing to choose', () => {
    expect(chooseCandidate([], { minArea: 12 })).toBeNull()
  })

  it('rejects everything below the area floor', () => {
    expect(chooseCandidate([candidate(10, 10, 5), candidate(20, 20, 8)], { minArea: 12 })).toBeNull()
  })

  it('takes the largest blob when there is no prediction to go on', () => {
    const big = candidate(500, 500, 400)
    const chosen = chooseCandidate([candidate(10, 10, 50), big], { minArea: 12 })
    expect(chosen).toBe(big)
  })

  /**
   * The case that keeps a track alive: a bright shirt or a patch of sky can
   * easily out-area a small distant disc, so once the filter has an opinion
   * about where the disc should be, proximity beats size.
   */
  it('prefers a small candidate near the prediction over a large one far away', () => {
    const nearbyDisc = candidate(102, 200, 30)
    const distantShirt = candidate(600, 400, 5000)

    const chosen = chooseCandidate([distantShirt, nearbyDisc], {
      minArea: 12,
      prediction: { x: 100, y: 200 },
    })
    expect(chosen).toBe(nearbyDisc)
  })

  it('ignores candidates beyond the association distance', () => {
    const chosen = chooseCandidate([candidate(600, 400, 5000)], {
      minArea: 12,
      prediction: { x: 100, y: 200 },
      maxDistance: 50,
    })
    expect(chosen).toBeNull()
  })

  it('still accepts a candidate inside the association distance', () => {
    const near = candidate(120, 210)
    const chosen = chooseCandidate([near], {
      minArea: 12,
      prediction: { x: 100, y: 200 },
      maxDistance: 50,
    })
    expect(chosen).toBe(near)
  })
})

describe('tracking a clean flight', () => {
  it('follows the disc and reports no trouble', () => {
    const tracker = steadyTracker()
    for (let frame = 0; frame < 30; frame += 1) {
      const truth = truthAt(frame)
      tracker.process(frame, frame * 33367, [candidate(truth.x, truth.y)])
    }

    const points = tracker.points
    expect(points).toHaveLength(30)
    expect(points.every((point) => !point.occluded)).toBe(true)
    expect(points.every((point) => !point.lost)).toBe(true)

    const last = points[29]
    expect(last.filtered.x).toBeCloseTo(truthAt(29).x, 0)
    expect(last.filtered.y).toBeCloseTo(200, 0)
    expect(last.measured).toEqual({ x: truthAt(29).x, y: 200 })
  })

  it('records the radius it measured', () => {
    const tracker = steadyTracker()
    const point = tracker.process(0, 0, [candidate(100, 200, 314)])
    expect(point.radius).toBeCloseTo(10, 1)
  })
})

describe('occlusion', () => {
  const runWithGap = (gapFrames: number) => {
    const tracker = steadyTracker()
    for (let frame = 0; frame < 40; frame += 1) {
      const truth = truthAt(frame)
      const behindTree = frame >= 20 && frame < 20 + gapFrames
      tracker.process(frame, frame * 33367, behindTree ? [] : [candidate(truth.x, truth.y)])
    }
    return tracker.points
  }

  it('coasts through a short gap and keeps moving', () => {
    const points = runWithGap(5)
    const occluded = points.filter((point) => point.occluded)

    expect(occluded).toHaveLength(5)
    expect(occluded.every((point) => point.measured === null)).toBe(true)
    // The estimate must advance during the gap, not freeze in place.
    expect(occluded[4].filtered.x).toBeGreaterThan(occluded[0].filtered.x)
  })

  it('stays near the truth across the gap', () => {
    const points = runWithGap(5)
    const lastOccluded = points[24]
    expect(lastOccluded.filtered.x).toBeCloseTo(truthAt(24).x, 0)
  })

  it('picks the disc back up on the far side', () => {
    const points = runWithGap(5)
    const reacquired = points[25]

    expect(reacquired.occluded).toBe(false)
    expect(reacquired.lost).toBe(false)
    expect(points[39].filtered.x).toBeCloseTo(truthAt(39).x, 0)
  })

  it('gives up on a gap longer than the tolerance', () => {
    const points = runWithGap(25)
    expect(points.some((point) => point.lost)).toBe(true)
  })

  /**
   * After giving up, the next sighting should start a clean track rather than
   * being dragged toward wherever the abandoned one had drifted to.
   */
  it('starts a fresh track after giving up', () => {
    const tracker = steadyTracker()
    tracker.process(0, 0, [candidate(100, 200)])
    for (let frame = 1; frame <= 20; frame += 1) tracker.process(frame, frame * 33367, [])

    const reacquisition = tracker.process(21, 21 * 33367, [candidate(900, 500)])
    expect(reacquisition.lost).toBe(false)
    expect(reacquisition.filtered.x).toBeCloseTo(900, 6)
    expect(reacquisition.filtered.y).toBeCloseTo(500, 6)
  })
})

describe('tree strikes', () => {
  it('flags the frame where the disc changes direction abruptly', () => {
    const tracker = steadyTracker()
    for (let frame = 0; frame < 20; frame += 1) {
      const truth = truthAt(frame)
      tracker.process(frame, frame * 33367, [candidate(truth.x, truth.y)])
    }

    // Same x, 80px down: the disc has been deflected.
    const deflected = truthAt(20)
    const point = tracker.process(20, 20 * 33367, [candidate(deflected.x, deflected.y + 80)])

    expect(point.gated).toBe(true)
    expect(point.mahalanobis).toBeGreaterThan(DEFAULT_KALMAN_CONFIG.gateThreshold)
    expect(point.occluded).toBe(false)
  })

  it('leaves ordinary frames unflagged', () => {
    const tracker = steadyTracker()
    for (let frame = 0; frame < 20; frame += 1) {
      const truth = truthAt(frame)
      tracker.process(frame, frame * 33367, [candidate(truth.x, truth.y)])
    }
    expect(tracker.points.every((point) => !point.gated)).toBe(true)
  })
})

describe('drawablePoints', () => {
  it('drops the points the filter had no estimate for', () => {
    const tracker = steadyTracker()
    tracker.process(0, 0, [])
    tracker.process(1, 33367, [candidate(100, 200)])

    expect(tracker.points).toHaveLength(2)
    expect(drawablePoints(tracker.points)).toHaveLength(1)
  })
})
