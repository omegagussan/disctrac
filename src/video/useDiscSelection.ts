import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { buildDiscColorModel, cropMaskedRegion } from './discModel.ts'
import type { CroppedRegion, DiscColorModel } from './discModel.ts'
import { DEFAULT_TOLERANCE, floodFillMask, unionMasks } from './floodFill.ts'
import type { FramePixels, Mask } from './floodFill.ts'
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
  seedCount: number
  /** Re-read the frame from the video — call when the displayed frame changes. */
  refreshFrame(): void
  /** Sample at a pointer position relative to the video element's top-left. */
  sampleAt(pointer: Point, elementSize: Size): void
  setTolerance(value: number): void
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
  const [tolerance, setToleranceState] = useState(DEFAULT_TOLERANCE)
  const [result, setResult] = useState<SelectionResult | null>(null)
  const [frameSize, setFrameSize] = useState<Size | null>(null)

  const recompute = useCallback((nextSeeds: Point[], nextTolerance: number) => {
    const frame = frameRef.current
    if (!frame || nextSeeds.length === 0) {
      setResult(null)
      return
    }

    let mask: Mask | null = null
    for (const seed of nextSeeds) {
      const filled = floodFillMask(frame, seed.x, seed.y, nextTolerance)
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
  }, [])

  const refreshFrame = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const frame = captureFrame(video)
    if (!frame) return
    frameRef.current = frame
    setFrameSize({ width: frame.width, height: frame.height })
    // The same seeds still point at the same places on the new frame.
    recompute(seedsRef.current, tolerance)
  }, [recompute, tolerance, videoRef])

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
      recompute(nextSeeds, tolerance)
    },
    [recompute, seeds, tolerance],
  )

  const setTolerance = useCallback(
    (value: number) => {
      setToleranceState(value)
      recompute(seeds, value)
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
    seedCount: seeds.length,
    refreshFrame,
    sampleAt,
    setTolerance,
    clear,
  }
}
