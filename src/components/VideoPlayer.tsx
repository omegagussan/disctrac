import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  DEFAULT_FPS,
  clampFrame,
  formatTimecode,
  frameAtTime,
  frameCount,
  timeAtFrame,
} from '../video/frames.ts'

/**
 * `requestVideoFrameCallback` is how we learn which frame is actually on screen
 * rather than guessing from `timeupdate`, which fires only ~4x a second.
 * Declared structurally so the code compiles whether or not the DOM lib has it.
 */
interface FrameMetadata {
  mediaTime: number
}
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?(callback: (now: number, metadata: FrameMetadata) => void): number
  cancelVideoFrameCallback?(handle: number): void
}

export interface VideoCredit {
  title: string
  author: string
  licence: string
  licenceUrl: string
  sourceUrl: string
}

export interface VideoPlayerProps {
  src: string
  name: string
  /** Shown beneath the player. Required for CC-licensed clips. */
  credit?: VideoCredit
  fps?: number
  onRequestReplace(): void
}

export function VideoPlayer({
  src,
  name,
  credit,
  fps = DEFAULT_FPS,
  onRequestReplace,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)

  const frame = frameAtTime(time, fps)
  const total = frameCount(duration, fps)
  const progress = duration > 0 ? Math.min(time / duration, 1) : 0

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // Autoplay policy can reject this; swallowing keeps a rejected promise
      // from surfacing as an unhandled error.
      void video.play().catch(() => setIsPlaying(false))
    } else {
      video.pause()
    }
  }, [])

  const step = useCallback(
    (delta: number) => {
      const video = videoRef.current
      if (!video) return
      // Stepping while playing would immediately be overwritten by playback.
      video.pause()
      const next = clampFrame(frameAtTime(video.currentTime, fps) + delta, video.duration, fps)
      video.currentTime = timeAtFrame(next, fps)
    },
    [fps],
  )

  const seekToRatio = useCallback((ratio: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration)) return
    video.currentTime = Math.min(Math.max(ratio, 0), 1) * video.duration
  }, [])

  // Track the presented frame. rVFC fires on every painted frame, including
  // after a seek while paused, which is exactly what frame stepping needs.
  useEffect(() => {
    const video = videoRef.current as VideoWithFrameCallback | null
    if (!video?.requestVideoFrameCallback) return
    let handle = video.requestVideoFrameCallback(function onFrame(_now, metadata) {
      setTime(metadata.mediaTime)
      handle = video.requestVideoFrameCallback!(onFrame)
    })
    return () => video.cancelVideoFrameCallback?.(handle)
  }, [src])

  // Global shortcuts, so they work without first clicking the video.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT')) {
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      switch (event.key) {
        case ' ':
          event.preventDefault() // otherwise the page scrolls
          togglePlay()
          break
        case 'ArrowLeft':
          event.preventDefault()
          step(event.shiftKey ? -10 : -1)
          break
        case 'ArrowRight':
          event.preventDefault()
          step(event.shiftKey ? 10 : 1)
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step, togglePlay])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bar = barRef.current
    if (!bar) return
    bar.setPointerCapture(event.pointerId)
    const ratioAt = (clientX: number) => {
      const rect = bar.getBoundingClientRect()
      return rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    }
    seekToRatio(ratioAt(event.clientX))

    const onMove = (moveEvent: PointerEvent) => seekToRatio(ratioAt(moveEvent.clientX))
    const onUp = () => {
      bar.removeEventListener('pointermove', onMove)
      bar.removeEventListener('pointerup', onUp)
      bar.removeEventListener('pointercancel', onUp)
    }
    bar.addEventListener('pointermove', onMove)
    bar.addEventListener('pointerup', onUp)
    bar.addEventListener('pointercancel', onUp)
  }

  return (
    <div className="player">
      <div className="player-stage">
        <video
          ref={videoRef}
          src={src}
          className="player-video"
          playsInline
          preload="auto"
          onClick={togglePlay}
          onLoadedMetadata={(event) => {
            setDuration(event.currentTarget.duration)
            setTime(event.currentTarget.currentTime)
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onSeeked={(event) => setTime(event.currentTarget.currentTime)}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        />
      </div>

      <div
        ref={barRef}
        className="player-progress"
        role="slider"
        tabIndex={0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.max(total - 1, 0)}
        aria-valuenow={frame}
        aria-valuetext={`Frame ${frame} of ${Math.max(total - 1, 0)}, ${formatTimecode(time)}`}
        onPointerDown={onPointerDown}
      >
        <div className="player-progress-fill" style={{ inlineSize: `${progress * 100}%` }} />
        <div className="player-progress-head" style={{ insetInlineStart: `${progress * 100}%` }} />
      </div>

      <div className="player-status">
        <button type="button" className="player-toggle" onClick={togglePlay}>
          {isPlaying ? '❚❚ Pause' : '▶ Play'}
        </button>
        <span className="player-frame">
          frame <strong>{frame}</strong>
          {total > 0 && <span className="player-dim"> / {total - 1}</span>}
        </span>
        <span className="player-time">
          {formatTimecode(time)}
          <span className="player-dim"> / {formatTimecode(duration)}</span>
        </span>
        <span className="player-name" title={name}>
          {name}
        </span>
        <button type="button" className="player-replace" onClick={onRequestReplace}>
          Replace video
        </button>
      </div>

      <p className="player-hint">
        <kbd>Space</kbd> play/pause · <kbd>←</kbd> <kbd>→</kbd> step one frame ·{' '}
        <kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> ten frames
      </p>

      {credit && (
        <p className="player-credit">
          Clip: <a href={credit.sourceUrl}>{credit.title}</a> by {credit.author}, licensed{' '}
          <a href={credit.licenceUrl}>{credit.licence}</a>. Trimmed and transcoded; these clips
          remain under the same licence.
        </p>
      )}
    </div>
  )
}
