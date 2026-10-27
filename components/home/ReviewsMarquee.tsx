'use client'

// Homepage "What Base traders are saying" — one flat row of review cards that travels continuously
// to the right.
//
// The row is rendered four times inside one track. The track slides right by exactly one row's
// width (translateX -25% → 0, CSS only) and then repeats, so the end of each cycle is pixel-identical
// to its start: no jump, no gap, constant speed. Only the first row is exposed to assistive tech;
// the three copies are aria-hidden and inert, and none of them contains focusable content.
//
// Movement pauses on hover, while the carousel has keyboard focus, and while it is being dragged or
// swiped (a separate offset layer moves with the finger, so dragging never fights the animation).
// With prefers-reduced-motion the animation is off, the copies are removed, and the single row
// scrolls natively.

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'

export type Testimonial = {
  handle: string
  name: string
  initials: string
  grad: string
  avatar: string
  date: string
  verified: boolean
  imgPos?: string
  imgFilter?: string
  quote: string
}

const COPIES = 4
/** Card width + gap at desktop size, used only to derive a constant speed of ~40px/s. */
const CARD_STEP_PX = 270
const SPEED_PX_PER_SEC = 40
const HOLD_AFTER_TOUCH_MS = 1200

const CSS = `
.rv-viewport{position:relative;overflow:hidden;padding:6px 0 10px;outline:none;touch-action:pan-y;cursor:grab;
  -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 56px,#000 calc(100% - 56px),transparent 100%);
          mask-image:linear-gradient(90deg,transparent 0,#000 56px,#000 calc(100% - 56px),transparent 100%)}
.rv-viewport.is-dragging{cursor:grabbing}
.rv-viewport:focus-visible{box-shadow:0 0 0 2px rgba(45,212,191,.45);border-radius:14px}
.rv-offset{will-change:transform}
.rv-track{display:flex;width:max-content;animation:rv-flow var(--rv-duration,40s) linear infinite;will-change:transform}
@keyframes rv-flow{from{transform:translate3d(-25%,0,0)}to{transform:translate3d(0,0,0)}}
@media (hover:hover){.rv-viewport:hover .rv-track{animation-play-state:paused}}
/* Keyboard focus pauses; a mouse click or tap (which also focuses the region) does not keep it paused. */
.rv-viewport:focus-visible .rv-track,.rv-viewport.is-dragging .rv-track,.rv-viewport.is-held .rv-track{animation-play-state:paused}
.rv-set{display:flex;gap:14px;padding:0 14px 0 0;margin:0;list-style:none}
.rv-card{flex:0 0 256px;width:256px;display:flex;flex-direction:column;gap:12px;padding:16px 16px 14px;border-radius:12px;
  background:#0d1013;border:1px solid rgba(255,255,255,.08);box-shadow:0 2px 14px rgba(0,0,0,.28);
  transition:border-color .25s ease,box-shadow .25s ease;user-select:none;-webkit-user-select:none}
.rv-card:hover{border-color:rgba(45,212,191,.28);box-shadow:0 0 0 1px rgba(45,212,191,.06),0 6px 22px rgba(0,0,0,.4)}
.rv-head{display:flex;align-items:center;gap:10px}
.rv-who{flex:1;min-width:0}
.rv-name-row{display:flex;align-items:center;gap:5px;margin-bottom:1px}
.rv-name{font-size:13.5px;font-weight:700;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-handle{font-size:12px;color:#2DD4BF;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-quote{flex:1;display:grid;gap:6px;margin:0}
.rv-quote p{margin:0;font-size:13.5px;line-height:1.55;color:rgba(255,255,255,.88);white-space:pre-line;overflow-wrap:anywhere}
.rv-date{font-size:11px;color:rgba(255,255,255,.36);font-weight:500;letter-spacing:.02em}
.rv-avatar{position:relative;width:38px;height:38px;border-radius:50%;flex-shrink:0;overflow:hidden}
.rv-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;-webkit-user-drag:none}
@media (max-width:900px){.rv-card{flex-basis:244px;width:244px}}
@media (max-width:560px){.rv-card{flex-basis:228px;width:228px;padding:14px 14px 12px}.rv-set{gap:12px;padding-right:12px}
  .rv-viewport{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 24px,#000 calc(100% - 24px),transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 24px,#000 calc(100% - 24px),transparent 100%)}}
/* globals.css stops every CSS animation below 767px (!important) to avoid mobile flicker. This one
   compositor-only transform is re-enabled there, and only when reduced motion is not requested. */
@media (max-width:767px) and (prefers-reduced-motion:no-preference){
  .home-page .rv-viewport .rv-track,.rv-viewport .rv-offset .rv-track{animation-duration:var(--rv-duration,40s)!important;animation-iteration-count:infinite!important}
}
@media (prefers-reduced-motion:reduce){
  .rv-track{animation:none}
  .rv-set[aria-hidden="true"]{display:none}
  .rv-viewport{overflow-x:auto;cursor:auto;touch-action:auto;scroll-snap-type:x mandatory;-webkit-mask-image:none;mask-image:none;scrollbar-width:thin}
  .rv-card{scroll-snap-align:start}
}
`

function Avatar({ t }: { t: Testimonial }) {
  return (
    <div className="rv-avatar" style={{ background: t.grad }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={t.avatar}
        alt=""
        aria-label={`${t.name} profile avatar`}
        draggable={false}
        // Not lazy: the row starts on a copy and clipped lazy images can blink in as they slide into
        // view. The six small avatars are fetched at low priority instead.
        fetchPriority="low"
        decoding="async"
        style={{ objectPosition: t.imgPos ?? 'center center', filter: t.imgFilter }}
        onError={(e) => {
          // Same fallback as before: gradient initials when the avatar file is missing.
          const img = e.currentTarget
          img.style.display = 'none'
          const parent = img.parentElement
          if (parent) {
            parent.style.fontSize = '14px'
            parent.style.fontWeight = '800'
            parent.style.color = '#fff'
            parent.style.display = 'flex'
            parent.style.alignItems = 'center'
            parent.style.justifyContent = 'center'
            parent.textContent = t.initials
          }
        }}
      />
    </div>
  )
}

function ReviewCard({ t }: { t: Testimonial }) {
  return (
    <li className="rv-card">
      <div className="rv-head">
        <Avatar t={t} />
        <div className="rv-who">
          <div className="rv-name-row">
            <span className="rv-name">{t.name}</span>
            {t.verified && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }} role="img" aria-label="Verified account">
                <circle cx="12" cy="12" r="12" fill="#1d9bf0" />
                <path d="M9.5 16.5l-3.5-3.5 1.4-1.4 2.1 2.1 5.6-5.6 1.4 1.4z" fill="#fff" />
              </svg>
            )}
          </div>
          <div className="rv-handle">{t.handle}</div>
        </div>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="rgba(255,255,255,0.22)" style={{ flexShrink: 0 }} role="img" aria-label="Posted on X">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.261 5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </div>
      {/* Paragraph breaks in the original post become compact paragraphs; the text is unchanged. */}
      <blockquote className="rv-quote">
        {t.quote.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
      </blockquote>
      <time className="rv-date">{t.date}</time>
    </li>
  )
}

export default function ReviewsMarquee({ testimonials }: { testimonials: Testimonial[] }) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const offsetRef = useRef<HTMLDivElement | null>(null)
  const setRef = useRef<HTMLUListElement | null>(null)
  const drag = useRef<{ id: number; startX: number; startOffset: number } | null>(null)
  const offset = useRef(0)
  const holdTimer = useRef<number | null>(null)

  const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Keeps the manual offset within one row width so the four copies always cover the viewport.
  const applyOffset = useCallback((next: number) => {
    const rowWidth = setRef.current?.offsetWidth ?? 0
    if (rowWidth > 0) { next %= rowWidth; if (next > 0) next -= rowWidth }
    offset.current = next
    if (offsetRef.current) offsetRef.current.style.transform = `translate3d(${next}px,0,0)`
  }, [])

  useEffect(() => () => { if (holdTimer.current != null) window.clearTimeout(holdTimer.current) }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (reducedMotion() || (e.pointerType === 'mouse' && e.button !== 0)) return
    if (holdTimer.current != null) { window.clearTimeout(holdTimer.current); holdTimer.current = null }
    drag.current = { id: e.pointerId, startX: e.clientX, startOffset: offset.current }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.classList.add('is-dragging')
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return
    applyOffset(drag.current.startOffset + (e.clientX - drag.current.startX))
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return
    drag.current = null
    const el = e.currentTarget
    el.classList.remove('is-dragging')
    if (e.pointerType !== 'mouse') {
      // Give a reader a moment after a swipe before movement resumes.
      el.classList.add('is-held')
      holdTimer.current = window.setTimeout(() => { el.classList.remove('is-held'); holdTimer.current = null }, HOLD_AFTER_TOUCH_MS)
    }
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (reducedMotion()) return // native scrolling handles the arrow keys
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      applyOffset(offset.current + (e.key === 'ArrowRight' ? 1 : -1) * CARD_STEP_PX)
    }
  }

  const duration = `${Math.round((testimonials.length * CARD_STEP_PX) / SPEED_PX_PER_SEC)}s`
  return (
    <>
      <style>{CSS}</style>
      <div
        ref={viewportRef}
        className="rv-viewport"
        role="region"
        aria-roledescription="carousel"
        aria-label="Reviews from X. Moves continuously; hover, focus or drag to pause. Use the left and right arrow keys to move."
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div ref={offsetRef} className="rv-offset">
          <div className="rv-track" style={{ ['--rv-duration' as string]: duration }}>
            {Array.from({ length: COPIES }, (_, copy) => (
              <ul
                key={copy}
                ref={copy === 0 ? setRef : undefined}
                className="rv-set"
                {...(copy === 0 ? { 'aria-label': `${testimonials.length} reviews` } : { 'aria-hidden': true, inert: true })}
              >
                {testimonials.map((t) => <ReviewCard key={`${copy}-${t.handle}`} t={t} />)}
              </ul>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
