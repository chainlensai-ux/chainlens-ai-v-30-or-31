'use client'

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'

// Fades its child in while sliding it from the given side, the first time it scrolls into view on
// each page load (no session flag, so every visit plays it). The server markup is fully visible;
// the hidden start state is only armed on the client for elements still below the viewport, so a
// card already on screen at mount never flashes out and back. Inert under prefers-reduced-motion
// (see .side-in in globals.css).
export default function SideSlideIn({ side, delayMs = 0, children }: { side: 'left' | 'right'; delayMs?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (el.getBoundingClientRect().top < window.innerHeight) return
    el.classList.add('side-in-armed')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          el.classList.add('side-in-visible')
          observer.disconnect()
        }
      },
      { threshold: 0.18, rootMargin: '0px 0px -6% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="side-in" data-side={side} style={{ '--side-delay': `${delayMs}ms` } as CSSProperties}>
      {children}
    </div>
  )
}
