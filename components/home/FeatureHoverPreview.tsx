'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// Hover preview for a "What ChainLens Does" card: a floating panel beside the card that loops a
// short, muted clip of that feature in the terminal. Mouse: opens on entering the card, closes the
// instant the pointer leaves both the card and the panel (the panel overlaps the card's edge so the
// pointer never crosses a gap). Touch: a tap on the card (not its link) toggles it, a tap anywhere
// else closes it. The panel only ever shows once its video has loaded; a missing or broken clip
// means no panel at all, never an empty frame.

type VideoState = 'idle' | 'loading' | 'ready' | 'missing'

export default function FeatureHoverPreview({ src, accent, side, label, children }: {
  src: string
  accent: string
  /** Which side of the card the panel opens on (away from the card's title). */
  side: 'left' | 'right'
  label: string
  children: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [open, setOpen] = useState(false)
  const [video, setVideo] = useState<VideoState>('idle')

  // The clip is only requested on first open, so the page never downloads six videos up front.
  const requestOpen = () => {
    if (video === 'missing') return
    if (video === 'idle') setVideo('loading')
    setOpen(true)
  }

  useEffect(() => {
    const el = videoRef.current
    if (!el || video !== 'ready') return
    if (open) void el.play().catch(() => {})
    else el.pause()
  }, [open, video])

  // Touch: any tap outside this card and its panel closes it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' && !rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const visible = open && video === 'ready'

  return (
    <div
      ref={rootRef}
      className="feat-preview-root"
      data-open={visible || undefined}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') requestOpen() }}
      onPointerLeave={(event) => { if (event.pointerType === 'mouse') setOpen(false) }}
      onClick={(event) => {
        // The card's own "Open in Terminal" link keeps working; only taps elsewhere on the card toggle.
        if ((event.target as Element).closest('a')) return
        if (open) setOpen(false)
        else requestOpen()
      }}
    >
      {children}
      {video !== 'idle' && video !== 'missing' ? (
        <div
          className="feat-preview-panel"
          data-side={side}
          aria-hidden="true"
          hidden={!visible}
          style={{ '--feat-preview-accent': accent } as CSSProperties}
        >
          <video
            ref={videoRef}
            src={src}
            muted
            loop
            playsInline
            autoPlay
            preload="auto"
            disablePictureInPicture
            aria-label={`${label} preview`}
            onLoadedData={() => setVideo('ready')}
            onError={() => { setVideo('missing'); setOpen(false) }}
          />
        </div>
      ) : null}
    </div>
  )
}
