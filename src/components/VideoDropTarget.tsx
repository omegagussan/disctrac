import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'

export interface VideoDropTargetProps {
  onFile(file: File): void
  onCancel(): void
}

/**
 * Takes the video's place while a replacement is chosen, so the drop area is
 * exactly where the thing being replaced was.
 */
export function VideoDropTarget({ onFile, onCancel }: VideoDropTargetProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const accept = useCallback(
    (file: File | null) => {
      if (!file) {
        setError('Nothing arrived — try again.')
        return
      }
      // Some containers arrive with an empty MIME type, so fall back to extension.
      const looksLikeVideo =
        file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)
      if (!looksLikeVideo) {
        setError(`${file.name} is not a video file.`)
        return
      }
      setError(null)
      onFile(file)
    },
    [onFile],
  )

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    // Without preventDefault the browser navigates to the file and no drop fires.
    event.preventDefault()
    setIsDragging(true)
  }

  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    // dragleave also fires when crossing into a child, so ignore those.
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setIsDragging(false)
  }

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    accept(event.dataTransfer.files.item(0))
  }

  return (
    <div
      className={`drop-target${isDragging ? ' is-dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <p className="drop-target-headline">Drag a video here</p>

      <div className="drop-target-actions">
        {/* Dragging is not the only way in — keyboard and screen-reader users
            need a real control, so the same flow is reachable by click. */}
        <button type="button" className="drop-target-browse" onClick={() => inputRef.current?.click()}>
          Choose a file
        </button>
        <button type="button" className="drop-target-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <p className="drop-target-hint">
        <kbd>Esc</kbd> to keep the current video
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="visually-hidden"
        onChange={(event) => accept(event.currentTarget.files?.item(0) ?? null)}
      />

      {error && (
        <p className="drop-target-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
