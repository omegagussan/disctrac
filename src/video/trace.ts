import type { TracePoint } from '../cv-protocol.ts'

/**
 * Splitting a track into drawable runs.
 *
 * A track has holes: frames before the disc was identified, and frames after it
 * was lost. Dropping those points and drawing the survivors as one polyline
 * bridges every hole with a straight line between two unrelated positions,
 * which is what turns a plausible flight path into a scribble across the frame.
 */
export function toSegments(points: TracePoint[]): TracePoint[][] {
  const segments: TracePoint[][] = []
  let current: TracePoint[] = []

  for (const point of points) {
    if (point.lost) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    current.push(point)
  }
  if (current.length > 0) segments.push(current)

  // A lone point draws nothing as a line and only adds noise.
  return segments.filter((segment) => segment.length > 1)
}

/** The point nearest a playback position, or null when no segment covers it. */
export function pointAt(segments: TracePoint[][], timestampUs: number): TracePoint | null {
  let best: TracePoint | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const segment of segments) {
    for (const point of segment) {
      const distance = Math.abs(point.timestampUs - timestampUs)
      if (distance < bestDistance) {
        bestDistance = distance
        best = point
      }
    }
  }
  return best
}
