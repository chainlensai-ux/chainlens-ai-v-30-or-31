'use client'

import { useEffect, useRef, useState } from 'react'

// Video preview for a "What ChainLens Does" card. Drop a short, muted screen recording of the real
// tool at the card's `previewVideo` path (public/feature-previews/<name>.mp4) and it shows up:
//
//  - 'hover' mode (mouse/trackpad, motion allowed): a floating panel slides out below the card
//    (above it when there is no room below) while the card is hovered.
//  - 'tap' mode (touch, or prefers-reduced-motion): the card gets a "Preview" button that expands
//    the clip inline; tapping the clip opens it full screen.
//
// Until a recording exists nothing is shown: hover mode only requests the clip on the first hover,
// tap mode sends one HEAD request before offering the button, and a missing or broken file is
// remembered so it is never requested again on this page load. The video pauses whenever it is
// hidden, scrolled out of view, or the tab is hidden.

const missing = new Set<string>()
const probes = new Map<string, Promise<boolean>>()

export type PreviewMode = 'off' | 'hover' | 'tap'

export function usePreviewMode(): PreviewMode {
  const [mode, setMode] = useState<PreviewMode>('off')
  useEffect(() => {
    const capable = window.matchMedia('(hover: hover) and (pointer: fine)')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setMode(capable.matches && !reduce.matches ? 'hover' : 'tap')
    update()
    capable.addEventListener('change', update)
    reduce.addEventListener('change', update)
    return () => {
      capable.removeEventListener('change', update)
      reduce.removeEventListener('change', update)
    }
  }, [])
  return mode
}

/** Whether the clip exists, checked with a single HEAD request (only when `check` is true). */
export function useVideoAvailable(src: string | undefined, check: boolean): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!src || !check || missing.has(src)) return
    let probe = probes.get(src)
    if (!probe) {
      probe = fetch(src, { method: 'HEAD' })
        .then((r) => r.ok && (r.headers.get('content-type') ?? 'video').startsWith('video'))
        .catch(() => false)
        .then((ok) => { if (!ok) missing.add(src); return ok })
      probes.set(src, probe)
    }
    let alive = true
    void probe.then((ok) => { if (alive) setAvailable(ok) })
    return () => { alive = false }
  }, [src, check])
  return available
}

type Status = 'idle' | 'loading' | 'ready' | 'missing'

export default function FeatureVideoSlot({ src, active, variant, placement = 'below', onReadyChange, onMissing }: {
  src?: string
  active: boolean
  variant: 'popover' | 'inline'
  placement?: 'below' | 'above'
  onReadyChange?: (showing: boolean) => void
  onMissing?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<Status>(() => (src && missing.has(src) ? 'missing' : 'idle'))
  const [inView, setInView] = useState(true)

  // First activation starts the download (adjusting state during render, not in an effect).
  if (active && src && status === 'idle') setStatus('loading')

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [status])

  const showing = active && status === 'ready'
  const playing = showing && inView

  useEffect(() => {
    const el = videoRef.current
    if (!el || status !== 'ready') return
    const sync = () => {
      if (playing && !document.hidden) void el.play().catch(() => {})
      else el.pause()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [playing, status])

  useEffect(() => { onReadyChange?.(showing) }, [showing, onReadyChange])

  if (!src || status === 'idle' || status === 'missing') return null

  const openFullscreen = () => {
    const el = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    if (!el) return
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => el.webkitEnterFullscreen?.())
    else el.webkitEnterFullscreen?.()
  }

  return (
    <div
      className={`cap-media cap-media-${variant}`}
      data-show={showing || undefined}
      data-placement={variant === 'popover' ? placement : undefined}
      aria-hidden={variant === 'popover' ? true : undefined}
      onClick={variant === 'inline' ? openFullscreen : undefined}
    >
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
        onError={() => { missing.add(src); setStatus('missing'); onMissing?.() }}
      />
      {variant === 'inline' && showing && <span className="cap-media-hint">Tap to expand</span>}
    </div>
  )
}
