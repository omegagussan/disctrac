import { useCallback, useEffect, useRef } from 'react'
import type { Trace } from '../cv-protocol.ts'
import { renderTrace } from '../video/renderTrace.ts'

export interface TraceOverlayProps {
  trace: Trace | null
  /** Playback position, matched against the trace's frame timestamps. */
  currentTimeUs: number
  /** Show the raw measurement and filtered estimate as separate markers. */
  showMarkers: boolean
  /** Show the corners camera motion was estimated from. */
  showFlow: boolean
}

/**
 * Hosts the canvas the flight path is drawn on. The drawing itself lives in
 * src/video/renderTrace.ts so it can be exercised without a browser.
 */
export function TraceOverlay({
  trace,
  currentTimeUs,
  showMarkers,
  showFlow,
}: TraceOverlayProps) {
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

    renderTrace(context, {
      trace,
      element: { width, height },
      currentTimeUs,
      showMarkers,
      showFlow,
    })
  }, [currentTimeUs, showFlow, showMarkers, trace])

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
