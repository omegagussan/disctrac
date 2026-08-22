import type { TraceRenderTarget } from './renderTrace.ts'

/**
 * A 2D-context stand-in that records what would have been drawn.
 *
 * Lets the overlay's output be checked without a browser or a native canvas
 * binding: the recorded geometry can be compared directly against annotated
 * disc positions, and rasterised when an actual painted-pixel check is wanted.
 *
 * Test-only; nothing in the app imports this.
 */

export interface RecordedPath {
  points: { x: number; y: number }[]
  colour: string
  lineWidth: number
}

export interface RecordedArc {
  x: number
  y: number
  radius: number
  colour: string
  filled: boolean
}

export interface TraceRecorder extends TraceRenderTarget {
  readonly paths: RecordedPath[]
  readonly arcs: RecordedArc[]
  readonly clears: number
  /** The longest straight piece drawn. A bridged gap shows up here. */
  longestPiece(): number
  /** Shortest distance from a point to any drawn line piece. */
  distanceToPath(point: { x: number; y: number }): number
  /** Paint the recorded paths into a grid and report whether any pixel is near a point. */
  paintedNear(point: { x: number; y: number }, within: number, size: { width: number; height: number }): boolean
}

function distanceToPiece(
  point: { x: number; y: number },
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y)
  // Projection of the point onto the piece, clamped to its ends.
  const t = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared),
  )
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy))
}

export function createTraceRecorder(): TraceRecorder {
  const paths: RecordedPath[] = []
  const arcs: RecordedArc[] = []
  let clears = 0
  let pending: { x: number; y: number }[] = []
  let pendingArc: { x: number; y: number; radius: number } | null = null

  const recorder = {
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    lineJoin: 'round' as CanvasLineJoin,
    lineCap: 'round' as CanvasLineCap,

    clearRect() {
      clears += 1
    },
    beginPath() {
      pending = []
      pendingArc = null
    },
    moveTo(x: number, y: number) {
      pending.push({ x, y })
    },
    lineTo(x: number, y: number) {
      pending.push({ x, y })
    },
    arc(x: number, y: number, radius: number) {
      pendingArc = { x, y, radius }
    },
    stroke() {
      if (pendingArc) {
        arcs.push({ ...pendingArc, colour: String(recorder.strokeStyle), filled: false })
        pendingArc = null
        return
      }
      if (pending.length > 0) {
        paths.push({
          points: [...pending],
          colour: String(recorder.strokeStyle),
          lineWidth: recorder.lineWidth,
        })
      }
    },
    fill() {
      if (pendingArc) {
        arcs.push({ ...pendingArc, colour: String(recorder.fillStyle), filled: true })
        pendingArc = null
      }
    },

    get paths() {
      return paths
    },
    get arcs() {
      return arcs
    },
    get clears() {
      return clears
    },

    longestPiece() {
      let longest = 0
      for (const path of paths) {
        for (let index = 1; index < path.points.length; index += 1) {
          const from = path.points[index - 1]
          const to = path.points[index]
          longest = Math.max(longest, Math.hypot(to.x - from.x, to.y - from.y))
        }
      }
      return longest
    },

    distanceToPath(point: { x: number; y: number }) {
      let nearest = Number.POSITIVE_INFINITY
      for (const path of paths) {
        for (let index = 1; index < path.points.length; index += 1) {
          nearest = Math.min(nearest, distanceToPiece(point, path.points[index - 1], path.points[index]))
        }
      }
      return nearest
    },

    paintedNear(
      point: { x: number; y: number },
      within: number,
      size: { width: number; height: number },
    ) {
      const painted = new Uint8Array(size.width * size.height)
      const plot = (x: number, y: number) => {
        const px = Math.round(x)
        const py = Math.round(y)
        if (px < 0 || py < 0 || px >= size.width || py >= size.height) return
        painted[py * size.width + px] = 1
      }
      // Straightforward DDA; enough to answer "did anything get drawn here".
      for (const path of paths) {
        for (let index = 1; index < path.points.length; index += 1) {
          const from = path.points[index - 1]
          const to = path.points[index]
          const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)))
          for (let step = 0; step <= steps; step += 1) {
            const t = step / steps
            plot(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
          }
        }
      }

      const radius = Math.ceil(within)
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.hypot(dx, dy) > within) continue
          const px = Math.round(point.x) + dx
          const py = Math.round(point.y) + dy
          if (px < 0 || py < 0 || px >= size.width || py >= size.height) continue
          if (painted[py * size.width + px] === 1) return true
        }
      }
      return false
    },
  }

  return recorder
}
