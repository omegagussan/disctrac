import type { Lab } from './color.ts'
import { labDistance, srgbToOklab } from './color.ts'
import type { FramePixels, Mask } from './floodFill.ts'

/** One colour cluster within the selection. */
export interface ColorMode {
  lab: Lab
  /** Share of selected pixels in this mode, 0..1. */
  weight: number
  /** Mean OKLab distance of members from the centre — how tight the cluster is. */
  spread: number
}

/**
 * A disc described as several colour modes rather than one average.
 *
 * Averaging a two-tone disc yields a colour that appears nowhere on it — a white
 * disc with a red stamp averages to pink, which matches neither part and matches
 * plenty of background. Keeping the modes separate is what makes the description
 * usable by a detector.
 */
export interface DiscColorModel {
  modes: ColorMode[]
  pixelCount: number
}

export interface DiscModelOptions {
  /** Upper bound on modes before merging. */
  maxModes?: number
  /** Centres closer than this in OKLab are merged. */
  minSeparation?: number
  /** Modes holding less than this share of pixels are dropped as noise. */
  minWeight?: number
}

const DEFAULTS = { maxModes: 4, minSeparation: 0.08, minWeight: 0.02 }

/** Collect the OKLab colour of every selected pixel. */
export function maskedLabs(frame: FramePixels, mask: Mask): Lab[] {
  const labs: Lab[] = []
  for (let index = 0; index < mask.data.length; index += 1) {
    if (mask.data[index] !== 1) continue
    const pixel = index * 4
    labs.push(srgbToOklab(frame.data[pixel], frame.data[pixel + 1], frame.data[pixel + 2]))
  }
  return labs
}

function mean(labs: Lab[]): Lab {
  let L = 0
  let a = 0
  let b = 0
  for (const lab of labs) {
    L += lab.L
    a += lab.a
    b += lab.b
  }
  return { L: L / labs.length, a: a / labs.length, b: b / labs.length }
}

/**
 * Deterministic seeding: start at the overall mean, then repeatedly take the
 * point furthest from everything chosen so far.
 *
 * Random k-means++ seeding would make the same click produce different modes on
 * different runs, which is both confusing in the UI and untestable.
 */
function initialCentres(labs: Lab[], k: number): Lab[] {
  const centres: Lab[] = [mean(labs)]
  while (centres.length < k) {
    let furthest = labs[0]
    let furthestDistance = -1
    for (const lab of labs) {
      let nearest = Infinity
      for (const centre of centres) {
        const distance = labDistance(lab, centre)
        if (distance < nearest) nearest = distance
      }
      if (nearest > furthestDistance) {
        furthestDistance = nearest
        furthest = lab
      }
    }
    // Every remaining point coincides with a centre — more clusters would be empty.
    if (furthestDistance <= 0) break
    centres.push(furthest)
  }
  return centres
}

function assign(labs: Lab[], centres: Lab[]): number[] {
  return labs.map((lab) => {
    let best = 0
    let bestDistance = Infinity
    for (let index = 0; index < centres.length; index += 1) {
      const distance = labDistance(lab, centres[index])
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    return best
  })
}

/** Lloyd's algorithm, capped — the centres stop moving meaningfully well before this. */
function kMeans(labs: Lab[], k: number, maxIterations = 24): Lab[][] {
  let centres = initialCentres(labs, k)
  let groups: Lab[][] = []

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const assignments = assign(labs, centres)
    groups = centres.map(() => [])
    assignments.forEach((group, index) => groups[group].push(labs[index]))

    const next = groups.map((group, index) => (group.length > 0 ? mean(group) : centres[index]))
    const settled = next.every((centre, index) => labDistance(centre, centres[index]) < 1e-4)
    centres = next
    if (settled) break
  }

  return groups.filter((group) => group.length > 0)
}

function toMode(group: Lab[], total: number): ColorMode {
  const centre = mean(group)
  const spread = group.reduce((sum, lab) => sum + labDistance(lab, centre), 0) / group.length
  return { lab: centre, weight: group.length / total, spread }
}

/** Merge modes whose centres sit closer than `minSeparation`, weighting by size. */
function mergeNearby(modes: ColorMode[], minSeparation: number): ColorMode[] {
  const merged = [...modes]
  let didMerge = true

  while (didMerge && merged.length > 1) {
    didMerge = false
    outer: for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        if (labDistance(merged[i].lab, merged[j].lab) >= minSeparation) continue
        const first = merged[i]
        const second = merged[j]
        const weight = first.weight + second.weight
        const share = weight > 0 ? first.weight / weight : 0.5
        merged[i] = {
          lab: {
            L: first.lab.L * share + second.lab.L * (1 - share),
            a: first.lab.a * share + second.lab.a * (1 - share),
            b: first.lab.b * share + second.lab.b * (1 - share),
          },
          weight,
          spread: first.spread * share + second.spread * (1 - share),
        }
        merged.splice(j, 1)
        didMerge = true
        break outer
      }
    }
  }

  return merged
}

export function buildDiscColorModel(
  frame: FramePixels,
  mask: Mask,
  options: DiscModelOptions = {},
): DiscColorModel {
  const { maxModes, minSeparation, minWeight } = { ...DEFAULTS, ...options }
  const labs = maskedLabs(frame, mask)
  if (labs.length === 0) return { modes: [], pixelCount: 0 }

  const groups = kMeans(labs, Math.max(1, Math.min(maxModes, labs.length)))
  const modes = mergeNearby(
    groups.map((group) => toMode(group, labs.length)),
    minSeparation,
  )

  const kept = modes.filter((mode) => mode.weight >= minWeight)
  // Never return nothing: if every mode is below the floor, keep the largest.
  const surviving = kept.length > 0 ? kept : [modes.reduce((a, b) => (a.weight >= b.weight ? a : b))]

  return {
    modes: surviving.sort((a, b) => b.weight - a.weight),
    pixelCount: labs.length,
  }
}

export interface CroppedRegion {
  width: number
  height: number
  /**
   * RGBA; alpha is 0 outside the mask so the cutout shows the disc alone.
   *
   * Pinned to `ArrayBuffer` rather than the default `ArrayBufferLike`, because
   * the `ImageData` constructor rejects a possibly-shared buffer.
   */
  data: Uint8ClampedArray<ArrayBuffer>
}

/** Cut the selection out of the frame, cropped to its bounds. */
export function cropMaskedRegion(frame: FramePixels, mask: Mask): CroppedRegion | null {
  if (!mask.bounds || mask.pixelCount === 0) return null
  const { minX, minY, maxX, maxY } = mask.bounds
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const data = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y + minY) * frame.width + (x + minX)
      const target = (y * width + x) * 4
      if (mask.data[source] !== 1) continue
      data[target] = frame.data[source * 4]
      data[target + 1] = frame.data[source * 4 + 1]
      data[target + 2] = frame.data[source * 4 + 2]
      data[target + 3] = 255
    }
  }

  return { width, height, data }
}
