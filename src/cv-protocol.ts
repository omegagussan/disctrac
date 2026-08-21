/**
 * Message protocol shared between the main thread and the CV worker.
 *
 * Both sides import these types so the postMessage boundary stays type-checked;
 * the worker runs under tsconfig.worker.json, the client under tsconfig.app.json.
 */

/** Sent main thread -> worker. */
export type CvRequest =
  | { type: 'init'; width: number; height: number }
  /** `frame` is transferred, not copied. The worker takes ownership and closes it. */
  | { type: 'frame'; frame: VideoFrame; timestampUs: number }
  | { type: 'dispose' }

/** A single disc candidate, in normalised [0,1] frame coordinates. */
export interface DiscDetection {
  x: number
  y: number
  /** Fraction of frame width. */
  radius: number
  /** 0..1 */
  confidence: number
}

/** Sent worker -> main thread. */
export type CvResponse =
  | { type: 'ready'; backend: 'webgpu'; adapter: string }
  | {
      type: 'detection'
      timestampUs: number
      /** null when no disc was found in this frame. */
      disc: DiscDetection | null
      /** Wall-clock time the worker spent on this frame. */
      processingMs: number
    }
  | { type: 'error'; message: string }
