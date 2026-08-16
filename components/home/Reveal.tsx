'use client'

import { useEffect, useId, useState, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'

// ── Homepage scroll-reveal, DISCLOSED ──────────────────────────────────────
// Purely presentational: fades/slides its single child element into view the first time that
// element scrolls into the viewport. Runs at most once per browser tab session — the session
// gate is checked synchronously on first render (never mid-scroll), so navigating away and back
// (or a plain refresh within the same tab, since sessionStorage survives that) never replays it.
// Each IntersectionObserver unobserves itself the instant it fires, so scrolling up/down after
// the first reveal never re-triggers anything and leaves no observers running. Fully inert under
// prefers-reduced-motion: content is shown immediately, no transform/blur/delay.
//
// Real implementation of the pre-existing `Reveal` call sites in app/page.tsx (previously a
// no-op passthrough — `({ children }) => <>{children}</>` — every call site, prop, and delayMs
// value was already wired up ahead of this task). Extracted here (rather than left inline) so
// components/home/ReferenceHero.tsx — the currently-active hero — can use the exact same
// implementation instead of a second, divergent copy.

const REVEAL_SEEN_KEY = 'chainlens_home_reveal_seen'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function hasSeenReveal(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.sessionStorage.getItem(REVEAL_SEEN_KEY) === '1'
  } catch {
    // sessionStorage unavailable (private mode, disabled storage) — fail open to "already seen"
    // so content renders normally instead of silently staying invisible forever.
    return true
  }
}

function markRevealSeen(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(REVEAL_SEEN_KEY, '1')
  } catch {
    // Best-effort only — a failed write just means this tab may animate again next mount,
    // never a functional break.
  }
}

export default function Reveal({ children, delayMs = 0 }: { children: ReactNode; delayMs?: number }) {
  // ID-BASED LOOKUP, NOT A REF, DISCLOSED: cloning an arbitrary child normally calls for a ref to
  // reach its real DOM node, but this codebase's lint rules (react-hooks: "refs should only be
  // accessed outside of render") flag a ref object passed through cloneElement's props as a
  // possible render-time read, however it's attached. A stable id from useId() + a plain
  // document.getElementById in the effect gets the same real node with no ref involved at all.
  const revealId = useId()
  // Computed once, synchronously, on mount — never re-evaluated, so a mid-session
  // prefers-reduced-motion change (or a sessionStorage write from a sibling Reveal) can't flip
  // an already-decided element between animated and static mid-scroll.
  const [skip] = useState(() => prefersReducedMotion() || hasSeenReveal())
  const [visible, setVisible] = useState(skip)

  useEffect(() => {
    if (skip) return
    // Marked the moment a live reveal pass actually mounts — not deferred until this specific
    // element scrolls into view — so the session is "seen" after the first page load, matching
    // "enable reveal animations and set it after first reveal pass/page load". A user who
    // scrolls partway, navigates away, and returns within the same tab session sees every
    // section already visible, never a replay of the intro.
    markRevealSeen()

    const el = document.getElementById(revealId)
    if (!el || typeof IntersectionObserver === 'undefined') {
      // No synchronous setState-in-effect, DISCLOSED: scheduled exactly like the observer's own
      // reveal below (setTimeout, not a direct call) — this codebase's lint rules flag calling
      // setState directly in an effect body as a possible cascading-render risk. Fires on the
      // next tick either way; imperceptible for a fallback this rare (no IntersectionObserver
      // support, or the cloned child failed to mount with its id — effectively never in practice).
      const fallbackTimer = setTimeout(() => setVisible(true), delayMs)
      return () => clearTimeout(fallbackTimer)
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          timer = setTimeout(() => setVisible(true), delayMs)
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (timer !== null) clearTimeout(timer)
    }
  }, [skip, delayMs, revealId])

  // A non-element child (text, fragment, array, null) can't hold an id/className — render it
  // through untouched rather than force an animation wrapper div into the layout.
  if (!isValidElement(children)) return <>{children}</>

  const child = children as ReactElement<{ className?: string; id?: string }>
  const existingClassName = typeof child.props.className === 'string' ? child.props.className : ''
  const className = skip
    ? [existingClassName, 'reveal-skip'].filter(Boolean).join(' ')
    : [existingClassName, 'reveal-ready', visible ? 'reveal-visible' : ''].filter(Boolean).join(' ')

  // Only stamp an id when actually animating — a skipped element is never looked up, so it never
  // needs one (and never gains an id it didn't already have).
  return cloneElement(child, skip ? { className } : { id: child.props.id ?? revealId, className })
}
