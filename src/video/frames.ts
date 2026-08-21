/**
 * Frame arithmetic for stepping a `<video>` one frame at a time.
 *
 * Pure functions, kept apart from the component so the awkward parts — float
 * error at frame boundaries, clamping at the ends — are testable in isolation.
 */

/** The fixture clips are 30000/1001 (NTSC 29.97), not a clean 30. */
export const DEFAULT_FPS = 30000 / 1001

/**
 * Which frame is on screen at `time`.
 *
 * The epsilon matters: after seeking to a frame boundary, `currentTime` often
 * comes back a hair under it (0.0333329... for frame 1), and a bare floor would
 * report the previous frame and make stepping stall.
 */
export function frameAtTime(time: number, fps: number): number {
  return Math.max(0, Math.floor(time * fps + 1e-6))
}

/**
 * A `currentTime` that lands unambiguously *inside* frame `index` rather than on
 * its edge, which is what makes repeated stepping stable.
 */
export function timeAtFrame(index: number, fps: number): number {
  return (index + 0.5) / fps
}

/** Total frames in a clip. 0 while duration is still unknown (NaN/Infinity). */
export function frameCount(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(1, Math.round(duration * fps))
}

/** Clamp a frame index to the clip, so stepping stops at the ends instead of seeking out of range. */
export function clampFrame(index: number, duration: number, fps: number): number {
  const total = frameCount(duration, fps)
  if (total === 0) return 0
  return Math.min(Math.max(index, 0), total - 1)
}

/** `m:ss.cc` — short enough for a status line, precise enough to see single frames tick. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.00'
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const secs = whole % 60
  const centis = Math.floor((seconds - whole) * 100)
  return `${minutes}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
}
