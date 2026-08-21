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
