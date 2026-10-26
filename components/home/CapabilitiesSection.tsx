'use client'

// "What ChainLens Does": black / charcoal / silver capability cards with restrained mint accents,
// matching the homepage hero (components/home/ReferenceHero.tsx) and the glass navbar. Faint
// flowing strands behind the grid continue the hero's wave theme. Plain CSS (scoped .cap-*
// classes) because this project's Tailwind build does not generate most utilities.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Reveal from './Reveal'
import SideSlideIn from './SideSlideIn'
import FeatureVideoSlot, { usePreviewMode, useVideoAvailable } from './FeatureVideoSlot'

export type Capability = {
  href: string
  title: string
  body: string
  icon: ReactNode
  /** Real screen recording of the tool; see FeatureVideoSlot. */
  previewVideo?: string
}

// ─── Background strands ─────────────────────────────────────────────────────
// Each ribbon is a bundle of thin sine strands whose shape repeats every PERIOD px. The SVG is three
// periods wide and slides left by exactly one period per loop, so the motion is seamless. Only the
// <svg> element's transform animates (composited), the paths are never re-rasterised.

const PERIOD = 720
const SPAN = PERIOD * 3

function ribbonPaths({ strands, baseY, amp, gap, twist, phase }: { strands: number; baseY: number; amp: number; gap: number; twist: number; phase: number }) {
  const paths: string[] = []
  for (let s = 0; s < strands; s++) {
    const k = s / (strands - 1)
    let d = ''
    for (let x = 0; x <= SPAN; x += 16) {
      const a = (Math.PI * 2 * x) / PERIOD
      const spread = 1 + twist * Math.sin(a + phase + 1.1)
      const y = baseY + amp * Math.sin(a + phase + k * 0.9) + (k - 0.5) * gap * spread
      d += `${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(1)}`
    }
    paths.push(d)
  }
  return paths
}

const RIBBONS = [
  { cls: 'cap-ribbon-a', strands: 18, baseY: 150, amp: 46, gap: 120, twist: 0.65, phase: 0 },
  { cls: 'cap-ribbon-b', strands: 16, baseY: 170, amp: 40, gap: 104, twist: 0.7, phase: 2.2 },
].map((r) => ({ ...r, paths: ribbonPaths(r) }))

function CapabilityWaves() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => el.classList.toggle('cap-waves-paused', !entry.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div ref={ref} className="cap-waves" aria-hidden="true">
      {RIBBONS.map((r) => (
        <svg key={r.cls} className={`cap-ribbon ${r.cls}`} width={SPAN} height={320} viewBox={`0 0 ${SPAN} 320`} fill="none">
          {r.paths.map((d, i) => (
            <path key={i} d={d} stroke={i === r.paths.length - 1 ? 'rgba(31,214,220,0.26)' : 'rgba(205,213,218,0.075)'} strokeWidth={i === r.paths.length - 1 ? 1.1 : 0.8} />
          ))}
        </svg>
      ))}
    </div>
  )
}

// ─── Card ───────────────────────────────────────────────────────────────────

function CapabilityCard({ feature }: { feature: Capability }) {
  const router = useRouter()
  const cellRef = useRef<HTMLDivElement>(null)
  const mode = usePreviewMode()
  const [hovered, setHovered] = useState(false)
  const [placement, setPlacement] = useState<'below' | 'above'>('below')
  const [open, setOpen] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const onReadyChange = useCallback((showing: boolean) => setPreviewing(showing), [])
  const available = useVideoAvailable(feature.previewVideo, mode === 'tap')
  const canTap = mode === 'tap' && available

  // The popover opens below the card unless that would run past the section or the viewport (the
  // last row) while there is room above. Its height is estimated from the card width.
  const enter = () => {
    const cell = cellRef.current
    if (cell) {
      const r = cell.getBoundingClientRect()
      const need = r.width * 0.56 + 16
      const section = cell.closest('.cap-section')?.getBoundingClientRect()
      const roomBelow = r.bottom + need <= Math.min(window.innerHeight, section?.bottom ?? Infinity)
      const roomAbove = r.top - need >= Math.max(section?.top ?? 0, 0)
      setPlacement(!roomBelow && roomAbove ? 'above' : 'below')
    }
    setHovered(true)
  }

  return (
    <div ref={cellRef} className="cap-cell" data-previewing={(mode === 'hover' && previewing) || undefined}>
      <article
        className="cap-card"
        data-open={(canTap && open) || undefined}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') enter() }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHovered(false) }}
        // The whole card opens the tool, as the link does; the link itself stays the keyboard and
        // screen-reader target (and handles modifier-clicks natively).
        onClick={(e) => {
          if ((e.target as Element).closest('a,button,.cap-media')) return
          router.push(feature.href)
        }}
      >
        <div className="cap-content">
          <div className="cap-icon">{feature.icon}</div>
          <h3 className="cap-title">{feature.title}</h3>
          <p className="cap-body">{feature.body}</p>
        </div>
        {canTap && open && (
          <FeatureVideoSlot src={feature.previewVideo} active variant="inline" onMissing={() => setOpen(false)} />
        )}
        <div className="cap-foot">
          {canTap && (
            <button type="button" className="cap-preview-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /></svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /></svg>
              )}
              {open ? 'Close preview' : 'Watch preview'}
            </button>
          )}
          <Link href={feature.href} className="cap-link" aria-label={`Open ${feature.title} in Terminal`}>
            Open in Terminal
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
      </article>
      {mode === 'hover' && (
        <FeatureVideoSlot src={feature.previewVideo} active={hovered} variant="popover" placement={placement} onReadyChange={onReadyChange} />
      )}
    </div>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────

export default function CapabilitiesSection({ features }: { features: Capability[] }) {
  return (
    <section className="cap-section">
      <CapabilityWaves />
      <div className="cap-inner">
        <Reveal><header className="cap-header">
          <div className="cap-eyebrow"><i aria-hidden="true" /><span>Capabilities</span><i aria-hidden="true" /></div>
          <h2 className="cap-heading">What ChainLens Does</h2>
          <p className="cap-sub">Eight features. One terminal. Built natively on Base.</p>
        </header></Reveal>

        <div className="cap-grid">
          {features.map((f, i) => (
            <SideSlideIn key={f.title} side={i % 2 === 0 ? 'left' : 'right'} delayMs={(i % 2) * 90}>
              <CapabilityCard feature={f} />
            </SideSlideIn>
          ))}
        </div>
      </div>

      <style>{`
        .cap-section{--mint:#1fd6dc;position:relative;z-index:1;width:100%;overflow:hidden;isolation:isolate;
          background:linear-gradient(180deg,#020303 0,#020303 calc(100% - 140px),#05050b 100%);
          font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}
        /* Silver hairline at the top edge, like the navbar's glints. */
        .cap-section::before{content:"";position:absolute;top:0;left:8%;right:8%;height:1px;z-index:1;
          background:linear-gradient(90deg,transparent,rgba(255,255,255,.10) 20%,rgba(255,255,255,.34) 46%,rgba(31,214,220,.30) 54%,rgba(255,255,255,.10) 80%,transparent)}
        .cap-inner{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:96px 24px 104px;box-sizing:border-box}

        .cap-waves{position:absolute;inset:0;z-index:0;pointer-events:none;
          -webkit-mask-image:linear-gradient(180deg,transparent 0,#000 18%,#000 82%,transparent 100%);mask-image:linear-gradient(180deg,transparent 0,#000 18%,#000 82%,transparent 100%)}
        .cap-ribbon{position:absolute;left:0;will-change:transform;animation:capFlow 46s linear infinite}
        .cap-ribbon-a{top:8%;animation-duration:52s}
        .cap-ribbon-b{top:56%;animation-duration:64s;animation-direction:reverse;opacity:.85}
        .cap-waves-paused .cap-ribbon{animation-play-state:paused}
        @keyframes capFlow{from{transform:translate3d(0,0,0)}to{transform:translate3d(-${PERIOD}px,0,0)}}

        .cap-header{text-align:center;margin-bottom:56px}
        .cap-eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:18px}
        .cap-eyebrow i{display:block;width:28px;height:1px;background:linear-gradient(90deg,transparent,var(--mint))}
        .cap-eyebrow i:last-child{background:linear-gradient(90deg,var(--mint),transparent)}
        .cap-eyebrow span{font:700 10px/1 var(--font-plex-mono,'IBM Plex Mono',monospace);letter-spacing:.22em;text-transform:uppercase;color:var(--mint)}
        .cap-heading{margin:0 0 16px;font-family:var(--font-sora,'Sora',sans-serif);font-weight:800;font-size:clamp(32px,4.4vw,54px);line-height:1.06;letter-spacing:-.02em;
          color:#eef1f2;background:linear-gradient(172deg,#ffffff 0%,#f1f3f4 45%,#bfc6cb 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
        .cap-sub{margin:0 auto;max-width:480px;font-size:16.5px;line-height:1.65;color:rgba(196,204,210,.62)}

        .cap-grid{display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:20px}
        .cap-grid > .side-in{height:100%;position:relative}
        /* The hovered card's popover must sit over the neighbouring cards. */
        .cap-grid > .side-in:hover{z-index:20}
        .cap-cell{position:relative;height:100%}

        .cap-card{position:relative;display:flex;flex-direction:column;min-height:236px;height:100%;box-sizing:border-box;padding:28px 28px 24px;border-radius:20px;overflow:hidden;isolation:isolate;
          background:linear-gradient(180deg,rgba(22,24,26,.78) 0%,rgba(8,9,10,.86) 100%);
          border:1px solid rgba(255,255,255,.08);
          box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 18px 44px rgba(0,0,0,.42);
          transition:transform .32s cubic-bezier(.22,1,.36,1),border-color .32s ease,box-shadow .32s ease}
        /* Top glint: silver at rest, crossfades to mint on hover. */
        .cap-card::before,.cap-card::after{content:"";position:absolute;top:0;left:0;right:0;height:1px;pointer-events:none;z-index:3;transition:opacity .32s ease}
        .cap-card::before{background:linear-gradient(90deg,transparent 6%,rgba(255,255,255,.10) 22%,rgba(255,255,255,.42) 46%,rgba(255,255,255,.12) 72%,transparent 94%)}
        .cap-card::after{opacity:0;background:linear-gradient(90deg,transparent 6%,rgba(31,214,220,.12) 22%,rgba(98,241,241,.65) 46%,rgba(31,214,220,.16) 72%,transparent 94%)}
        @media(hover:hover){
          .cap-card:hover{transform:translateY(-3px);border-color:rgba(31,214,220,.34);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 24px 52px rgba(0,0,0,.5),0 0 22px rgba(31,214,220,.07)}
          .cap-card:hover::before{opacity:0}
          .cap-card:hover::after{opacity:1}
          .cap-card:hover .cap-icon{color:var(--mint);border-color:rgba(31,214,220,.32)}
          .cap-card:hover .cap-link svg{transform:translateX(2px)}
          .cap-card:hover .cap-link{opacity:1}
        }
        .cap-card:has(.cap-link:focus-visible){border-color:rgba(31,214,220,.55);box-shadow:0 0 0 2px rgba(31,214,220,.35)}

        .cap-content{position:relative;z-index:1;display:flex;flex-direction:column;flex:1;transition:opacity .3s ease}
        .cap-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;margin-bottom:20px;border-radius:13px;color:#d9dfe2;
          background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.015));border:1px solid rgba(255,255,255,.10);
          box-shadow:inset 0 1px 0 rgba(255,255,255,.06);transition:color .32s ease,border-color .32s ease}
        .cap-icon svg{width:21px;height:21px}
        .cap-title{margin:0 0 10px;font-size:17.5px;font-weight:700;line-height:1.25;letter-spacing:-.01em;color:#f4f6f7}
        .cap-body{margin:0 0 22px;font-size:14.5px;line-height:1.7;color:rgba(196,204,210,.64)}

        .cap-foot{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:auto}
        .cap-link{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;color:var(--mint);opacity:.85;transition:opacity .2s ease}
        .cap-link svg{transition:transform .2s ease}
        .cap-card{cursor:pointer}
        .cap-link:focus-visible{outline:none}

        /* Video preview (FeatureVideoSlot). Popover: floats out below (or above) the hovered card. */
        .cap-media{position:relative;background:#030404;overflow:hidden}
        .cap-media video{display:block;width:100%;height:auto}
        .cap-media-popover{position:absolute;left:0;right:0;z-index:20;pointer-events:none;border-radius:16px;
          border:1px solid rgba(31,214,220,.38);
          box-shadow:0 0 0 1px rgba(0,0,0,.6),0 28px 64px rgba(0,0,0,.72),0 0 32px rgba(31,214,220,.12);
          opacity:0;transform:translateY(-8px) scale(.98);transform-origin:top center;
          transition:opacity .28s ease,transform .38s cubic-bezier(.22,1,.36,1)}
        .cap-media-popover[data-placement="below"]{top:calc(100% + 12px)}
        .cap-media-popover[data-placement="above"]{bottom:calc(100% + 12px);transform:translateY(8px) scale(.98);transform-origin:bottom center}
        .cap-media-popover[data-show]{opacity:1;transform:none}
        /* Mint glint on the popover's top edge, matching the cards. */
        .cap-media-popover::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;z-index:1;
          background:linear-gradient(90deg,transparent 6%,rgba(31,214,220,.12) 22%,rgba(98,241,241,.65) 46%,rgba(31,214,220,.16) 72%,transparent 94%)}

        /* Inline preview (touch): expands inside the card between the text and the footer. */
        .cap-media-inline{z-index:2;margin:0 0 18px;border-radius:12px;border:1px solid rgba(31,214,220,.28);cursor:zoom-in;
          min-height:120px;animation:capPreviewIn .32s cubic-bezier(.22,1,.36,1)}
        .cap-media-inline:not([data-show])::after{content:"";position:absolute;inset:0;margin:auto;width:22px;height:22px;border-radius:50%;box-sizing:border-box;
          border:2px solid rgba(31,214,220,.25);border-top-color:var(--mint);animation:capSpin .8s linear infinite}
        .cap-media-hint{position:absolute;right:8px;bottom:8px;padding:5px 8px;border-radius:999px;font:600 10px/1 var(--font-plex-mono,'IBM Plex Mono',monospace);
          letter-spacing:.06em;text-transform:uppercase;color:#d9f7f8;background:rgba(2,3,3,.72);border:1px solid rgba(31,214,220,.28)}
        @keyframes capPreviewIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
        @keyframes capSpin{to{transform:rotate(360deg)}}
        .cap-preview-btn{display:inline-flex;align-items:center;gap:7px;padding:9px 13px;border-radius:999px;cursor:pointer;
          font:700 11px/1 var(--font-jakarta,'Plus Jakarta Sans',sans-serif);letter-spacing:.06em;text-transform:uppercase;color:#e6fbfc;
          background:rgba(31,214,220,.08);border:1px solid rgba(31,214,220,.32);-webkit-tap-highlight-color:transparent}
        .cap-preview-btn:active{background:rgba(31,214,220,.16)}
        .cap-preview-btn svg{color:var(--mint)}
        .cap-card[data-open],.cap-cell[data-previewing] .cap-card{border-color:rgba(31,214,220,.34)}

        @media(max-width:767px){
          .cap-inner{padding:64px 16px 72px}
          .cap-header{margin-bottom:40px}
          .cap-grid{grid-template-columns:1fr;grid-auto-rows:auto;gap:14px}
          .cap-card{min-height:0;padding:22px 20px 20px}
          .cap-icon{width:42px;height:42px;margin-bottom:16px}
          .cap-body{margin-bottom:18px}
        }
        @media(prefers-reduced-motion:reduce){
          .cap-ribbon{animation:none}
          .cap-card,.cap-card::before,.cap-card::after,.cap-icon,.cap-content,.cap-link svg,.cap-media-popover{transition:none}
          .cap-media-inline,.cap-media-inline::after{animation:none}
          .cap-card:hover{transform:none}
        }
      `}</style>
    </section>
  )
}
