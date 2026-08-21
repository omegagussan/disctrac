import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FPS,
  clampFrame,
  formatTimecode,
  frameAtTime,
  frameCount,
  timeAtFrame,
} from './frames.ts'

describe('frameAtTime', () => {
  it('reports frame 0 at the start', () => {
    expect(frameAtTime(0, DEFAULT_FPS)).toBe(0)
  })

  it('clamps negative time to frame 0', () => {
    expect(frameAtTime(-1, DEFAULT_FPS)).toBe(0)
  })

  /**
   * The reason `frameAtTime` carries an epsilon. `n / fps * fps` is not exactly
   * `n` in binary floating point, and when it lands a hair below, a bare
   * `Math.floor` reports frame n-1 — so stepping forward appears to do nothing.
   */
  it('does not fall a frame short at exact frame boundaries', () => {
    for (let n = 0; n <= 30; n += 1) {
      expect(frameAtTime(n / DEFAULT_FPS, DEFAULT_FPS)).toBe(n)
    }
  })

  it('round-trips with timeAtFrame, which is what makes stepping stable', () => {
    for (let n = 0; n <= 60; n += 1) {
      expect(frameAtTime(timeAtFrame(n, DEFAULT_FPS), DEFAULT_FPS)).toBe(n)
    }
  })

  it('holds the same frame across its whole duration', () => {
    const frameStart = 10 / DEFAULT_FPS
    const justBeforeNext = 11 / DEFAULT_FPS - 1e-5
    expect(frameAtTime(frameStart, DEFAULT_FPS)).toBe(10)
    expect(frameAtTime(justBeforeNext, DEFAULT_FPS)).toBe(10)
  })
})

describe('timeAtFrame', () => {
  it('targets the middle of the frame, not its edge', () => {
    expect(timeAtFrame(0, DEFAULT_FPS)).toBeCloseTo(0.5 / DEFAULT_FPS, 12)
  })

  it('increases by exactly one frame period per frame', () => {
    const step = timeAtFrame(1, DEFAULT_FPS) - timeAtFrame(0, DEFAULT_FPS)
    expect(step).toBeCloseTo(1 / DEFAULT_FPS, 12)
  })
})

describe('frameCount', () => {
  // Cross-checked against ffprobe's frame counts for the committed fixtures.
  it.each([
    [12, 360],
    [11, 330],
  ])('counts a %is clip as %i frames, matching the fixtures', (duration, expected) => {
    expect(frameCount(duration, DEFAULT_FPS)).toBe(expected)
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -5],
  ])('returns 0 for a duration of %s', (_label, duration) => {
    expect(frameCount(duration, DEFAULT_FPS)).toBe(0)
  })
})

describe('clampFrame', () => {
  it('keeps an in-range frame untouched', () => {
    expect(clampFrame(100, 12, DEFAULT_FPS)).toBe(100)
  })

  it('stops at the ends rather than seeking outside the clip', () => {
    expect(clampFrame(-5, 12, DEFAULT_FPS)).toBe(0)
    expect(clampFrame(9999, 12, DEFAULT_FPS)).toBe(359)
  })

  it('returns 0 while the duration is still unknown', () => {
    expect(clampFrame(42, Number.NaN, DEFAULT_FPS)).toBe(0)
  })
})

describe('formatTimecode', () => {
  it.each([
    [0, '0:00.00'],
    [1.5, '0:01.50'],
    [61.5, '1:01.50'],
    [11.999, '0:11.99'],
    [600, '10:00.00'],
  ])('formats %ss as %s', (seconds, expected) => {
    expect(formatTimecode(seconds)).toBe(expected)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('falls back to zero for %s', (value) => {
    expect(formatTimecode(value)).toBe('0:00.00')
  })
})
