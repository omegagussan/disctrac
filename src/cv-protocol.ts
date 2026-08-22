/**
 * Message protocol shared between the main thread and the CV worker.
 *
 * Both sides import these types so the postMessage boundary stays type-checked;
 * the worker runs under tsconfig.worker.json, the client under tsconfig.app.json.
 */
import type { DiscColorModel } from './video/discModel.ts'

export interface AnalysisOptions {
  /** The colours picked from a frame, used to threshold every frame. */
  model: DiscColorModel
  /** Colour tolerance, in the same units the picker uses. */
  tolerance: number
  /** Frames are downscaled to this width before detection. */
  analysisWidth: number
  /** Contours below this area are noise rather than a disc. */
  minArea?: number
  /** Diameter of the kernel used to open the mask. 0 disables it. */
  openKernel?: number
}

/** Sent main thread -> worker. */
export type CvRequest =
  /** `clip` is transferred, not copied — the caller loses its buffer. */
  | { type: 'analyse'; clip: ArrayBuffer; options: AnalysisOptions }
  | { type: 'dispose' }

/**
 * One frame of the flight.
 *
 * Coordinates are pixels **in the analysis frame**, whose size is reported
 * alongside. They are not normalised: the overlay maps them with the same
 * letterbox-aware helper it uses for clicks, and giving that helper the analysis
 * size is exact, where a normalise-then-rescale round trip is one more
 * convention to misread.
 */
export interface TracePoint {
  frameIndex: number
  timestampUs: number
  /** Where the detector found the disc, or null if it didn't. */
  measured: { x: number; y: number } | null
  /** The filtered estimate — what the trace is drawn from. */
  filtered: { x: number; y: number }
  radius: number | null
  occluded: boolean
  /** The measurement was inconsistent enough with the physics to look like a tree strike. */
  gated: boolean
  /** The filter had no usable estimate for this frame. */
  lost: boolean
}

/** Where the analysis time went, per stage, summed over the clip. */
export interface StageTimings {
  frames: number
  /** Drawing each frame into the analysis canvas and reading the pixels back. */
  readbackMs: number
  /** Threshold, morphology and contours. */
  detectMs: number
  /** Kalman prediction, association and update. */
  trackMs: number
  /** Wall-clock for the whole pass, including decode. */
  totalMs: number
}

export interface Trace {
  points: TracePoint[]
  analysisWidth: number
  analysisHeight: number
  sourceWidth: number
  sourceHeight: number
  /** Seconds per frame, measured from the decoded timestamps rather than assumed. */
  dt: number
  timings: StageTimings
}

/** Sent worker -> main thread. */
export type CvResponse =
  | { type: 'ready'; backend: 'opencv'; version: string }
  | { type: 'progress'; framesDone: number; framesTotal: number }
  | { type: 'trace'; trace: Trace }
  | { type: 'error'; message: string }
