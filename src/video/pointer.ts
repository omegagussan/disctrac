/**
 * Mapping a click on the video element to a pixel in the frame.
 *
 * The video is laid out with `object-fit: contain`, so unless the clip's aspect
 * ratio happens to match the box exactly there are bars down the sides or along
 * the top. Ignoring them puts every sample in the wrong place, and the error
 * grows with distance from the centre — subtle enough to look like a flaky tool
 * rather than a coordinate bug.
 */

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/**
 * `pointer` is relative to the element's top-left corner. Returns null when the
 * click landed on a letterbox bar rather than on the picture.
 */
export function pointerToFramePoint(pointer: Point, element: Size, frame: Size): Point | null {
  if (element.width <= 0 || element.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return null
  }

  const scale = Math.min(element.width / frame.width, element.height / frame.height)
  const displayedWidth = frame.width * scale
  const displayedHeight = frame.height * scale
  const offsetX = (element.width - displayedWidth) / 2
  const offsetY = (element.height - displayedHeight) / 2

  const x = (pointer.x - offsetX) / scale
  const y = (pointer.y - offsetY) / scale

  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null
  return { x, y }
}

/**
 * How many element pixels one frame pixel occupies. The overlay needs this to
 * scale a radius as well as a position.
 */
export function frameToElementScale(element: Size, frame: Size): number {
  if (element.width <= 0 || element.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return 0
  }
  return Math.min(element.width / frame.width, element.height / frame.height)
}

/**
 * The inverse of {@link pointerToFramePoint}: frame pixel to a position relative
 * to the element's top-left corner, letterbox offset included.
 *
 * Used to draw detections back onto the video. Note the frame size passed here
 * is the *analysis* frame the detector worked in, which is smaller than the clip
 * — the scale factor absorbs that difference, so no separate rescale is needed.
 */
export function framePointToElement(point: Point, element: Size, frame: Size): Point | null {
  const scale = frameToElementScale(element, frame)
  if (scale === 0) return null
  return {
    x: point.x * scale + (element.width - frame.width * scale) / 2,
    y: point.y * scale + (element.height - frame.height * scale) / 2,
  }
}
