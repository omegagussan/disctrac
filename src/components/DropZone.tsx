import { useCallback, useState } from 'react'
import type { DragEvent as ReactDragEvent, ReactNode } from 'react'

export interface DropZoneProps {
  onFile(file: File): void
  children: ReactNode
}

/**
 * Wraps the whole app so a video can be dropped anywhere, not just onto a
 * designated square.
 */
export function DropZone({ onFile, children }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    // Without preventDefault the browser navigates to the file and no drop fires.
    event.preventDefault()
    setIsDragging(true)
  }, [])

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    // dragleave also fires when crossing into a child, so ignore those.
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setIsDragging(false)
  }, [])

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setIsDragging(false)

      const file = event.dataTransfer.files.item(0)
      if (!file) {
        setError('Nothing landed in the drop — try dragging the file again.')
        return
      }
      // Some containers arrive with an empty MIME type, so fall back to extension.
      const looksLikeVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)
      if (!looksLikeVideo) {
        setError(`${file.name} is not a video file.`)
        return
      }

      setError(null)
      onFile(file)
    },
    [onFile],
  )

  return (
    <div
      className={`dropzone${isDragging ? ' is-dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {isDragging && <div className="dropzone-overlay">Drop the video to load it</div>}
      {error && (
        <p className="dropzone-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
