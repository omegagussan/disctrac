/**
 * Main-thread handle for the CV worker. Keeps the postMessage plumbing and the
 * frame-transfer detail in one place.
 */
import type { CvRequest, CvResponse, DiscDetection } from './cv-protocol.ts'

export interface CvClient {
  /** Resolves once the worker has a GPU device, or rejects with the worker's error. */
  ready: Promise<{ adapter: string }>
  /** Hands a decoded frame to the worker. Ownership transfers — do not use `frame` after this. */
  send(frame: VideoFrame, timestampUs: number): void
  terminate(): void
}

export interface CvClientOptions {
  width: number
  height: number
  onDetection(disc: DiscDetection | null, timestampUs: number, processingMs: number): void
  onError?(message: string): void
}

export function createCvClient(options: CvClientOptions): CvClient {
  const worker = new Worker(new URL('./cv-worker.ts', import.meta.url), { type: 'module' })

  let settle: ((value: { adapter: string }) => void) | null = null
  let reject: ((reason: Error) => void) | null = null
  const ready = new Promise<{ adapter: string }>((resolve, rejectReady) => {
    settle = resolve
    reject = rejectReady
  })

  worker.onmessage = (event: MessageEvent<CvResponse>) => {
    const message = event.data
    switch (message.type) {
      case 'ready':
        settle?.({ adapter: message.adapter })
        settle = null
        break
      case 'detection':
        options.onDetection(message.disc, message.timestampUs, message.processingMs)
        break
      case 'error':
        // An error before 'ready' means init never completed — fail the promise
        // rather than leaving callers awaiting forever.
        reject?.(new Error(message.message))
        reject = null
        options.onError?.(message.message)
        break
    }
  }

  const request = (message: CvRequest, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer)

  request({ type: 'init', width: options.width, height: options.height })

  return {
    ready,
    send(frame, timestampUs) {
      request({ type: 'frame', frame, timestampUs }, [frame])
    },
    terminate() {
      request({ type: 'dispose' })
      worker.terminate()
    },
  }
}
