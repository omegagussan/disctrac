import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import type { FramePixels } from './floodFill.ts'

/**
 * Loading annotated fixture frames in tests.
 *
 * Decodes PNG directly rather than pulling in an image library or shelling out
 * to ffmpeg: the frames are committed, so the test must work anywhere Node runs,
 * including a CI runner with no ffmpeg. Only what ffmpeg emits is supported —
 * 8-bit, non-interlaced, RGB or RGBA.
 *
 * Test-only; nothing in the app imports this.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Paeth predictor, as defined by the PNG filter spec. */
function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft
  const distanceLeft = Math.abs(estimate - left)
  const distanceAbove = Math.abs(estimate - above)
  const distanceUpperLeft = Math.abs(estimate - upperLeft)
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left
  if (distanceAbove <= distanceUpperLeft) return above
  return upperLeft
}

export function decodePng(bytes: Buffer): FramePixels {
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (bytes[index] !== SIGNATURE[index]) throw new Error('not a PNG file')
  }

  let width = 0
  let height = 0
  let channels = 0
  const compressed: Buffer[] = []

  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const bitDepth = body[8]
      const colorType = body[9]
      const interlace = body[12]
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`)
      if (interlace !== 0) throw new Error('interlaced PNGs are not supported')
      if (colorType === 2) channels = 3
      else if (colorType === 6) channels = 4
      else throw new Error(`unsupported PNG colour type ${colorType}`)
    } else if (type === 'IDAT') {
      compressed.push(body)
    } else if (type === 'IEND') {
      break
    }

    // 4 length + 4 type + body + 4 CRC.
    offset += 12 + length
  }

  if (width === 0 || height === 0) throw new Error('PNG had no IHDR')

  const raw = inflateSync(Buffer.concat(compressed))
  const stride = width * channels
  const out = new Uint8ClampedArray(width * height * 4)
  // Filters reference the reconstructed previous scanline, not the raw one.
  const previous = new Uint8Array(stride)
  const current = new Uint8Array(stride)

  for (let y = 0; y < height; y += 1) {
    // Each scanline is prefixed with the filter type applied to it.
    const start = y * (stride + 1)
    const filter = raw[start]
    for (let x = 0; x < stride; x += 1) {
      const value = raw[start + 1 + x]
      const left = x >= channels ? current[x - channels] : 0
      const above = previous[x]
      const upperLeft = x >= channels ? previous[x - channels] : 0

      let reconstructed: number
      switch (filter) {
        case 0:
          reconstructed = value
          break
        case 1:
          reconstructed = value + left
          break
        case 2:
          reconstructed = value + above
          break
        case 3:
          reconstructed = value + ((left + above) >> 1)
          break
        case 4:
          reconstructed = value + paeth(left, above, upperLeft)
          break
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`)
      }
      current[x] = reconstructed & 0xff
    }

    for (let x = 0; x < width; x += 1) {
      const from = x * channels
      const to = (y * width + x) * 4
      out[to] = current[from]
      out[to + 1] = current[from + 1]
      out[to + 2] = current[from + 2]
      out[to + 3] = channels === 4 ? current[from + 3] : 255
    }
    previous.set(current)
  }

  return { width, height, data: out }
}

export function loadFixtureFrame(path: string): FramePixels {
  return decodePng(readFileSync(path))
}

export interface TruthFrame {
  frame: number
  phase: 'in-hand' | 'flight'
  disc: { x: number; y: number }
}

export interface TruthFile {
  clip: string
  frameDirectory: string
  frameWidth: number
  frameHeight: number
  annotation: { method: string; coordinateSpace: string; precisionPx: number }
  notes: string[]
  /** Every frame in this range is committed, so tracking runs at the real frame rate. */
  flightWindow: { startFrame: number; endFrame: number; note: string }
  frames: TruthFrame[]
}

export function loadTruth(path: string): TruthFile {
  return JSON.parse(readFileSync(path, 'utf8')) as TruthFile
}
