import { describe, expect, it } from 'vitest'
import { DEFAULT_KALMAN_CONFIG, createKalmanFilter, invert2x2 } from './kalman.ts'
import type { KalmanConfig } from './kalman.ts'

const config = (overrides: Partial<KalmanConfig> = {}): KalmanConfig => ({
  ...DEFAULT_KALMAN_CONFIG,
  ...overrides,
})

/** Ground truth: a disc starting at (100, 100) moving at a constant velocity. */
const truthAt = (frame: number, dt: number, vx = 300, vy = 150) => ({
  x: 100 + vx * dt * frame,
  y: 100 + vy * dt * frame,
})

describe('invert2x2', () => {
  it('inverts a known matrix', () => {
    const inverse = invert2x2([
      [4, 7],
      [2, 6],
    ])
    expect(inverse).not.toBeNull()
    expect(inverse![0][0]).toBeCloseTo(0.6, 12)
    expect(inverse![0][1]).toBeCloseTo(-0.7, 12)
    expect(inverse![1][0]).toBeCloseTo(-0.2, 12)
    expect(inverse![1][1]).toBeCloseTo(0.4, 12)
  })

  it.each([
    ['a singular matrix', [[1, 2], [2, 4]]],
    ['all zeros', [[0, 0], [0, 0]]],
  ])('returns null for %s', (_label, matrix) => {
    expect(invert2x2(matrix as number[][])).toBeNull()
  })
})

describe('initialisation', () => {
  it('has no state before the first measurement', () => {
    expect(createKalmanFilter().state).toBeNull()
  })

  /**
   * The first measurement cannot be an outlier — there is nothing to be an
   * outlier from. Gating it would reject the very sample that starts the track.
   */
  it('initialises on the first measurement instead of gating it', () => {
    const filter = createKalmanFilter()
    const outcome = filter.correct({ x: 640, y: 360 })

    expect(outcome.accepted).toBe(true)
    expect(outcome.gated).toBe(false)
    expect(filter.state).toEqual({ x: 640, y: 360, vx: 0, vy: 0 })
  })

  it('predicts harmlessly when it has no state', () => {
    const filter = createKalmanFilter()
    expect(filter.predict()).toEqual({ x: 0, y: 0, vx: 0, vy: 0 })
    expect(filter.state).toBeNull()
  })
})

describe('tracking constant velocity', () => {
  it('converges on the true velocity from noiseless measurements', () => {
    const settings = config({ drag: 1, measurementNoise: 1, velocityNoise: 1, positionNoise: 0.01 })
    const filter = createKalmanFilter(settings)

    for (let frame = 0; frame < 40; frame += 1) {
      if (frame > 0) filter.predict()
      filter.correct(truthAt(frame, settings.dt))
    }

    const state = filter.state!
    const expected = truthAt(39, settings.dt)
    expect(state.x).toBeCloseTo(expected.x, 0)
    expect(state.y).toBeCloseTo(expected.y, 0)
    // Velocity is never measured directly, only inferred from position changes.
    expect(state.vx).toBeGreaterThan(297)
    expect(state.vx).toBeLessThan(303)
    expect(state.vy).toBeGreaterThan(148.5)
    expect(state.vy).toBeLessThan(151.5)
  })

  it('pulls the state toward a measurement rather than ignoring it', () => {
    const filter = createKalmanFilter()
    filter.correct({ x: 100, y: 100 })
    const predicted = filter.predict()

    const measurement = { x: 120, y: 100 }
    filter.correct(measurement)

    const before = Math.abs(predicted.x - measurement.x)
    const after = Math.abs(filter.state!.x - measurement.x)
    expect(after).toBeLessThan(before)
  })
})

describe('drag', () => {
  it('decays velocity by exactly the drag factor each predicted frame', () => {
    const settings = config({ drag: 0.9 })
    const filter = createKalmanFilter(settings)

    // Establish some velocity from two positions.
    filter.correct({ x: 0, y: 0 })
    filter.predict()
    filter.correct({ x: 50, y: 0 })

    const first = filter.predict().vx
    const second = filter.predict().vx
    expect(second / first).toBeCloseTo(settings.drag, 9)
  })

  it('leaves velocity untouched when drag is 1', () => {
    const filter = createKalmanFilter(config({ drag: 1 }))
    filter.correct({ x: 0, y: 0 })
    filter.predict()
    filter.correct({ x: 50, y: 0 })

    const first = filter.predict().vx
    const second = filter.predict().vx
    expect(second).toBeCloseTo(first, 9)
  })
})

describe('coasting through occlusion', () => {
  const established = () => {
    const settings = config({ drag: 1, measurementNoise: 1, velocityNoise: 1 })
    const filter = createKalmanFilter(settings)
    for (let frame = 0; frame < 20; frame += 1) {
      if (frame > 0) filter.predict()
      filter.correct(truthAt(frame, settings.dt))
    }
    return { filter, settings }
  }

  it('keeps moving along the last known velocity', () => {
    const { filter, settings } = established()
    const before = filter.state!

    const after = filter.predict()
    expect(after.x).toBeCloseTo(before.x + before.vx * settings.dt, 6)
    expect(after.y).toBeCloseTo(before.y + before.vy * settings.dt, 6)
  })

  it('grows less certain the longer it coasts', () => {
    const { filter } = established()
    let previous = filter.positionVariance

    for (let frame = 0; frame < 10; frame += 1) {
      filter.predict()
      filter.miss()
      const current = filter.positionVariance
      expect(current).toBeGreaterThan(previous)
      previous = current
    }
  })

  it('extrapolates roughly the right distance across a short occlusion', () => {
    const { filter, settings } = established()
    // Five frames behind a tree.
    for (let frame = 0; frame < 5; frame += 1) {
      filter.predict()
      filter.miss()
    }
    const expected = truthAt(24, settings.dt)
    expect(filter.state!.x).toBeCloseTo(expected.x, 0)
    expect(filter.state!.y).toBeCloseTo(expected.y, 0)
  })

  it('declares the track lost only after the configured run of misses', () => {
    const filter = createKalmanFilter(config({ maxConsecutiveMisses: 3 }))
    filter.correct({ x: 10, y: 10 })

    for (let frame = 0; frame < 3; frame += 1) {
      filter.miss()
      expect(filter.isLost).toBe(false)
    }
    filter.miss()
    expect(filter.isLost).toBe(true)
  })

  it('forgets the miss streak once the disc is seen again', () => {
    const filter = createKalmanFilter(config({ maxConsecutiveMisses: 3 }))
    filter.correct({ x: 10, y: 10 })
    filter.miss()
    filter.miss()
    expect(filter.missStreak).toBe(2)

    filter.predict()
    filter.correct({ x: 12, y: 10 })
    expect(filter.missStreak).toBe(0)
    expect(filter.isLost).toBe(false)
  })
})

describe('the innovation gate', () => {
  const movingRight = () => {
    const settings = config({ drag: 1, measurementNoise: 1, velocityNoise: 1 })
    const filter = createKalmanFilter(settings)
    for (let frame = 0; frame < 20; frame += 1) {
      if (frame > 0) filter.predict()
      filter.correct(truthAt(frame, settings.dt, 300, 0))
    }
    return { filter, settings }
  }

  it('stays quiet for measurements consistent with the physics', () => {
    const { filter, settings } = movingRight()
    filter.predict()
    const outcome = filter.correct(truthAt(20, settings.dt, 300, 0))

    expect(outcome.gated).toBe(false)
    expect(outcome.mahalanobis).toBeLessThan(DEFAULT_KALMAN_CONFIG.gateThreshold)
  })

  /**
   * A tree strike looks like a measurement the motion model cannot explain. The
   * gate is what stops the filter gliding straight on past the bounce.
   */
  it('fires when the disc turns a right angle', () => {
    const { filter, settings } = movingRight()
    const predicted = filter.predict()

    // Same instant, but 80px off the predicted path: a hard deflection.
    const outcome = filter.correct({ x: predicted.x, y: predicted.y + 80 })

    expect(outcome.gated).toBe(true)
    expect(outcome.mahalanobis).toBeGreaterThan(settings.gateThreshold)
    expect(Math.abs(outcome.innovation.y)).toBeCloseTo(80, 6)
  })

  it('re-locks onto the new direction within a few frames', () => {
    const { filter, settings } = movingRight()
    const predicted = filter.predict()
    const bounceY = predicted.y + 80

    // The disc now travels downward instead of rightward.
    filter.correct({ x: predicted.x, y: bounceY })
    for (let frame = 1; frame <= 6; frame += 1) {
      filter.predict()
      filter.correct({ x: predicted.x, y: bounceY + 250 * settings.dt * frame })
    }

    const state = filter.state!
    // Velocity should now point down the new path, not along the old one.
    expect(state.vy).toBeGreaterThan(150)
    expect(Math.abs(state.vx)).toBeLessThan(150)
    expect(state.y).toBeCloseTo(bounceY + 250 * settings.dt * 6, 0)
  })

  it('moves further toward the measurement when gated than it would otherwise', () => {
    const offset = 80
    const run = (gateThreshold: number) => {
      const settings = config({
        drag: 1,
        measurementNoise: 1,
        velocityNoise: 1,
        gateThreshold,
      })
      const filter = createKalmanFilter(settings)
      for (let frame = 0; frame < 20; frame += 1) {
        if (frame > 0) filter.predict()
        filter.correct(truthAt(frame, settings.dt, 300, 0))
      }
      const predicted = filter.predict()
      filter.correct({ x: predicted.x, y: predicted.y + offset })
      return Math.abs(filter.state!.y - (predicted.y + offset))
    }

    // A threshold of Infinity can never trip, so the same measurement is
    // absorbed as ordinary noise instead.
    expect(run(DEFAULT_KALMAN_CONFIG.gateThreshold)).toBeLessThan(run(Number.POSITIVE_INFINITY))
  })
})
