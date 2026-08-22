import type { Trace } from '../cv-protocol.ts'
import type { Affine } from './affine.ts'
import { IDENTITY, applyAffine } from './affine.ts'
import type { Point, Size } from './pointer.ts'
import { framePointToElement, frameToElementScale } from './pointer.ts'
import type { SmoothingOptions } from './smoothing.ts'
import { DEFAULT_SMOOTHING, smoothPath } from './smoothing.ts'
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
  /** Corners RANSAC accepted as background. */
  flowInlier: string
  /** Corners it rejected — moving foreground, or a mistracked corner. */
  flowOutlier: string
}

export const DEFAULT_TRACE_COLOURS: TraceColours = {
  ahead: 'rgba(96, 165, 250, 0.35)',
  travelled: 'rgba(59, 130, 246, 0.95)',
  measured: 'rgba(239, 68, 68, 0.95)',
  filtered: 'rgba(34, 197, 94, 0.95)',
  flowInlier: 'rgba(250, 204, 21, 0.9)',
  flowOutlier: 'rgba(148, 163, 184, 0.7)',
}

export interface RenderTraceOptions {
  trace: Trace | null
  /** Size of the element the canvas covers, in CSS pixels. */
  element: Size
  currentTimeUs: number
  showMarkers: boolean
  /** Draw the corners camera motion was estimated from, and how each moved. */
  showFlow?: boolean
  colours?: TraceColours
  /**
   * Smoothing applied before drawing. `null` draws the tracker's raw output,
   * which is useful when debugging the tracker itself.
   */
  smoothing?: SmoothingOptions | null
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

  // A disc cannot jink: a kink in the tracked path is centroid noise, not
  // flight. Smoothing before drawing removes movement no disc could make, while
  // the underlying trace keeps its raw values for anything that wants them.
  const smoothing = options.smoothing === null ? null : (options.smoothing ?? DEFAULT_SMOOTHING)

  // Where the scene is *now*. Every historical point is mapped through this, so
  // the path stays pinned to the ground while the camera moves rather than
  // smearing across the picture with it.
  const currentPoint = pointAt(segments, currentTimeUs)
  const stabilise: Affine = currentPoint?.toFrame ?? IDENTITY
  const toScreen = (world: Point) => applyAffine(stabilise, world)

  const smoothedByFrame = new Map<number, Point>()
  const drawnSegments = segments.map((segment) => {
    const positions = segment.map((point) => point.filtered)
    const smoothed = smoothing ? smoothPath(positions, smoothing) : positions
    segment.forEach((point, index) => smoothedByFrame.set(point.frameIndex, smoothed[index]))
    return segment.map((point, index) => ({
      position: smoothed[index],
      timestampUs: point.timestampUs,
    }))
  })

  const strokePositions = (
    samples: { position: Point }[],
    colour: string,
    lineWidth: number,
  ) => {
    if (samples.length < 2) return
    target.beginPath()
    let started = false
    for (const sample of samples) {
      const at = framePointToElement(toScreen(sample.position), element, frame)
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

  for (const drawn of drawnSegments) {
    strokePositions(drawn, colours.ahead, 2)
    strokePositions(
      drawn.filter((sample) => sample.timestampUs <= currentTimeUs),
      colours.travelled,
      3,
    )
  }

  const current = currentPoint
  if (!current) return

  // Flow belongs to the frame it was measured on, so it is drawn in raw screen
  // coordinates rather than stabilised like the path.
  if (options.showFlow && current.flow) {
    for (const sample of current.flow) {
      const tail = framePointToElement({ x: sample.x, y: sample.y }, element, frame)
      const head = framePointToElement(
        { x: sample.x + sample.dx, y: sample.y + sample.dy },
        element,
        frame,
      )
      if (!tail || !head) continue

      target.beginPath()
      target.moveTo(tail.x, tail.y)
      target.lineTo(head.x, head.y)
      target.strokeStyle = sample.inlier ? colours.flowInlier : colours.flowOutlier
      target.lineWidth = sample.inlier ? 1.5 : 1
      target.stroke()

      target.beginPath()
      target.arc(head.x, head.y, sample.inlier ? 2 : 1.5, 0, Math.PI * 2)
      target.fillStyle = sample.inlier ? colours.flowInlier : colours.flowOutlier
      target.fill()
    }
  }

  const dot = (at: { x: number; y: number }, colour: string, radius: number) => {
    target.beginPath()
    target.arc(at.x, at.y, radius, 0, Math.PI * 2)
    target.fillStyle = colour
    target.fill()
  }

  const scale = frameToElementScale(element, frame)
  const filteredAt = framePointToElement(
    toScreen(smoothedByFrame.get(current.frameIndex) ?? current.filtered),
    element,
    frame,
  )

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
    const measuredAt = framePointToElement(toScreen(current.measured), element, frame)
    if (measuredAt) dot(measuredAt, colours.measured, 3)
  }
}
