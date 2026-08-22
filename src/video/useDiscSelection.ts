import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { buildDiscColorModel, cropMaskedRegion } from './discModel.ts'
import type { CroppedRegion, DiscColorModel } from './discModel.ts'
import { floodFillMask, maskCentroid, unionMasks } from './floodFill.ts'
import type { FramePixels, Mask } from './floodFill.ts'
import type { ColorMetric, MetricName } from './metric.ts'
import { HSV_METRIC, metricByName } from './metric.ts'
import type { Point, Size } from './pointer.ts'
import { pointerToFramePoint } from './pointer.ts'

/** Pull the currently displayed frame out of the video as raw pixels. */
function captureFrame(video: HTMLVideoElement): FramePixels | null {
  const { videoWidth: width, videoHeight: height } = video
  if (!width || !height) return null

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  context.drawImage(video, 0, 0, width, height)
  // ImageData satisfies FramePixels structurally.
  return context.getImageData(0, 0, width, height)
}

interface SelectionResult {
  mask: Mask
  model: DiscColorModel
  region: CroppedRegion | null
}

export interface DiscSelection {
  /** null until the first sample is taken. */
  result: SelectionResult | null
  /** Frame size of the captured frame, for mapping pointer coordinates. */
  frameSize: Size | null
  tolerance: number
  /** How colour similarity is measured. Defaults to HSV for shade resilience. */
  metric: ColorMetric
  seedCount: number
  /** The points clicked, in captured-frame pixels. */
  seeds: Point[]
  /**
   * Centre of mass of the selection, in captured-frame pixels — where the disc
   * actually is, rather than where the click roughly landed.
   */
  discCentre: Point | null
  /** Playback position of the captured frame, in microseconds. */
  capturedAtUs: number | null
  /** Re-read the frame from the video — call when the displayed frame changes. */
  refreshFrame(): void
  /** Sample at a pointer position relative to the video element's top-left. */
  sampleAt(pointer: Point, elementSize: Size): void
  setTolerance(value: number): void
  /** Switching metric resets the tolerance, since the two scales are unrelated. */
  setMetric(name: MetricName): void
  clear(): void
}

/**
 * Accumulating state for picking a disc out of one frame.
 *
 * Seeds are kept rather than just the resulting mask, so changing the tolerance
 * re-runs the existing clicks instead of forcing the user to start over.
 */
export function useDiscSelection(videoRef: RefObject<HTMLVideoElement | null>): DiscSelection {
  const frameRef = useRef<FramePixels | null>(null)
  const [seeds, setSeeds] = useState<Point[]>([])
  // Mirrors `seeds` so refreshFrame can read them without a stale closure and
  // without running a side effect inside a state updater, which StrictMode would
  // invoke twice.
  const seedsRef = useRef<Point[]>([])
  const [metric, setMetricState] = useState<ColorMetric>(HSV_METRIC)
  const [tolerance, setToleranceState] = useState(HSV_METRIC.defaultTolerance)
  const [result, setResult] = useState<SelectionResult | null>(null)
  const [frameSize, setFrameSize] = useState<Size | null>(null)
  const [capturedAtUs, setCapturedAtUs] = useState<number | null>(null)
  const capturedAtRef = useRef<number | null>(null)

  const recompute = useCallback(
    (nextSeeds: Point[], nextTolerance: number, nextMetric: ColorMetric) => {
    const frame = frameRef.current
    if (!frame || nextSeeds.length === 0) {
      setResult(null)
      return
    }

    let mask: Mask | null = null
    for (const seed of nextSeeds) {
      const filled = floodFillMask(frame, seed.x, seed.y, nextTolerance, nextMetric)
      mask = mask ? unionMasks(mask, filled) : filled
    }
    if (!mask) {
      setResult(null)
      return
    }

    setResult({
      mask,
      model: buildDiscColorModel(frame, mask),
      region: cropMaskedRegion(frame, mask),
    })
    },
    [],
  )

  const refreshFrame = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const frame = captureFrame(video)
    if (!frame) return
    frameRef.current = frame
    setFrameSize({ width: frame.width, height: frame.height })

    const nowUs = video.currentTime * 1e6
    const movedToAnotherFrame =
      capturedAtRef.current !== null && Math.abs(capturedAtRef.current - nowUs) > 1
    capturedAtRef.current = nowUs
    // Recorded so an analysis can seed its track at the moment the disc was
    // actually identified, rather than guessing on the first frame.
    setCapturedAtUs(nowUs)

    // A selection describes one frame: its colours, its position and its
    // timestamp all come from the same picture. Keeping the clicks when the
    // frame changes pairs an old position with a new timestamp, and the tracker
    // cannot tell — it seeds where the disc *was*, misses immediately, and dies.
    if (movedToAnotherFrame && seedsRef.current.length > 0) {
      seedsRef.current = []
      setSeeds([])
      setResult(null)
      return
    }

    recompute(seedsRef.current, tolerance, metric)
  }, [metric, recompute, tolerance, videoRef])

  const sampleAt = useCallback(
    (pointer: Point, elementSize: Size) => {
      const frame = frameRef.current
      if (!frame) return
      const point = pointerToFramePoint(pointer, elementSize, {
        width: frame.width,
        height: frame.height,
      })
      // Clicks on the letterbox bars are not samples.
      if (!point) return

      const nextSeeds = [...seeds, point]
      seedsRef.current = nextSeeds
      setSeeds(nextSeeds)
      recompute(nextSeeds, tolerance, metric)
    },
    [metric, recompute, seeds, tolerance],
  )

  const setTolerance = useCallback(
    (value: number) => {
      setToleranceState(value)
      recompute(seeds, value, metric)
    },
    [metric, recompute, seeds],
  )

  const setMetric = useCallback(
    (name: MetricName) => {
      const next = metricByName(name)
      setMetricState(next)
      // A tolerance tuned for one space means something different in the other,
      // so carrying it across would silently widen or narrow the selection.
      setToleranceState(next.defaultTolerance)
      recompute(seeds, next.defaultTolerance, next)
    },
    [recompute, seeds],
  )

  const clear = useCallback(() => {
    seedsRef.current = []
    setSeeds([])
    setResult(null)
  }, [])

  return {
    result,
    frameSize,
    tolerance,
    metric,
    seedCount: seeds.length,
    seeds,
    discCentre: result ? maskCentroid(result.mask) : null,
    capturedAtUs,
    refreshFrame,
    sampleAt,
    setTolerance,
    setMetric,
    clear,
  }
}
