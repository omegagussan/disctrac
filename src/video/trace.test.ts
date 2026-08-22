import { describe, expect, it } from 'vitest'
import type { TracePoint } from '../cv-protocol.ts'
import { pointAt, toSegments } from './trace.ts'

const point = (frameIndex: number, lost = false): TracePoint => ({
  frameIndex,
  timestampUs: frameIndex * 33_367,
  measured: lost ? null : { x: frameIndex, y: frameIndex },
  filtered: { x: frameIndex, y: frameIndex },
  radius: lost ? null : 4,
  occluded: lost,
  gated: false,
  lost,
})

describe('toSegments', () => {
  it('returns nothing for an empty track', () => {
    expect(toSegments([])).toEqual([])
  })

  it('returns nothing when every frame was lost', () => {
    expect(toSegments([point(0, true), point(1, true)])).toEqual([])
  })

  it('keeps an unbroken track as one segment', () => {
    const segments = toSegments([point(0), point(1), point(2)])
    expect(segments).toHaveLength(1)
    expect(segments[0]).toHaveLength(3)
  })

  /**
   * The bug this exists to prevent: dropping the lost frames and drawing the
   * survivors as one line bridges the hole with a straight line between two
   * unrelated positions, which is what turned a flight path into a scribble.
   */
  it('splits at a hole rather than drawing across it', () => {
    const segments = toSegments([
      point(0),
      point(1),
      point(2, true),
      point(3, true),
      point(4),
      point(5),
    ])
    expect(segments).toHaveLength(2)
    expect(segments[0].map((p) => p.frameIndex)).toEqual([0, 1])
    expect(segments[1].map((p) => p.frameIndex)).toEqual([4, 5])
  })

  it('drops a lone surviving frame, which draws no line anyway', () => {
    const segments = toSegments([point(0, true), point(1), point(2, true)])
    expect(segments).toEqual([])
  })

  it('ignores leading and trailing losses', () => {
    const segments = toSegments([point(0, true), point(1), point(2), point(3, true)])
    expect(segments).toHaveLength(1)
    expect(segments[0].map((p) => p.frameIndex)).toEqual([1, 2])
  })
})

describe('pointAt', () => {
  const segments = toSegments([point(0), point(1), point(2, true), point(3), point(4)])

  it('finds the frame nearest a playback position', () => {
    expect(pointAt(segments, point(4).timestampUs)?.frameIndex).toBe(4)
    expect(pointAt(segments, point(0).timestampUs)?.frameIndex).toBe(0)
  })

  it('looks across segments, not just the first', () => {
    expect(pointAt(segments, point(3).timestampUs)?.frameIndex).toBe(3)
  })

  it('snaps to the nearest frame inside a hole', () => {
    // Frame 2 was lost, so the answer must come from an adjacent segment.
    const found = pointAt(segments, point(2).timestampUs)
    expect([1, 3]).toContain(found?.frameIndex)
  })

  it('returns null when there is nothing drawable', () => {
    expect(pointAt([], 0)).toBeNull()
  })
})
