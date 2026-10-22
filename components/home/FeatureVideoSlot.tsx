'use client'

import { useEffect, useRef, useState } from 'react'

// In-card video preview for a "What ChainLens Does" card. Drop a short, muted screen recording of
// the real tool at the card's `previewVideo` path (public/feature-previews/<name>.mp4) and it plays
// inside the card while the card is hovered. Until a recording exists the slot renders nothing
// visible: the clip is only requested on the first hover, and a missing or broken file is
// remembered so it is never requested again on this page load.
//
// Only runs on hover-capable fine pointers with motion allowed; touch devices and
// prefers-reduced-motion get the plain card. The video pauses whenever the card is not hovered,
// is scrolled out of view, or the tab is hidden.

const missing = new Set<string>()

type Status = 'idle' | 'loading' | 'ready' | 'missing'

export default function FeatureVideoSlot({ src, active, onReadyChange }: {
  src?: string
  active: boolean
  onReadyChange?: (showing: boolean) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<Status>(() => (src && missing.has(src) ? 'missing' : 'idle'))
  const [inView, setInView] = useState(true)

  useEffect(() => {
    const capable = window.matchMedia('(hover: hover) and (pointer: fine)')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setEnabled(capable.matches && !reduce.matches)
    update()
    capable.addEventListener('change', update)
    reduce.addEventListener('change', update)
    return () => {
      capable.removeEventListener('change', update)
      reduce.removeEventListener('change', update)
    }
  }, [])

  // First hover starts the download (adjusting state during render, not in an effect).
  if (enabled && active && src && status === 'idle') setStatus('loading')

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [status])

  const showing = enabled && active && inView && status === 'ready'

  useEffect(() => {
    const el = videoRef.current
    if (!el || status !== 'ready') return
    const sync = () => {
      if (showing && !document.hidden) void el.play().catch(() => {})
      else el.pause()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [showing, status])

  useEffect(() => { onReadyChange?.(showing) }, [showing, onReadyChange])

  if (!src || !enabled || status === 'idle' || status === 'missing') return null

  return (
    <div className="cap-media" data-show={showing || undefined} aria-hidden="true">
      <video
        ref={videoRef}
        src={src}
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        tabIndex={-1}
        onLoadedData={() => setStatus('ready')}
        onError={() => { missing.add(src); setStatus('missing') }}
      />
    </div>
  )
}
