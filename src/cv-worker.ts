/**
 * Heavy-lifting worker: owns the GPU device and does per-frame disc detection off
 * the main thread, so dropping a frame never janks the UI.
 *
 * Spawn it through `src/cv-client.ts` rather than constructing it directly.
 */
import type { CvRequest, CvResponse } from './cv-protocol.ts'

const ctx = self as unknown as DedicatedWorkerGlobalScope

let device: GPUDevice | null = null
/** Landing pad for the current frame's pixels; reallocated only if dimensions change. */
let frameTexture: GPUTexture | null = null
let frameSize: { width: number; height: number } | null = null

function post(message: CvResponse) {
  ctx.postMessage(message)
}

function fail(context: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  post({ type: 'error', message: `${context}: ${detail}` })
}

async function init(width: number, height: number) {
  if (!navigator.gpu) {
    throw new Error('WebGPU is unavailable in this worker (navigator.gpu is undefined)')
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) {
    throw new Error('no suitable GPU adapter — requestAdapter() returned null')
  }

  device = await adapter.requestDevice()
  // A lost device invalidates every handle we hold; surface it instead of failing
  // opaquely on the next frame.
  device.lost.then((info) => {
    device = null
    frameTexture = null
    frameSize = null
    post({ type: 'error', message: `GPU device lost (${info.reason}): ${info.message}` })
  })

  allocate(width, height)

  const { vendor, architecture, description } = adapter.info
  post({
    type: 'ready',
    backend: 'webgpu',
    adapter: description || [vendor, architecture].filter(Boolean).join(' ') || 'unknown',
  })
}

function allocate(width: number, height: number) {
  if (!device) return
  frameTexture?.destroy()
  frameTexture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT,
  })
  frameSize = { width, height }
}

function handleFrame(frame: VideoFrame, timestampUs: number) {
  const startedAt = performance.now()
  try {
    if (!device || !frameTexture || !frameSize) {
      throw new Error("received 'frame' before a successful 'init'")
    }

    const width = frame.displayWidth
    const height = frame.displayHeight
    if (width !== frameSize.width || height !== frameSize.height) {
      allocate(width, height)
    }

    device.queue.copyExternalImageToTexture(
      { source: frame },
      { texture: frameTexture! },
      [width, height],
    )

    // TODO: the actual detection. Bind `frameTexture` into a compute pass that
    // thresholds/segments the disc, read the centroid back through a mapped
    // staging buffer, and report it below instead of `null`.
    post({
      type: 'detection',
      timestampUs,
      disc: null,
      processingMs: performance.now() - startedAt,
    })
  } finally {
    // We own the transferred frame — releasing it promptly keeps the decoder's
    // pool from starving.
    frame.close()
  }
}

function dispose() {
  frameTexture?.destroy()
  frameTexture = null
  frameSize = null
  device?.destroy()
  device = null
}

ctx.onmessage = (event: MessageEvent<CvRequest>) => {
  const message = event.data
  switch (message.type) {
    case 'init':
      init(message.width, message.height).catch((cause) => fail('init failed', cause))
      break
    case 'frame':
      try {
        handleFrame(message.frame, message.timestampUs)
      } catch (cause) {
        fail('frame processing failed', cause)
      }
      break
    case 'dispose':
      dispose()
      break
  }
}
