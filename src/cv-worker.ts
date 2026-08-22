/**
 * Batch analysis worker: decode a clip, find the disc in every frame, and track
 * it into a flight path.
 *
 * Deliberately thin. Everything with a decision in it lives in src/video/ as
 * pure or cv-injected functions that run under Vitest; what remains here is
 * demux, decode and canvas glue that only a browser can exercise.
 *
 * Spawn it through src/cv-client.ts rather than constructing it directly.
 */
import { MP4BoxBuffer, createFile } from 'mp4box'
import type { AnalysisOptions, CvResponse, StageTimings, TracePoint } from './cv-protocol.ts'
import type { CvRequest } from './cv-protocol.ts'
import { createDiscDetector } from './video/detectDisc.ts'
import { modelToHsvBounds } from './video/hsvBounds.ts'
import { openCvReady } from './video/opencv.ts'
import type { Candidate } from './video/tracker.ts'
import { createTracker } from './video/tracker.ts'

const ctx = self as unknown as DedicatedWorkerGlobalScope

function post(message: CvResponse) {
  ctx.postMessage(message)
}

function fail(context: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  post({ type: 'error', message: `${context}: ${detail}` })
}

/** The subset of an avcC box needed to rebuild its payload. */
interface AvcConfig {
  configurationVersion: number
  AVCProfileIndication: number
  profile_compatibility: number
  AVCLevelIndication: number
  lengthSizeMinusOne: number
  SPS: { data: Uint8Array }[]
  PPS: { data: Uint8Array }[]
}

/**
 * Rebuild the AVCDecoderConfigurationRecord that `VideoDecoder` needs as its
 * `description`.
 *
 * Built from mp4box's parsed fields rather than sliced out of the file by byte
 * offset: the offsets depend on how the box reports its own header size, and
 * getting that subtly wrong yields a decoder that configures and then emits
 * garbage. MP4 samples are length-prefixed, not Annex B, so this record is not
 * optional.
 */
function serialiseAvcConfig(config: AvcConfig): Uint8Array {
  const bytes: number[] = [
    config.configurationVersion,
    config.AVCProfileIndication,
    config.profile_compatibility,
    config.AVCLevelIndication,
    // Six reserved bits set, then the NAL length size.
    0xfc | (config.lengthSizeMinusOne & 0x03),
    // Three reserved bits set, then the SPS count.
    0xe0 | (config.SPS.length & 0x1f),
  ]

  const appendParameterSets = (sets: { data: Uint8Array }[]) => {
    for (const set of sets) {
      bytes.push((set.data.length >> 8) & 0xff, set.data.length & 0xff, ...set.data)
    }
  }

  appendParameterSets(config.SPS)
  bytes.push(config.PPS.length & 0xff)
  appendParameterSets(config.PPS)

  return new Uint8Array(bytes)
}

interface SampleEntryWithAvc {
  avcC?: AvcConfig
}

function describeTrack(file: ReturnType<typeof createFile>, trackId: number): Uint8Array {
  const trak = file.getTrackById(trackId) as unknown as {
    mdia?: { minf?: { stbl?: { stsd?: { entries?: SampleEntryWithAvc[] } } } }
  }
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? []
  for (const entry of entries) {
    if (entry.avcC) return serialiseAvcConfig(entry.avcC)
  }
  throw new Error('no avcC configuration found — is this an H.264 clip?')
}

interface FrameDetections {
  timestampUs: number
  candidates: Candidate[]
}

async function analyse(clip: ArrayBuffer, options: AnalysisOptions) {
  const startedAt = performance.now()
  const cv = await openCvReady()
  post({ type: 'ready', backend: 'opencv', version: 'opencv.js' })

  const ranges = modelToHsvBounds(options.model.modes, options.tolerance)
  if (ranges.length === 0) {
    throw new Error('the colour model has no modes, so there is nothing to threshold on')
  }

  const detector = createDiscDetector(cv, {
    minArea: options.minArea,
    openKernel: options.openKernel,
  })

  const timings: StageTimings = { frames: 0, readbackMs: 0, detectMs: 0, trackMs: 0, totalMs: 0 }
  const detections: FrameDetections[] = []
  let canvas: OffscreenCanvas | null = null
  let context: OffscreenCanvasRenderingContext2D | null = null
  let analysisWidth = 0
  let analysisHeight = 0
  let sourceWidth = 0
  let sourceHeight = 0
  let framesTotal = 0

  const onFrame = (frame: VideoFrame) => {
    try {
      if (!canvas || !context) {
        sourceWidth = frame.displayWidth
        sourceHeight = frame.displayHeight
        // Never upscale: analysing more pixels than the clip has is pure cost.
        const scale = Math.min(1, options.analysisWidth / sourceWidth)
        analysisWidth = Math.max(1, Math.round(sourceWidth * scale))
        analysisHeight = Math.max(1, Math.round(sourceHeight * scale))
        canvas = new OffscreenCanvas(analysisWidth, analysisHeight)
        context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('could not get a 2D context in the worker')
      }

      const beforeReadback = performance.now()
      // The browser does the downscale on the way in, which is the cheap place
      // for it; only the reduced frame is ever read back to the CPU.
      context.drawImage(frame, 0, 0, analysisWidth, analysisHeight)
      const pixels = context.getImageData(0, 0, analysisWidth, analysisHeight)

      const beforeDetect = performance.now()
      const { candidates } = detector.detect(pixels, ranges)
      const afterDetect = performance.now()

      timings.readbackMs += beforeDetect - beforeReadback
      timings.detectMs += afterDetect - beforeDetect
      timings.frames += 1

      detections.push({ timestampUs: frame.timestamp, candidates })

      if (timings.frames % 15 === 0) {
        post({ type: 'progress', framesDone: timings.frames, framesTotal })
      }
    } finally {
      // Releasing promptly keeps the decoder's frame pool from starving.
      frame.close()
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const decoder = new VideoDecoder({
        output: onFrame,
        error: (cause) => reject(cause instanceof Error ? cause : new Error(String(cause))),
      })
      const file = createFile()

      file.onError = (message: string) => reject(new Error(`demux failed: ${message}`))

      file.onReady = (info) => {
        const track = info.videoTracks[0]
        if (!track) {
          reject(new Error('the clip has no video track'))
          return
        }
        framesTotal = track.nb_samples
        try {
          decoder.configure({ codec: track.codec, description: describeTrack(file, track.id) })
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error(String(cause)))
          return
        }
        file.setExtractionOptions(track.id, null, { nbSamples: 100 })
        file.start()
      }

      file.onSamples = (_id, _user, samples) => {
        for (const sample of samples) {
          if (!sample.data) continue
          decoder.decode(
            new EncodedVideoChunk({
              type: sample.is_sync ? 'key' : 'delta',
              timestamp: (sample.cts * 1e6) / sample.timescale,
              duration: (sample.duration * 1e6) / sample.timescale,
              data: sample.data,
            }),
          )
        }
      }

      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(clip, 0))
      file.flush()
      decoder
        .flush()
        .then(() => {
          decoder.close()
          resolve()
        })
        .catch(reject)
    })

    if (detections.length === 0) {
      throw new Error('the clip decoded no frames')
    }

    // Decode order is not presentation order once B-frames are involved, and
    // tracking is meaningless out of order. Detection is per-frame independent,
    // so sorting afterwards costs nothing and avoids reordering during decode.
    detections.sort((first, second) => first.timestampUs - second.timestampUs)

    // Measure the frame period rather than assuming a frame rate.
    const span = detections[detections.length - 1].timestampUs - detections[0].timestampUs
    const dt = detections.length > 1 ? span / (detections.length - 1) / 1e6 : 1 / 30

    const beforeTrack = performance.now()
    const tracker = createTracker({ minArea: options.minArea, kalman: { dt } })
    const points: TracePoint[] = detections.map((detection, index) => {
      const point = tracker.process(index, detection.timestampUs, detection.candidates)
      return {
        frameIndex: point.frameIndex,
        timestampUs: point.timestampUs,
        measured: point.measured,
        filtered: point.filtered,
        radius: point.radius,
        occluded: point.occluded,
        gated: point.gated,
        lost: point.lost,
      }
    })
    timings.trackMs = performance.now() - beforeTrack
    timings.totalMs = performance.now() - startedAt

    post({
      type: 'trace',
      trace: {
        points,
        analysisWidth,
        analysisHeight,
        sourceWidth,
        sourceHeight,
        dt,
        timings,
      },
    })
  } finally {
    detector.dispose()
  }
}

ctx.onmessage = (event: MessageEvent<CvRequest>) => {
  const message = event.data
  switch (message.type) {
    case 'analyse':
      analyse(message.clip, message.options).catch((cause) => fail('analysis failed', cause))
      break
    case 'dispose':
      close()
      break
  }
}
