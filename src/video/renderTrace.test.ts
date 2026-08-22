import { describe, expect, it } from 'vitest'
import type { Trace, TracePoint } from '../cv-protocol.ts'
import { DEFAULT_TRACE_COLOURS, renderTrace } from './renderTrace.ts'
import { createTraceRecorder } from './traceRecorder.ts'

const ANALYSIS = { width: 640, height: 360 }

const point = (frameIndex: number, x: number, y: number, lost = false): TracePoint => ({
  frameIndex,
  timestampUs: frameIndex * 33_367,
  measured: lost ? null : { x, y },
  filtered: { x, y },
  radius: lost ? null : 5,
  occluded: lost,
  gated: false,
  lost,
})

const traceOf = (points: TracePoint[]): Trace => ({
  points,
  analysisWidth: ANALYSIS.width,
  analysisHeight: ANALYSIS.height,
  sourceWidth: 1280,
  sourceHeight: 720,
  dt: 1001 / 30000,
  timings: { frames: points.length, readbackMs: 0, detectMs: 0, motionMs: 0, trackMs: 0, totalMs: 0 },
})

/** Same aspect ratio as the analysis frame, at twice the scale. */
const ELEMENT = { width: 1280, height: 720 }

const render = (trace: Trace | null, currentTimeUs: number, showMarkers = true) => {
  const recorder = createTraceRecorder()
  renderTrace(recorder, { trace, element: ELEMENT, currentTimeUs, showMarkers })
  return recorder
}

describe('renderTrace', () => {
  it('clears the canvas even when there is nothing to draw', () => {
    const recorder = render(null, 0)
    expect(recorder.clears).toBe(1)
    expect(recorder.paths).toEqual([])
  })

  it('draws nothing when every frame was lost', () => {
    const recorder = render(traceOf([point(0, 10, 10, true), point(1, 20, 20, true)]), 0)
    expect(recorder.paths).toEqual([])
  })

  it('scales frame coordinates up to the element', () => {
    // The element is twice the analysis frame, so 100 in frame space is 200 here.
    const recorder = render(traceOf([point(0, 100, 50), point(1, 110, 60)]), 0)
    const first = recorder.paths[0]
    expect(first.points[0]).toEqual({ x: 200, y: 100 })
    expect(first.points[1]).toEqual({ x: 220, y: 120 })
  })

  /**
   * The bug that turned a flight path into a scribble: dropping the lost frames
   * and drawing the survivors as one line bridges the hole with a straight line
   * between two unrelated positions.
   */
  it('does not bridge a hole in the track', () => {
    const recorder = render(
      traceOf([
        point(0, 10, 10),
        point(1, 20, 20),
        point(2, 0, 0, true),
        point(3, 0, 0, true),
        point(4, 300, 200),
        point(5, 310, 210),
      ]),
      Number.MAX_SAFE_INTEGER,
    )

    // Each run is stroked on its own, so no drawn piece spans the gap. Bridging
    // it would be a single piece of ~700 element px.
    expect(recorder.longestPiece()).toBeLessThan(40)
    for (const path of recorder.paths) {
      expect(path.points).toHaveLength(2)
    }
  })

  it('brightens only the part already played', () => {
    const trace = traceOf([point(0, 10, 10), point(1, 20, 20), point(2, 30, 30), point(3, 40, 40)])
    const recorder = render(trace, point(1, 0, 0).timestampUs)

    const travelled = recorder.paths.filter((path) => path.colour === DEFAULT_TRACE_COLOURS.travelled)
    const ahead = recorder.paths.filter((path) => path.colour === DEFAULT_TRACE_COLOURS.ahead)

    expect(ahead[0].points).toHaveLength(4)
    // Frames 0 and 1 have played; 2 and 3 have not.
    expect(travelled[0].points).toHaveLength(2)
  })

  it('puts the markers on the current frame, not the first', () => {
    const trace = traceOf([point(0, 10, 10), point(1, 200, 100), point(2, 30, 30)])
    const recorder = render(trace, point(1, 0, 0).timestampUs)

    const filled = recorder.arcs.filter((arc) => arc.filled)
    const filtered = filled.find((arc) => arc.colour === DEFAULT_TRACE_COLOURS.filtered)
    const measured = filled.find((arc) => arc.colour === DEFAULT_TRACE_COLOURS.measured)

    expect(filtered).toMatchObject({ x: 400, y: 200 })
    expect(measured).toMatchObject({ x: 400, y: 200 })
  })

  it('omits the markers when they are switched off', () => {
    const trace = traceOf([point(0, 10, 10), point(1, 20, 20)])
    const recorder = render(trace, 0, false)
    expect(recorder.arcs.filter((arc) => arc.filled)).toEqual([])
  })

  it('rings the disc at its measured radius', () => {
    const trace = traceOf([point(0, 100, 50), point(1, 110, 60)])
    const recorder = render(trace, 0, false)
    const ring = recorder.arcs.find((arc) => !arc.filled)
    // radius 5 in frame space at 2x scale.
    expect(ring).toMatchObject({ x: 200, y: 100, radius: 10 })
  })
})
