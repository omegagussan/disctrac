import { useCallback, useEffect, useRef, useState } from 'react'
import { VideoDropTarget } from './components/VideoDropTarget.tsx'
import { VideoPlayer } from './components/VideoPlayer.tsx'
import type { VideoCredit } from './components/VideoPlayer.tsx'
// Vite emits this as an asset and hands back its URL, so the fixture stays a
// single LFS-tracked file rather than being copied into public/.
import defaultClipUrl from '../fixtures/video/throw-02-field-release.mp4?url'
import './App.css'

interface Clip {
  url: string
  name: string
  credit?: VideoCredit
  /** Object URLs must be revoked; the bundled fixture URL must not be. */
  isObjectUrl: boolean
}

const DEFAULT_CLIP: Clip = {
  url: defaultClipUrl,
  name: 'throw-02-field-release.mp4',
  isObjectUrl: false,
  credit: {
    title: 'Eric Wu and Scott Schiller playing disc golf at DeLaveaga',
    author: 'Scott Schiller',
    licence: 'CC BY-SA 2.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/2.0/',
    sourceUrl:
      'https://commons.wikimedia.org/wiki/File:Eric_Wu_and_Scott_Schiller_playing_disc_golf_at_DeLaveaga.webm',
  },
}

function App() {
  const [clip, setClip] = useState<Clip>(DEFAULT_CLIP)
  const [isReplacing, setIsReplacing] = useState(false)
  // Revoking in a cleanup keyed on `clip` would revoke the URL still in use on
  // the very next render, so track the previous one explicitly instead.
  const previousObjectUrl = useRef<string | null>(null)

  const onFile = useCallback((file: File) => {
    if (previousObjectUrl.current) URL.revokeObjectURL(previousObjectUrl.current)
    const url = URL.createObjectURL(file)
    previousObjectUrl.current = url
    setClip({ url, name: file.name, isObjectUrl: true })
    setIsReplacing(false)
  }, [])

  useEffect(
    () => () => {
      if (previousObjectUrl.current) URL.revokeObjectURL(previousObjectUrl.current)
    },
    [],
  )

  return (
    <main className="app">
      <header className="app-header">
        <h1>disctrac</h1>
        <p>
          Frame-by-frame review for disc golf throws.
          {!clip.isObjectUrl && ' Showing the bundled sample clip.'}
        </p>
      </header>

      {isReplacing ? (
        <VideoDropTarget onFile={onFile} onCancel={() => setIsReplacing(false)} />
      ) : (
        <VideoPlayer
          src={clip.url}
          name={clip.name}
          credit={clip.credit}
          onRequestReplace={() => setIsReplacing(true)}
        />
      )}
    </main>
  )
}

export default App
