import { useEffect, useRef } from 'react'
import { labToHex } from '../video/color.ts'
import type { CroppedRegion, DiscColorModel } from '../video/discModel.ts'

export interface DiscPreviewProps {
  region: CroppedRegion | null
  model: DiscColorModel | null
  seedCount: number
}

/** The selected disc as a cutout, plus the colour modes describing it. */
export function DiscPreview({ region, model, seedCount }: DiscPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !region) return
    canvas.width = region.width
    canvas.height = region.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.putImageData(new ImageData(region.data, region.width, region.height), 0, 0)
  }, [region])

  return (
    <aside className="disc-panel" aria-label="Selected disc">
      <h2 className="disc-panel-title">Selected disc</h2>

      {region ? (
        <>
          <div className="disc-cutout">
            <canvas ref={canvasRef} className="disc-cutout-canvas" />
          </div>
          <p className="disc-panel-meta">
            {region.width}x{region.height} px · {model?.pixelCount ?? 0} selected ·{' '}
            {seedCount} {seedCount === 1 ? 'sample' : 'samples'}
          </p>
        </>
      ) : (
        <p className="disc-panel-empty">
          Click the disc in the frame. Click again on another colour to add it to the selection.
        </p>
      )}

      {model && model.modes.length > 0 && (
        <>
          <h3 className="disc-panel-subtitle">
            Colour {model.modes.length === 1 ? 'mode' : 'modes'}
          </h3>
          <ul className="disc-modes">
            {model.modes.map((mode, index) => {
              const hex = labToHex(mode.lab)
              return (
                <li key={`${hex}-${index}`} className="disc-mode">
                  <span
                    className="disc-mode-swatch"
                    style={{ background: hex }}
                    aria-hidden="true"
                  />
                  <span className="disc-mode-hex">{hex}</span>
                  <span className="disc-mode-weight">{Math.round(mode.weight * 100)}%</span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </aside>
  )
}
