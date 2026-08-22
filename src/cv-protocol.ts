/**
 * Message protocol shared between the main thread and the CV worker.
 *
 * Both sides import these types so the postMessage boundary stays type-checked;
 * the worker runs under tsconfig.worker.json, the client under tsconfig.app.json.
 */
import type { Affine } from './video/affine.ts'
import type { DiscColorModel } from './video/discModel.ts'
import type { FlowSample } from './video/egoMotion.ts'

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
  /** Contours above this fraction of the frame are not a disc. */
  maxAreaFraction?: number
  /**
   * Where the disc was when the user picked it, normalised to 0..1 of the source
   * frame, plus when.
   *
   * Without this the tracker's first frame has no prediction and falls back to
   * the largest matching blob — which on real footage is a shirt or a patch of
   * sunlit grass, never the disc. Measured on the throw-02 fixture the disc runs
   * from 783px down to 23px while those distractors stay in the thousands.
   */
  seed?: { timestampUs: number; x: number; y: number }
}

/** Sent main thread -> worker. */
export type CvRequest =
  /** `clip` is transferred, not copied — the caller loses its buffer. */
  | { type: 'analyse'; clip: ArrayBuffer; options: AnalysisOptions }
  | { type: 'dispose' }

/**
 * One frame of the flight.
 *
 * Coordinates are **world** pixels — the analysis frame's coordinate system as
 * it stood on the first frame, with camera motion divided out. That is what
 * makes the motion model and any curve fitted to the path describe the disc
 * rather than the camera operator's arms.
 *
 * `toFrame` maps those world coordinates into this frame's screen position, so
 * the overlay can put the path back where the scene is now. Absent means camera
 * motion was not estimated and the coordinates are already screen positions.
 */
export interface TracePoint {
  frameIndex: number
  timestampUs: number
  /** Where the detector found the disc, or null if it didn't. */
  measured: { x: number; y: number } | null
  /** The filtered estimate — what the trace is drawn from. */
  filtered: { x: number; y: number }
  radius: number | null
  /** World to this frame's screen position. Absent when motion was not estimated. */
  toFrame?: Affine
  /**
   * The corners camera motion was estimated from, in this frame's screen
   * pixels. Sampled down, since these exist to be looked at rather than
   * computed with.
   */
  flow?: FlowSample[]
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
  /** Sparse optical flow and the affine fit, per frame. */
  motionMs: number
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
