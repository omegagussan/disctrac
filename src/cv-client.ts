/**
 * Main-thread handle for the CV worker. Keeps the postMessage plumbing and the
 * transfer detail in one place.
 */
import type { AnalysisOptions, CvRequest, CvResponse, Trace } from './cv-protocol.ts'

export interface AnalysisCallbacks {
  onProgress?(framesDone: number, framesTotal: number): void
  /** Fires once OpenCV's WASM runtime is up, before the first frame is decoded. */
  onReady?(version: string): void
}

export interface CvClient {
  /**
   * Analyse a whole clip and resolve with its flight path.
   *
   * `clip` is transferred to the worker, so the caller must not touch the buffer
   * afterwards — fetch a fresh copy for a second run.
   */
  analyse(clip: ArrayBuffer, options: AnalysisOptions, callbacks?: AnalysisCallbacks): Promise<Trace>
  terminate(): void
}

export function createCvClient(): CvClient {
  const worker = new Worker(new URL('./cv-worker.ts', import.meta.url), { type: 'module' })

  let settle: ((trace: Trace) => void) | null = null
  let reject: ((reason: Error) => void) | null = null
  let callbacks: AnalysisCallbacks = {}

  const finish = () => {
    settle = null
    reject = null
  }

  worker.onmessage = (event: MessageEvent<CvResponse>) => {
    const message = event.data
    switch (message.type) {
      case 'ready':
        callbacks.onReady?.(message.version)
        break
      case 'progress':
        callbacks.onProgress?.(message.framesDone, message.framesTotal)
        break
      case 'trace':
        settle?.(message.trace)
        finish()
        break
      case 'error':
        reject?.(new Error(message.message))
        finish()
        break
    }
  }

  // A worker that dies mid-analysis would otherwise leave the caller awaiting
  // a promise that can never settle.
  worker.onerror = (event) => {
    reject?.(new Error(event.message || 'the CV worker failed'))
    finish()
  }

  const request = (message: CvRequest, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer)

  return {
    analyse(clip, options, handlers = {}) {
      if (settle || reject) {
        return Promise.reject(new Error('an analysis is already running'))
      }
      callbacks = handlers
      const pending = new Promise<Trace>((resolve, rejectRun) => {
        settle = resolve
        reject = rejectRun
      })
      request({ type: 'analyse', clip, options }, [clip])
      return pending
    },

    terminate() {
      request({ type: 'dispose' })
      worker.terminate()
      reject?.(new Error('the CV worker was terminated'))
      finish()
    },
  }
}
