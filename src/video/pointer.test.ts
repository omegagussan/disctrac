import { describe, expect, it } from 'vitest'
import { frameToElementScale, framePointToElement, pointerToFramePoint } from './pointer.ts'

const HD = { width: 1280, height: 720 }

describe('pointerToFramePoint', () => {
  it('maps a click straight through when the box matches the clip', () => {
    const point = pointerToFramePoint({ x: 640, y: 360 }, HD, HD)
    expect(point).toEqual({ x: 640, y: 360 })
  })

  it('scales a click when the box is smaller than the clip', () => {
    // Half-size box, same aspect ratio.
    const point = pointerToFramePoint({ x: 320, y: 180 }, { width: 640, height: 360 }, HD)
    expect(point).toEqual({ x: 640, y: 360 })
  })

  describe('with horizontal bars (box taller than the clip)', () => {
    // 1280x900 box holding a 16:9 clip: 90px bars top and bottom.
    const element = { width: 1280, height: 900 }

    it('finds the centre of the picture, not the centre of the box', () => {
      expect(pointerToFramePoint({ x: 640, y: 450 }, element, HD)).toEqual({ x: 640, y: 360 })
    })

    it('maps the top edge of the picture to y=0', () => {
      expect(pointerToFramePoint({ x: 0, y: 90 }, element, HD)).toEqual({ x: 0, y: 0 })
    })

    it('rejects a click on the upper bar', () => {
      expect(pointerToFramePoint({ x: 640, y: 40 }, element, HD)).toBeNull()
    })

    it('rejects a click on the lower bar', () => {
      expect(pointerToFramePoint({ x: 640, y: 860 }, element, HD)).toBeNull()
    })
  })

  describe('with vertical bars (box wider than the clip)', () => {
    // 1600x720 box holding a 16:9 clip: 160px bars left and right.
    const element = { width: 1600, height: 720 }

    it('finds the centre of the picture', () => {
      expect(pointerToFramePoint({ x: 800, y: 360 }, element, HD)).toEqual({ x: 640, y: 360 })
    })

    it('maps the left edge of the picture to x=0', () => {
      expect(pointerToFramePoint({ x: 160, y: 0 }, element, HD)).toEqual({ x: 0, y: 0 })
    })

    it.each([
      ['left bar', 80],
      ['right bar', 1560],
    ])('rejects a click on the %s', (_label, x) => {
      expect(pointerToFramePoint({ x, y: 360 }, element, HD)).toBeNull()
    })
  })

  it('rejects a click past the bottom-right pixel', () => {
    expect(pointerToFramePoint({ x: 1280, y: 720 }, HD, HD)).toBeNull()
  })

  it('accepts the last addressable pixel', () => {
    expect(pointerToFramePoint({ x: 1279, y: 719 }, HD, HD)).toEqual({ x: 1279, y: 719 })
  })

  it.each([
    ['an unmeasured element', { width: 0, height: 0 }, HD],
    ['a clip with no dimensions', HD, { width: 0, height: 0 }],
  ])('returns null for %s', (_label, element, frame) => {
    expect(pointerToFramePoint({ x: 10, y: 10 }, element, frame)).toBeNull()
  })
})

describe('framePointToElement', () => {
  it('is the inverse of pointerToFramePoint', () => {
    const element = { width: 1600, height: 720 }
    for (const point of [
      { x: 0, y: 0 },
      { x: 640, y: 360 },
      { x: 1279, y: 719 },
      { x: 12, y: 700 },
    ]) {
      const onElement = framePointToElement(point, element, HD)!
      const backToFrame = pointerToFramePoint(onElement, element, HD)!
      expect(backToFrame.x).toBeCloseTo(point.x, 9)
      expect(backToFrame.y).toBeCloseTo(point.y, 9)
    }
  })

  it('offsets by the letterbox bar rather than the element edge', () => {
    // 1280x900 box holding a 16:9 clip: 90px bars top and bottom.
    const element = { width: 1280, height: 900 }
    expect(framePointToElement({ x: 0, y: 0 }, element, HD)).toEqual({ x: 0, y: 90 })
  })

  it('maps the frame centre to the picture centre', () => {
    const element = { width: 1600, height: 720 }
    expect(framePointToElement({ x: 640, y: 360 }, element, HD)).toEqual({ x: 800, y: 360 })
  })

  /**
   * The detector works on a downscaled frame, so the mapping has to absorb that
   * difference too rather than assuming frame size equals clip size.
   */
  it('scales up from a smaller analysis frame', () => {
    const analysis = { width: 640, height: 360 }
    const element = { width: 1280, height: 720 }
    expect(framePointToElement({ x: 320, y: 180 }, element, analysis)).toEqual({ x: 640, y: 360 })
  })

  it.each([
    ['an unmeasured element', { width: 0, height: 0 }, HD],
    ['a frame with no dimensions', HD, { width: 0, height: 0 }],
  ])('returns null for %s', (_label, element, frame) => {
    expect(framePointToElement({ x: 1, y: 1 }, element, frame)).toBeNull()
  })
})

describe('frameToElementScale', () => {
  it('reports the factor a radius must be multiplied by', () => {
    expect(frameToElementScale({ width: 1280, height: 720 }, { width: 640, height: 360 })).toBe(2)
  })

  it('is limited by whichever axis is tighter', () => {
    // A very wide box is still constrained by its height.
    expect(frameToElementScale({ width: 4000, height: 720 }, HD)).toBeCloseTo(1, 9)
  })

  it('is zero when either side has no size', () => {
    expect(frameToElementScale({ width: 0, height: 0 }, HD)).toBe(0)
  })
})
