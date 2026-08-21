import type { FramePixels } from './floodFill.ts'

/**
 * Build a frame pixel-by-pixel. Test-only helper; nothing in the app imports it.
 */
export function makeFrame(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => [number, number, number],
): FramePixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const [r, g, b] = colorAt(x, y)
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = 255
    }
  }
  return { width, height, data }
}

export const WHITE: [number, number, number] = [255, 255, 255]
export const RED: [number, number, number] = [255, 0, 0]
export const GRASS: [number, number, number] = [110, 124, 62]
export const ORANGE: [number, number, number] = [230, 120, 30]
