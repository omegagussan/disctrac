import { useCallback, useEffect, useRef } from 'react'
import type { Trace, TracePoint } from '../cv-protocol.ts'
import { framePointToElement, frameToElementScale } from '../video/pointer.ts'
import { pointAt, toSegments } from '../video/trace.ts'

export interface TraceOverlayProps {
  trace: Trace | null
  /** Playback position, matched against the trace's frame timestamps. */
  currentTimeUs: number
  /** Show the raw measurement and filtered estimate as separate markers. */
  showMarkers: boolean
}

const PATH_AHEAD = 'rgba(96, 165, 250, 0.35)'
const PATH_TRAVELLED = 'rgba(59, 130, 246, 0.95)'
const MEASURED = 'rgba(239, 68, 68, 0.95)'
const FILTERED = 'rgba(34, 197, 94, 0.95)'

/**
 * Draws the flight path over the video.
 *
 * The whole path is drawn faintly and the travelled part brightly, so the shape
 * of the throw is visible at any moment rather than only once it has played out.
 */
export function TraceOverlay({ trace, currentTimeUs, showMarkers }: TraceOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) return

    // Match the backing store to the device pixel ratio, or the line work looks
    // soft on any high-density display.
    const ratio = globalThis.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)

    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    if (!trace) return

    const element = { width, height }
    // The analysis frame is smaller than the clip; the projection absorbs that.
    const frame = { width: trace.analysisWidth, height: trace.analysisHeight }

    // Split at the holes rather than drawing through them: the track has gaps
    // before the disc is identified and after it is lost, and joining across one
    // draws a straight line between two unrelated positions.
    const segments = toSegments(trace.points)
    if (segments.length === 0) return

    const strokePoints = (points: TracePoint[], colour: string, lineWidth: number) => {
      if (points.length < 2) return
      context.beginPath()
      points.forEach((point, index) => {
        const at = framePointToElement(point.filtered, element, frame)
        if (!at) return
        if (index === 0) context.moveTo(at.x, at.y)
        else context.lineTo(at.x, at.y)
      })
      context.strokeStyle = colour
      context.lineWidth = lineWidth
      context.lineJoin = 'round'
      context.lineCap = 'round'
      context.stroke()
    }

    for (const segment of segments) {
      strokePoints(segment, PATH_AHEAD, 2)
      strokePoints(
        segment.filter((point) => point.timestampUs <= currentTimeUs),
        PATH_TRAVELLED,
        3,
      )
    }

    const current = pointAt(segments, currentTimeUs)
    if (!current) return

    const dot = (at: { x: number; y: number }, colour: string, radius: number) => {
      context.beginPath()
      context.arc(at.x, at.y, radius, 0, Math.PI * 2)
      context.fillStyle = colour
      context.fill()
    }

    const scale = frameToElementScale(element, frame)
    const filteredAt = framePointToElement(current.filtered, element, frame)

    if (filteredAt) {
      // A ring at the measured radius makes it obvious when the detector has
      // latched onto something far too large to be a disc.
      if (current.radius !== null) {
        context.beginPath()
        context.arc(filteredAt.x, filteredAt.y, Math.max(4, current.radius * scale), 0, Math.PI * 2)
        context.strokeStyle = FILTERED
        context.lineWidth = 1.5
        context.stroke()
      }
      if (showMarkers) dot(filteredAt, FILTERED, 4)
    }

    if (showMarkers && current.measured) {
      const measuredAt = framePointToElement(current.measured, element, frame)
      if (measuredAt) dot(measuredAt, MEASURED, 3)
    }
  }, [currentTimeUs, showMarkers, trace])

  useEffect(() => {
    draw()
  }, [draw])

  // The video box is fluid, so a resize invalidates every projected coordinate.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [draw])

  return <canvas ref={canvasRef} className="trace-overlay" aria-hidden="true" />
}
