import type { Trace, TracePoint } from '../cv-protocol.ts'
import type { Size } from './pointer.ts'
import { framePointToElement, frameToElementScale } from './pointer.ts'
import { pointAt, toSegments } from './trace.ts'

/**
 * Drawing the flight path.
 *
 * Split out of the component and written against the narrowest possible slice of
 * a 2D context, so a test can record every call and check what would actually
 * appear on screen. `CanvasRenderingContext2D` satisfies this structurally; the
 * component passes the real thing.
 */
export interface TraceRenderTarget {
  // Widened to what CanvasRenderingContext2D actually declares; mutable
  // properties are invariant, so a narrower `string` makes the real context
  // unassignable. Only strings are ever written here.
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineJoin: CanvasLineJoin
  lineCap: CanvasLineCap
  clearRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  arc(x: number, y: number, radius: number, start: number, end: number): void
  fill(): void
}

export interface TraceColours {
  ahead: string
  travelled: string
  measured: string
  filtered: string
}

export const DEFAULT_TRACE_COLOURS: TraceColours = {
  ahead: 'rgba(96, 165, 250, 0.35)',
  travelled: 'rgba(59, 130, 246, 0.95)',
  measured: 'rgba(239, 68, 68, 0.95)',
  filtered: 'rgba(34, 197, 94, 0.95)',
}

export interface RenderTraceOptions {
  trace: Trace | null
  /** Size of the element the canvas covers, in CSS pixels. */
  element: Size
  currentTimeUs: number
  showMarkers: boolean
  colours?: TraceColours
}

export function renderTrace(target: TraceRenderTarget, options: RenderTraceOptions): void {
  const { element, currentTimeUs, showMarkers, trace } = options
  const colours = options.colours ?? DEFAULT_TRACE_COLOURS

  target.clearRect(0, 0, element.width, element.height)
  if (!trace) return

  // The detector worked on a downscaled frame; the projection absorbs both that
  // and any letterboxing.
  const frame = { width: trace.analysisWidth, height: trace.analysisHeight }

  // Split at the holes rather than drawing through them: joining across one
  // draws a straight line between two unrelated positions.
  const segments = toSegments(trace.points)
  if (segments.length === 0) return

  const strokePoints = (points: TracePoint[], colour: string, lineWidth: number) => {
    if (points.length < 2) return
    target.beginPath()
    let started = false
    for (const point of points) {
      const at = framePointToElement(point.filtered, element, frame)
      if (!at) continue
      if (started) target.lineTo(at.x, at.y)
      else {
        target.moveTo(at.x, at.y)
        started = true
      }
    }
    target.strokeStyle = colour
    target.lineWidth = lineWidth
    target.lineJoin = 'round'
    target.lineCap = 'round'
    target.stroke()
  }

  for (const segment of segments) {
    strokePoints(segment, colours.ahead, 2)
    strokePoints(
      segment.filter((point) => point.timestampUs <= currentTimeUs),
      colours.travelled,
      3,
    )
  }

  const current = pointAt(segments, currentTimeUs)
  if (!current) return

  const dot = (at: { x: number; y: number }, colour: string, radius: number) => {
    target.beginPath()
    target.arc(at.x, at.y, radius, 0, Math.PI * 2)
    target.fillStyle = colour
    target.fill()
  }

  const scale = frameToElementScale(element, frame)
  const filteredAt = framePointToElement(current.filtered, element, frame)

  if (filteredAt) {
    // A ring at the measured radius makes it obvious when the detector has
    // latched onto something far too large to be a disc.
    if (current.radius !== null) {
      target.beginPath()
      target.arc(filteredAt.x, filteredAt.y, Math.max(4, current.radius * scale), 0, Math.PI * 2)
      target.strokeStyle = colours.filtered
      target.lineWidth = 1.5
      target.stroke()
    }
    if (showMarkers) dot(filteredAt, colours.filtered, 4)
  }

  if (showMarkers && current.measured) {
    const measuredAt = framePointToElement(current.measured, element, frame)
    if (measuredAt) dot(measuredAt, colours.measured, 3)
  }
}
