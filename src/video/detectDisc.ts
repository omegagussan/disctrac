import type { Mat } from '@techstark/opencv-js'
import type { FramePixels } from './floodFill.ts'
import type { CvHsvRange } from './hsvBounds.ts'
import type { OpenCv } from './opencv.ts'
import type { Candidate } from './tracker.ts'

/**
 * Turning one frame of pixels into disc candidates, via OpenCV.
 *
 * DOM-free on purpose: it takes a plain pixel buffer rather than an ImageData or
 * a canvas, so the whole detection path can be exercised in Node against the
 * real OpenCV build. Only the demux/decode glue around it needs a browser.
 *
 * OpenCV.js does not garbage-collect Mats. Every Mat here is either reused
 * across frames or deleted in a finally block; a leak inside a 330-frame loop
 * exhausts the WASM heap rather than slowing down gracefully.
 */

export interface DiscDetectorOptions {
  /** Contours below this area are compression noise, not a disc. */
  minArea?: number
  /** Diameter of the elliptical kernel used to open the mask. 0 disables it. */
  openKernel?: number
}

export interface FrameDetection {
  candidates: Candidate[]
  /** Pixels passing the colour threshold, after morphology. Useful for tuning. */
  maskedPixels: number
}

export interface DiscDetector {
  detect(frame: FramePixels, ranges: CvHsvRange[]): FrameDetection
  dispose(): void
}

export const DEFAULT_OPEN_KERNEL = 3

export function createDiscDetector(
  cv: OpenCv,
  options: DiscDetectorOptions = {},
): DiscDetector {
  const minArea = options.minArea ?? 12
  const kernelSize = options.openKernel ?? DEFAULT_OPEN_KERNEL

  // Scratch buffers, allocated on the first frame and reused after. Reallocating
  // per frame would dominate the per-frame cost.
  let source: Mat | null = null
  let hsv: Mat | null = null
  let mask: Mat | null = null
  let channel: Mat | null = null
  let kernel: Mat | null = null
  let width = 0
  let height = 0

  const allocate = (frameWidth: number, frameHeight: number) => {
    release()
    source = new cv.Mat(frameHeight, frameWidth, cv.CV_8UC4)
    hsv = new cv.Mat(frameHeight, frameWidth, cv.CV_8UC3)
    mask = new cv.Mat(frameHeight, frameWidth, cv.CV_8UC1)
    channel = new cv.Mat(frameHeight, frameWidth, cv.CV_8UC1)
    kernel =
      kernelSize > 0
        ? cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize, kernelSize))
        : null
    width = frameWidth
    height = frameHeight
  }

  const release = () => {
    for (const mat of [source, hsv, mask, channel, kernel]) mat?.delete()
    source = null
    hsv = null
    mask = null
    channel = null
    kernel = null
  }

  return {
    detect(frame, ranges): FrameDetection {
      if (frame.width !== width || frame.height !== height || !source) {
        allocate(frame.width, frame.height)
      }
      const src = source!
      const hsvMat = hsv!
      const maskMat = mask!
      const channelMat = channel!

      src.data.set(frame.data)
      // COLOR_RGB2HSV on 8-bit data yields H in 0..179, which is the scale
      // hsvBounds.ts converts into. Going via RGB drops the alpha channel.
      cv.cvtColor(src, hsvMat, cv.COLOR_RGBA2RGB)
      cv.cvtColor(hsvMat, hsvMat, cv.COLOR_RGB2HSV)

      maskMat.setTo(new cv.Scalar(0))
      for (const range of ranges) {
        const lower = new cv.Mat(frame.height, frame.width, hsvMat.type(), [
          range.lower[0],
          range.lower[1],
          range.lower[2],
          0,
        ])
        const upper = new cv.Mat(frame.height, frame.width, hsvMat.type(), [
          range.upper[0],
          range.upper[1],
          range.upper[2],
          0,
        ])
        try {
          cv.inRange(hsvMat, lower, upper, channelMat)
          // OR rather than replace: a multi-coloured disc needs every mode, and a
          // hue band crossing the 0/179 seam arrives here as two ranges.
          cv.bitwise_or(maskMat, channelMat, maskMat)
        } finally {
          lower.delete()
          upper.delete()
        }
      }

      if (kernel) {
        cv.morphologyEx(maskMat, maskMat, cv.MORPH_OPEN, kernel)
      }

      const contours = new cv.MatVector()
      const hierarchy = new cv.Mat()
      const candidates: Candidate[] = []
      try {
        cv.findContours(maskMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
        for (let index = 0; index < contours.size(); index += 1) {
          const contour = contours.get(index)
          try {
            const area = cv.contourArea(contour)
            if (area < minArea) continue
            const moments = cv.moments(contour)
            // A zero zeroth moment means a degenerate contour with no interior;
            // dividing by it would yield NaN coordinates.
            if (moments.m00 === 0) continue
            candidates.push({
              x: moments.m10 / moments.m00,
              y: moments.m01 / moments.m00,
              area,
              radius: Math.sqrt(area / Math.PI),
            })
          } finally {
            contour.delete()
          }
        }
      } finally {
        contours.delete()
        hierarchy.delete()
      }

      return { candidates, maskedPixels: cv.countNonZero(maskMat) }
    },

    dispose: release,
  }
}
