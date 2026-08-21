import type { ColorMetric } from './metric.ts'
import { OKLAB_METRIC } from './metric.ts'

/**
 * The RGBA pixel buffer of one frame.
 *
 * Structural rather than the DOM `ImageData` class so tests can hand in a plain
 * object and run in Node without a jsdom shim.
 */
export interface FramePixels {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray | Uint8Array
}

/** Inclusive pixel bounds. */
export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Mask {
  width: number
  height: number
  /** 1 = selected. One byte per pixel. */
  data: Uint8Array
  pixelCount: number
  /** null when nothing is selected. */
  bounds: Bounds | null
}

/** OKLab's default. Each metric carries its own — see `ColorMetric.defaultTolerance`. */
export const DEFAULT_TOLERANCE = OKLAB_METRIC.defaultTolerance

export function emptyMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height), pixelCount: 0, bounds: null }
}

/**
 * Grow a region outward from (seedX, seedY), taking every 4-connected pixel
 * within `tolerance` of the seed colour, as measured by `metric`.
 *
 * Comparing against the seed rather than each pixel's neighbour is the important
 * choice here: neighbour-comparison creeps along gradients and will happily
 * escape a disc into the grass behind it, one imperceptible step at a time.
 * The cost is that one fill captures one colour region — which is exactly why
 * the disc model is built from a union of several fills.
 */
export function floodFillMask(
  frame: FramePixels,
  seedX: number,
  seedY: number,
  tolerance: number = DEFAULT_TOLERANCE,
  metric: ColorMetric = OKLAB_METRIC,
): Mask {
  const { width, height, data } = frame
  const x = Math.floor(seedX)
  const y = Math.floor(seedY)
  if (x < 0 || y < 0 || x >= width || y >= height) return emptyMask(width, height)

  const mask = new Uint8Array(width * height)
  // Separate from `mask` so every pixel is colour-tested exactly once. Marking
  // rejections only in `mask` would let each accepted neighbour re-push the same
  // rejected boundary pixel.
  const visited = new Uint8Array(width * height)

  const seedIndex = y * width + x
  const seedColor = metric.project(
    data[seedIndex * 4],
    data[seedIndex * 4 + 1],
    data[seedIndex * 4 + 2],
  )

  const withinTolerance = (index: number) => {
    const pixel = index * 4
    const color = metric.project(data[pixel], data[pixel + 1], data[pixel + 2])
    return metric.distance(color, seedColor) <= tolerance
  }

  let minX = x
  let maxX = x
  let minY = y
  let maxY = y
  let pixelCount = 0

  // An explicit stack, because recursion blows the call stack on a region the
  // size of a 720p frame.
  const stack: number[] = [seedIndex]
  visited[seedIndex] = 1
  mask[seedIndex] = 1

  while (stack.length > 0) {
    const index = stack.pop()!

    pixelCount += 1
    const px = index % width
    const py = (index - px) / width
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py

    // 4-connectivity: diagonal-only contact does not join two regions.
    const neighbours = [
      px > 0 ? index - 1 : -1,
      px + 1 < width ? index + 1 : -1,
      py > 0 ? index - width : -1,
      py + 1 < height ? index + width : -1,
    ]
    for (const neighbour of neighbours) {
      if (neighbour < 0 || visited[neighbour] === 1) continue
      visited[neighbour] = 1
      if (withinTolerance(neighbour)) {
        mask[neighbour] = 1
        stack.push(neighbour)
      }
    }
  }

  if (pixelCount === 0) return emptyMask(width, height)
  return { width, height, data: mask, pixelCount, bounds: { minX, minY, maxX, maxY } }
}

/** Combine two masks of the same size. Used to accumulate several clicks into one selection. */
export function unionMasks(first: Mask, second: Mask): Mask {
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error('cannot union masks of different sizes')
  }
  const data = new Uint8Array(first.data.length)
  let pixelCount = 0
  for (let index = 0; index < data.length; index += 1) {
    if (first.data[index] === 1 || second.data[index] === 1) {
      data[index] = 1
      pixelCount += 1
    }
  }
  return {
    width: first.width,
    height: first.height,
    data,
    pixelCount,
    bounds: mergeBounds(first.bounds, second.bounds),
  }
}

export function mergeBounds(first: Bounds | null, second: Bounds | null): Bounds | null {
  if (!first) return second
  if (!second) return first
  return {
    minX: Math.min(first.minX, second.minX),
    minY: Math.min(first.minY, second.minY),
    maxX: Math.max(first.maxX, second.maxX),
    maxY: Math.max(first.maxY, second.maxY),
  }
}
