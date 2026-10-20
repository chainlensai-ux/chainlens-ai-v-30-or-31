'use client'

// Reversible homepage experiment: flip USE_REFERENCE_HERO to false to restore legacy homepage.
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useEffect, useRef, type CSSProperties, type RefObject } from 'react'
import Reveal from './Reveal'
import { LightBeamButton } from '@/components/ui/LightBeamButton'

const ConnectWallet = dynamic(() => import('@/components/ConnectWallet'), { ssr: false })

const featureCards = [
  { color: '#53F3C3', title: 'Token Risk Reads', desc: 'LP, owner, holders, security, deployer', icon: 'shield', proof: 'Every verdict shows the checks behind it: LP lock, owner rights, holder concentration, deployer history.' },
  { color: '#E053C2', title: 'Wallet Behavior', desc: 'FIFO lots, trade style, recovery gaps', icon: 'wallet', proof: 'PnL comes from matched buy and sell lots. Trades without a provable price are flagged, never guessed.' },
  { color: '#B666F3', title: 'Base Radar', desc: 'Early movers with liquidity filters', icon: 'bolt', proof: 'New Base pools are filtered on liquidity before they reach the feed, so dust launches stay out.' },
  { color: '#5b9dff', title: 'Clark AI', desc: 'Ask questions across every scan', icon: 'target', proof: 'Follow-ups draw on the token, wallet and radar scans you have already run.' },
]

// Scroll choreography (desktop only; phones and reduced-motion get everything static):
// 1. The hero is pinned for the first 40vh of scroll. The Market Overview card lifts toward the
//    centre and scales to 0.92 with the scroll; its rows leave upward 60ms apart, each sparkline
//    drawing left to right as its row goes, then the card fades.
// 2. Only once the card is gone does the headline fade, handing over to an 18px label parked
//    top-left.
// 3. The feature bar pins under that label and spreads into four stacked panels; scrolling then
//    walks the active panel 1 -> 4 before the stack releases.
const HERO_PIN_VH = 0.4
const CARD_OUT_AT = 0.12 // share of the hero pin at which the card's rows start leaving
const HEADLINE_OUT_AT = 0.8 // share of the hero pin after which the headline may fade
const CARD_SEQUENCE_MS = 820 // rows + card fade; keep in step with the [data-card-out] CSS below
const CARD_LIFT_PX = 40
const CARD_CENTER_PULL = 0.22 // share of the way the card moves toward the viewport's centre
const CARD_MIN_SCALE = 0.92
const STACK_RUN_PX = 1100 // scroll distance the stack stays pinned; matches --stack-run
const SPREAD_SHARE = 0.4 // share of that run spent spreading the bar into panels
const PARKED_FONT_PX = 18
const PARKED_GAP_PX = 16 // navbar bottom (or viewport top once the navbar has scrolled away) -> parked headline
const STAGE_GAP_PX = 44 // parked headline -> pinned panels

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const ease = (t: number) => t * t * (3 - 2 * t)
const easeOut = (t: number) => 1 - (1 - t) ** 3

type PinMode = 'before' | 'pinned' | 'after'

// Pinned with position:fixed rather than sticky: html and body both set overflow-x:hidden, which
// makes body a scroll container that never scrolls, so sticky never engages on this page.
function setPin(el: HTMLElement, mode: PinMode, top: number, afterTop: number, left?: number, width?: number) {
  el.dataset.pin = mode
  el.style.top = mode === 'pinned' ? `${top}px` : mode === 'after' ? `${afterTop}px` : ''
  el.style.left = mode === 'pinned' && left !== undefined ? `${left}px` : ''
  el.style.width = mode === 'pinned' && width !== undefined ? `${width}px` : ''
}

function useHeroChoreography(shellRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const heroPin = shell.querySelector<HTMLElement>('.ref-hero-pin')
    const heroLayer = shell.querySelector<HTMLElement>('.ref-hero-layer')
    const card = shell.querySelector<HTMLElement>('.ref-market-card')
    const cardSlot = shell.querySelector<HTMLElement>('.ref-card-slot')
    const wrap = shell.querySelector<HTMLElement>('.ref-stack')
    const stage = shell.querySelector<HTMLElement>('.ref-stack-stage')
    const headline = shell.querySelector<HTMLElement>('.ref-headline')
    const parked = shell.querySelector<HTMLElement>('.ref-parked')
    const scrim = shell.querySelector<HTMLElement>('.ref-park-scrim')
    const panels = Array.from(shell.querySelectorAll<HTMLElement>('.ref-panel'))
    if (!heroPin || !heroLayer || !card || !cardSlot || !wrap || !stage || !headline || !parked || !scrim) return
    const staticQuery = window.matchMedia('(max-width: 980px), (prefers-reduced-motion: reduce)')

    let frame = 0
    let heroDocTop = 0
    let cardOutSince = 0
    let headlineTimer: ReturnType<typeof setTimeout> | null = null
    const clearHeadlineTimer = () => { if (headlineTimer !== null) { clearTimeout(headlineTimer); headlineTimer = null } }
    const measure = () => { heroDocTop = heroPin.getBoundingClientRect().top + window.scrollY }
    const reset = () => {
      clearHeadlineTimer()
      setPin(heroLayer, 'before', 0, 0)
      delete heroLayer.dataset.pin
      heroPin.style.height = ''
      card.style.transform = ''
      delete shell.dataset.cardOut
      delete shell.dataset.headlineOut
      setPin(stage, 'before', 0, 0)
      wrap.style.removeProperty('--s')
      scrim.style.opacity = '0'
      panels.forEach((panel) => panel.classList.remove('is-active'))
    }
    const update = () => {
      frame = 0
      if (staticQuery.matches) { reset(); return }

      // 1. Hero pin + card exit.
      const pinRun = window.innerHeight * HERO_PIN_VH
      const pinRect = heroPin.getBoundingClientRect()
      const heroRaw = (heroDocTop - pinRect.top) / pinRun
      setPin(heroLayer, heroRaw <= 0 ? 'before' : heroRaw >= 1 ? 'after' : 'pinned', heroDocTop, pinRun, pinRect.left, pinRect.width)
      const lift = easeOut(clamp01(heroRaw / 0.5))
      const slot = cardSlot.getBoundingClientRect()
      const dx = (window.innerWidth / 2 - (slot.left + slot.width / 2)) * CARD_CENTER_PULL * lift
      card.style.transform = lift > 0 ? `translate3d(${dx.toFixed(1)}px, ${(-CARD_LIFT_PX * lift).toFixed(1)}px, 0) scale(${(1 - (1 - CARD_MIN_SCALE) * lift).toFixed(4)})` : ''
      const cardOut = heroRaw >= CARD_OUT_AT
      if (cardOut && shell.dataset.cardOut === undefined) { shell.dataset.cardOut = ''; cardOutSince = performance.now() }
      if (!cardOut) delete shell.dataset.cardOut

      // 2. Headline fades only once the card's own sequence has finished.
      if (cardOut && heroRaw >= HEADLINE_OUT_AT) {
        const wait = CARD_SEQUENCE_MS - (performance.now() - cardOutSince)
        if (wait <= 0) { clearHeadlineTimer(); shell.dataset.headlineOut = '' }
        else if (headlineTimer === null) headlineTimer = setTimeout(() => { headlineTimer = null; schedule() }, wait)
      } else {
        clearHeadlineTimer()
        delete shell.dataset.headlineOut
      }

      // 3. Feature stack.
      const nav = document.querySelector('.nav-outer')
      const parkY = Math.max(0, nav ? nav.getBoundingClientRect().bottom : 0) + PARKED_GAP_PX
      const stageTop = parkY + STAGE_GAP_PX
      const wrapRect = wrap.getBoundingClientRect()
      const raw = (stageTop - wrapRect.top) / STACK_RUN_PX
      const progress = clamp01(raw)
      setPin(stage, raw <= 0 ? 'before' : raw >= 1 ? 'after' : 'pinned', stageTop, STACK_RUN_PX, wrapRect.left, wrapRect.width)
      const spread = ease(clamp01(progress / SPREAD_SHARE))
      wrap.style.setProperty('--s', spread.toFixed(4))
      const active = progress < SPREAD_SHARE ? -1 : Math.min(panels.length - 1, Math.floor(((progress - SPREAD_SHARE) / (1 - SPREAD_SHARE)) * panels.length))
      panels.forEach((panel, index) => panel.classList.toggle('is-active', index === active))
      // The pinned layer leaves the flow, so its wrapper holds its height plus the pin's scroll run.
      heroPin.style.height = `${heroLayer.offsetHeight + pinRun}px`

      // Parked label: sits under the navbar, leaves with the panels once the stack releases.
      const y = Math.min(parkY, stage.getBoundingClientRect().top - STAGE_GAP_PX)
      parked.style.transform = `translate3d(${headline.getBoundingClientRect().left}px, ${y}px, 0)`
      scrim.style.height = `${parkY + PARKED_FONT_PX * 1.2 + 28}px`
      scrim.style.opacity = shell.dataset.headlineOut !== undefined ? String(clamp01(y / parkY)) : '0'
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const onResize = () => { reset(); measure(); schedule() }

    measure()
    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', onResize)
    staticQuery.addEventListener('change', onResize)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', onResize)
      staticQuery.removeEventListener('change', onResize)
      reset()
    }
  }, [shellRef])
}

const marketRows = [
  { color: '#61d66f', title: 'Market Read', body: 'Momentum is selective across sectors', path: 'M2 20 C7 14 9 18 13 10 C16 13 18 5 22 3 M14 4 H22 V12' },
  { color: '#4285ff', title: 'Liquidity Watch', body: 'Liquidity-supported moves have stronger follow-through', path: 'M12 2 C8 8 5 12 5 16 A7 7 0 0 0 19 16 C19 12 16 8 12 2 Z' },
  { color: '#ef4444', title: 'Main Risk', body: 'Microcap pumps can reverse fast', path: 'M12 3 L22 20 H2 Z M12 9 V14 M12 17 H12.01' },
  { color: '#8E5CFF', title: 'Best Next Step', body: 'Run Token Scanner before you enter', path: 'M12 2 V6 M12 18 V22 M2 12 H6 M18 12 H22 M7 7 L9.5 9.5 M14.5 14.5 L17 17 M17 7 L14.5 9.5 M9.5 14.5 L7 17 M12 8 A4 4 0 1 1 12 16 A4 4 0 0 1 12 8 Z' },
]

function MiniChart({ color, variant }: { color: string; variant: number }) {
  const paths = [
    'M2 31 L8 26 L13 28 L18 18 L24 22 L30 13 L35 17 L42 10 L47 24 L54 15 L60 19 L66 13 L72 9 L78 16 L84 5',
    'M2 27 L8 24 L14 29 L20 22 L26 25 L32 18 L38 31 L44 27 L50 14 L56 24 L62 21 L68 30 L74 17 L80 20 L84 9',
    'M2 26 L8 28 L14 25 L20 27 L26 23 L32 30 L38 13 L44 26 L50 20 L56 24 L62 31 L68 16 L74 22 L80 18 L84 7',
    'M2 30 L8 28 L14 24 L20 27 L26 21 L32 24 L38 17 L44 20 L50 16 L56 18 L62 13 L68 15 L74 10 L80 12 L84 6',
  ]
  return <svg className="ref-chart" width="86" height="36" viewBox="0 0 86 36" aria-hidden="true"><path d={paths[variant]} pathLength={1} fill="none" stroke={color} strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /><path d={`${paths[variant]} V36 H2 Z`} fill={color} opacity="0.08" /></svg>
}

function Icon({ name }: { name: string }) {
  const props = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (name === 'shield') return <svg {...props}><path d="M12 3l7 3v5c0 4.5-2.8 7.5-7 9-4.2-1.5-7-4.5-7-9V6l7-3z" /><path d="M9 12l2 2 4-5" /></svg>
  if (name === 'wallet') return <svg {...props}><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><circle cx="16.5" cy="15" r="1" /></svg>
  if (name === 'bolt') return <svg {...props}><path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z" /></svg>
  return <svg {...props}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
}

export default function ReferenceHero() {
  const shellRef = useRef<HTMLElement>(null)
  useHeroChoreography(shellRef)
  return (
    <>
      <section className="ref-home-shell" ref={shellRef}>
        <div className="ref-park-scrim" aria-hidden="true" />
        <div className="ref-parked" aria-hidden="true">Find the move before the <span>crowd.</span></div>
        <div className="ref-hero-pin"><div className="ref-hero-layer">
        <div className="ref-bg" aria-hidden="true" />
        <main className="ref-hero">
          <div className="ref-copy">
            {/* SCROLL REVEAL, DISCLOSED (homepage reveal task): badge -> title -> buttons -> trust
                line, staggered per the task's required order. The wallet-connection line is
                deliberately left OUT of the reveal (always rendered, never animated) — this is a
                live, clickable control (ConnectWallet), not decorative copy. */}
            <Reveal><div className="ref-badge"><span className="ref-badge-tick"><i /></span>Powered by <b>Cortex Engine</b></div></Reveal>
            <div className="ref-headline"><Reveal delayMs={70}><h1>Find the move<br />before the <span>crowd.</span></h1></Reveal></div>
            <Reveal delayMs={120}><p className="ref-sub">CORTEX reads token risk, wallet behavior, and liquidity on Base in real time, so you move before the crowd does.</p></Reveal>
            <Reveal delayMs={170}><div className="ref-ctas">
              <LightBeamButton className="ref-btn ref-btn-beam" href="/terminal"><span className="ref-terminal-mark">›_</span> Launch Terminal <span>→</span></LightBeamButton>
              <Link className="ref-btn ref-btn-secondary" href="/terminal/token-scanner">Scan Token Free</Link>
            </div></Reveal>
            <div className="ref-wallet-line" aria-label="Wallet connection status"><span className="ref-wallet-dot" /><div className="ref-wallet-mini"><ConnectWallet className="ref-wallet-widget" /></div></div>
          </div>

          <Reveal delayMs={100}><div className="ref-card-slot"><aside className="ref-market-card" aria-label="Market overview">
            <div className="ref-card-head"><span>MARKET OVERVIEW</span><button type="button"><span />Base Network <svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg></button></div>
            <div className="ref-market-list">
              {marketRows.map((row, index) => (
                <div className="ref-market-row" key={row.title} style={{ '--d': `${index * 60}ms`, '--r': `${(marketRows.length - 1 - index) * 40}ms` } as CSSProperties}>
                  <div className="ref-market-icon" style={{ color: row.color, background: `${row.color}16`, borderColor: `${row.color}28` }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={row.path} /></svg></div>
                  <div className="ref-market-text"><strong>{row.title}</strong><span>{row.body}</span></div>
                  <MiniChart color={row.color} variant={index} />
                </div>
              ))}
            </div>
            <div className="ref-card-foot"><span>Live data from onchain activity and liquidity, not hype.</span><span className="ref-updated"><i />Updated just now</span></div>
          </aside></div></Reveal>

          <div className="ref-stack">
            <div className="ref-stack-stage">
              <Reveal delayMs={260}><div className="ref-stack-inner">
                <div className="ref-stack-shell" aria-hidden="true" />
                {featureCards.map((item, index) => (
                  <div className="ref-panel" key={item.title} style={{ '--i': index, '--c': item.color } as CSSProperties}>
                    <div className="ref-feature-icon" style={{ color: item.color, borderColor: `${item.color}55`, boxShadow: `0 0 12px ${item.color}18` }}><Icon name={item.icon} /></div>
                    <div className="ref-panel-text"><strong>{item.title}</strong><span>{item.desc}</span><p>{item.proof}</p></div>
                    <b className="ref-panel-index">0{index + 1}<i>/0{featureCards.length}</i></b>
                    {index < featureCards.length - 1 ? <em /> : null}
                  </div>
                ))}
              </div></Reveal>
            </div>
          </div>
        </main>
        </div></div>
      </section>
      <style>{`
        .ref-home-shell{--mint:#53F3C3;--pink:#E053C2;--purple:#B666F3;--cyan:#5b9dff;position:relative;min-height:760px;background:#03060D;overflow:clip;margin-top:-80px;padding-top:80px;color:#fff}.ref-bg{position:absolute;left:0;right:0;top:0;height:900px;background:radial-gradient(42% 36% at 20% 24%,rgba(83,243,195,.12),transparent 58%),radial-gradient(38% 38% at 88% 24%,rgba(182,102,243,.16),transparent 62%),radial-gradient(28% 30% at 72% 68%,rgba(224,83,194,.10),transparent 68%),linear-gradient(180deg,#03060D 0%,#050812 56%,#03060D 100%)}.ref-bg:before{content:"";position:absolute;left:-8%;right:-8%;bottom:40px;height:250px;background:repeating-radial-gradient(ellipse at 50% 110%,transparent 0 26px,rgba(83,243,195,.08) 27px,transparent 29px),repeating-radial-gradient(ellipse at 50% 112%,transparent 0 42px,rgba(182,102,243,.10) 43px,transparent 45px);filter:blur(.4px);opacity:.58;-webkit-mask-image:linear-gradient(180deg,#000 45%,transparent);mask-image:linear-gradient(180deg,#000 45%,transparent)}.ref-bg:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px);background-size:96px 96px;mask-image:radial-gradient(circle at 50% 35%,black,transparent 72%);opacity:.18}.ref-hero{position:relative;z-index:1;max-width:1220px;margin:0 auto;padding:76px 24px 54px;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(390px,540px);gap:60px;align-items:center;font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}.ref-copy{padding-left:4px}.ref-badge{display:inline-flex;align-items:center;gap:10px;margin-bottom:18px;font:500 11px/1 var(--font-plex-mono,monospace);letter-spacing:.1em;color:rgba(226,232,240,.62);text-transform:uppercase}.ref-badge b{color:#d7bcf7;font-weight:600}.ref-badge-tick{width:15px;height:15px;border-radius:4px;border:1.4px solid rgba(182,102,243,.5);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}.ref-badge-tick i{width:5px;height:5px;border-radius:1px;background:var(--purple)}.ref-copy h1{margin:0 0 16px;font-size:clamp(36px,4.6vw,58px);line-height:1.07;letter-spacing:-.025em;font-weight:800;color:#f8fafc;font-family:var(--font-sora,'Sora',sans-serif)}.ref-copy h1 span{white-space:nowrap;background:linear-gradient(94deg,var(--pink) 3%,var(--purple) 54%,var(--mint) 108%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}.ref-sub{max-width:480px;margin:0 0 28px;color:rgba(226,232,240,.62);font-size:16.5px;line-height:1.6;font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}.ref-ctas{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:18px}.ref-btn{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:12px;min-height:54px;padding:0 28px;border-radius:13px;color:#fff;text-decoration:none;text-transform:uppercase;font-size:12px;font-weight:800;letter-spacing:.05em;transition:transform .18s ease,box-shadow .18s ease,background .18s ease,border-color .18s ease}.ref-btn::after{content:'';position:absolute;top:0;left:-70%;width:45%;height:100%;background:linear-gradient(115deg,transparent,rgba(255,255,255,.5),transparent);transform:skewX(-18deg);transition:left .55s ease}.ref-btn:hover::after{left:130%}.ref-btn-primary{min-width:230px;border:1.5px solid rgba(224,83,194,.75);background:rgba(182,102,243,.08);box-shadow:0 0 0 1px rgba(182,102,243,.12) inset,0 0 22px rgba(224,83,194,.16)}.ref-btn-primary:hover{transform:translateY(-2px);border-color:var(--mint);background:rgba(182,102,243,.16);box-shadow:0 0 0 1px rgba(182,102,243,.2) inset,0 12px 34px rgba(224,83,194,.32),0 0 26px rgba(83,243,195,.2)}.ref-btn-beam{min-width:230px}.ref-btn-secondary{min-width:184px;border:1px solid rgba(148,163,184,.22);background:rgba(255,255,255,.02)}.ref-btn-secondary:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.34);background:rgba(255,255,255,.04)}.ref-terminal-mark{font-family:var(--font-plex-mono,monospace);font-size:16px;color:#d8fff8}.ref-wallet-line{display:inline-flex;align-items:center;gap:9px;margin:2px 0 20px;padding:7px 14px;border:1px solid rgba(148,163,184,.16);border-radius:999px;background:rgba(255,255,255,.02)}.ref-wallet-dot{width:6px;height:6px;border-radius:50%;background:var(--mint);box-shadow:0 0 6px rgba(83,243,195,.70);flex-shrink:0}.ref-wallet-mini{display:flex;align-items:center}.ref-wallet-widget{display:flex!important;align-items:center!important;gap:8px!important}.ref-wallet-widget>button,button.ref-wallet-widget{width:auto!important;min-width:0!important;padding:5px 13px!important;font-size:10.5px!important;font-weight:700!important;letter-spacing:.05em!important;text-transform:uppercase!important;border-radius:999px!important;box-shadow:none!important;background:rgba(255,255,255,.025)!important;color:#9fdccb!important;border:1px solid rgba(255,255,255,.14)!important;transition:background .15s,border-color .15s!important}.ref-wallet-widget>button:hover,button.ref-wallet-widget:hover{background:rgba(83,243,195,.09)!important;border-color:rgba(83,243,195,.4)!important}.ref-wallet-widget>div:nth-of-type(1){order:-1;font-size:12px!important;color:rgba(226,232,240,.66)!important;text-align:left!important;font-family:var(--font-plex-mono,monospace)!important;letter-spacing:.02em!important}.ref-wallet-widget>div:nth-of-type(1)::after{content:'·';margin-left:6px;color:rgba(148,163,184,.35)}.ref-wallet-widget>div:nth-of-type(2){display:none!important}.ref-market-card{padding:26px;border-radius:22px;background:linear-gradient(180deg,rgba(8,14,31,.80),rgba(5,9,22,.64));border:1px solid rgba(148,163,184,.20);box-shadow:0 32px 84px rgba(0,0,0,.50),0 0 44px rgba(83,243,195,.05),0 0 64px rgba(182,102,243,.035),inset 0 1px 0 rgba(255,255,255,.09);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.ref-card-head,.ref-card-foot{display:flex;align-items:center;justify-content:space-between;gap:14px}.ref-card-head{margin-bottom:16px}.ref-card-head>span{font-size:13px;font-weight:800;color:rgba(248,250,252,.86)}.ref-card-head button{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;color:rgba(226,232,240,.75);font-size:12px}.ref-card-head button span{width:12px;height:12px;border-radius:50%;background:#3272ff;box-shadow:inset -3px -3px 0 rgba(255,255,255,.18)}.ref-market-list{display:flex;flex-direction:column}.ref-market-row{display:grid;grid-template-columns:46px minmax(0,1fr) 96px;gap:15px;align-items:center;padding:17px 14px;margin:0 -14px;border-radius:12px;border-top:1px solid rgba(148,163,184,.09);transition:background .15s ease}.ref-market-row:first-child{border-top:0}.ref-market-row:hover{background:rgba(255,255,255,.022)}.ref-market-icon{width:44px;height:44px;border:1px solid;border-radius:50%;display:flex;align-items:center;justify-content:center}.ref-market-text strong{display:block;color:#f8fafc;font-size:13px;margin-bottom:3px}.ref-market-text span{display:block;color:rgba(226,232,240,.63);font-size:12px;line-height:1.42}.ref-chart{opacity:.78;filter:drop-shadow(0 0 8px currentColor)}.ref-card-foot{padding-top:13px;border-top:1px solid rgba(148,163,184,.09);font-size:11px;color:rgba(226,232,240,.55)}.ref-updated{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}.ref-updated i{width:9px;height:9px;border:1.5px solid #53F3C3;border-left-color:transparent;border-radius:50%}.ref-park-scrim{position:fixed;left:0;right:0;top:0;z-index:89;opacity:0;pointer-events:none;transition:opacity .42s cubic-bezier(.22,1,.36,1);background:linear-gradient(180deg,#03060D 0%,#03060D calc(100% - 28px),rgba(3,6,13,0) 100%)}.ref-parked{position:fixed;left:0;top:0;z-index:90;opacity:0;pointer-events:none;will-change:transform;font:800 18px/1.2 var(--font-sora,'Sora',sans-serif);color:#f8fafc;letter-spacing:-.01em;white-space:nowrap;transition:opacity .42s cubic-bezier(.22,1,.36,1)}.ref-parked span{background:linear-gradient(94deg,var(--pink) 3%,var(--purple) 54%,var(--mint) 108%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}.ref-home-shell[data-headline-out] .ref-parked{opacity:1}.ref-hero-pin{position:relative}.ref-hero-layer{position:relative;z-index:1}.ref-hero-layer[data-pin=before]{position:absolute;top:0;left:0;right:0}.ref-hero-layer[data-pin=after]{position:absolute;left:0;right:0}.ref-hero-layer[data-pin=pinned]{position:fixed}.ref-headline{transition:opacity .42s cubic-bezier(.22,1,.36,1)}.ref-home-shell[data-headline-out] .ref-headline{opacity:0}.ref-market-card{will-change:transform;transition:opacity .24s cubic-bezier(.22,1,.36,1)}.ref-home-shell[data-card-out] .ref-market-card{opacity:0;transition:opacity .26s cubic-bezier(.22,1,.36,1) .56s}.ref-market-row{transition:transform .4s cubic-bezier(.22,1,.36,1) var(--r),opacity .3s cubic-bezier(.22,1,.36,1) var(--r)}.ref-home-shell[data-card-out] .ref-market-row{transform:translateY(-22px);opacity:0;transition:transform .48s cubic-bezier(.22,1,.36,1) var(--d),opacity .4s cubic-bezier(.22,1,.36,1) calc(var(--d) + .12s)}.ref-chart path:first-child{stroke-dasharray:1}.ref-home-shell[data-card-out] .ref-market-row .ref-chart path:first-child{animation:ref-spark-draw .34s cubic-bezier(.22,1,.36,1) var(--d) forwards}@keyframes ref-spark-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}.ref-card-head,.ref-card-foot{transition:opacity .3s cubic-bezier(.22,1,.36,1)}.ref-home-shell[data-card-out] .ref-card-head{opacity:0}.ref-home-shell[data-card-out] .ref-card-foot{opacity:0;transition-delay:.3s}.ref-stack{--s:0;--bh:92px;--ph:132px;--gap:14px;--stack-run:1100px;--stage-h:calc(var(--bh) + var(--s) * (4 * var(--ph) + 3 * var(--gap) - var(--bh)));grid-column:1/-1;position:relative;margin-top:32px;height:calc(var(--stage-h) + var(--stack-run))}.ref-stack-stage{position:absolute;top:0;left:0;right:0;z-index:2;height:var(--stage-h)}.ref-stack-stage[data-pin=pinned]{position:fixed;right:auto}.ref-stack-inner{position:absolute;inset:0}.ref-stack-shell{position:absolute;left:0;right:0;top:0;height:var(--bh);border:1px solid rgba(148,163,184,.16);border-radius:20px;background:linear-gradient(180deg,rgba(8,14,31,.78),rgba(5,9,22,.66));box-shadow:0 22px 60px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.06);opacity:calc(1 - var(--s) * 2.5)}.ref-panel{position:absolute;left:calc((1 - var(--s)) * var(--i) * 25%);top:calc(var(--s) * var(--i) * (var(--ph) + var(--gap)));width:calc(25% + var(--s) * 75%);height:calc(var(--bh) + var(--s) * (var(--ph) - var(--bh)));display:flex;align-items:center;gap:15px;padding:0 22px;min-width:0;overflow:hidden;border-radius:calc(var(--s) * 18px)}.ref-panel:before{content:'';position:absolute;inset:0;border-radius:inherit;border:1px solid rgba(148,163,184,.16);background:linear-gradient(180deg,rgba(8,14,31,.86),rgba(5,9,22,.74));box-shadow:0 18px 48px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.05);opacity:var(--s);transition:border-color .25s ease,box-shadow .25s ease}.ref-panel:after{content:'';position:absolute;left:0;top:18%;bottom:18%;width:2px;border-radius:2px;background:var(--c);opacity:0;transition:opacity .25s ease}.ref-panel>*{position:relative}.ref-panel em{position:absolute;right:0;top:18%;bottom:18%;width:1px;background:rgba(148,163,184,.14);opacity:calc(1 - var(--s) * 3)}.ref-panel-text{min-width:0;flex:1}.ref-panel strong{display:block;color:#f8fafc;font-size:13px;margin-bottom:4px}.ref-panel span{display:block;color:rgba(226,232,240,.60);font-size:12px;line-height:1.42}.ref-panel p{margin:0;max-height:calc(var(--s) * 40px);padding-top:calc(var(--s) * 9px);opacity:calc((var(--s) - .6) * 2.5);color:rgba(226,232,240,.5);font-size:13px;line-height:1.5;font-family:var(--font-plex-mono,monospace);letter-spacing:-.01em;transition:color .25s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ref-panel-index{flex:0 0 auto;align-self:flex-start;margin-top:calc(var(--s) * 30px);font:600 12px/1 var(--font-plex-mono,monospace);color:rgba(226,232,240,.5);opacity:calc((var(--s) - .6) * 2.5);display:var(--index-display,block)}.ref-panel-index i{font-style:normal;color:rgba(148,163,184,.35)}.ref-panel.is-active:before{border-color:color-mix(in srgb,var(--c) 50%,transparent);box-shadow:0 22px 60px -18px color-mix(in srgb,var(--c) 38%,transparent),inset 0 1px 0 rgba(255,255,255,.07)}.ref-panel.is-active:after{opacity:1}.ref-panel.is-active p{color:rgba(226,232,240,.86)}.ref-panel.is-active .ref-panel-index{color:var(--c)}.ref-feature-icon{width:40px;height:40px;flex:0 0 auto;border:1px solid;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.54)}@media(prefers-reduced-motion:reduce){.ref-stack{height:auto}.ref-stack-stage{position:static;height:auto}.ref-stack-inner{position:static;display:flex;flex-direction:column;gap:12px}.ref-stack-shell,.ref-panel em{display:none}.ref-panel{position:relative;left:auto;top:auto;width:100%;height:auto;padding:20px 22px;border-radius:18px}.ref-panel:before{opacity:1}.ref-panel p{max-height:none;padding-top:8px;opacity:1}.ref-panel-index{opacity:1;margin-top:2px}.ref-parked,.ref-park-scrim{display:none}.ref-market-row,.ref-market-card,.ref-card-head,.ref-card-foot,.ref-headline{transition:none}}@media(max-width:980px){.ref-home-shell{margin-top:-64px;padding-top:64px}.ref-hero{grid-template-columns:1fr;gap:34px;padding:58px 20px 44px;max-width:760px}.ref-copy{padding-left:0}.ref-market-card{max-width:620px;width:100%}.ref-stack{height:auto;margin-top:24px}.ref-stack-stage{position:static;height:auto}.ref-stack-inner{position:static;display:flex;flex-direction:column;gap:12px}.ref-stack-shell,.ref-panel em{display:none}.ref-panel{position:relative;left:auto;top:auto;width:100%;height:auto;padding:20px;border-radius:18px;align-items:flex-start}.ref-panel:before{opacity:1}.ref-panel p{max-height:none;padding-top:8px;opacity:1;white-space:normal}.ref-panel-index{margin-top:2px;opacity:1}.ref-parked,.ref-park-scrim{display:none}.ref-market-row,.ref-market-card,.ref-card-head,.ref-card-foot,.ref-headline{transition:none}}@media(max-width:640px){.ref-home-shell{margin-top:-64px;padding-top:64px}.ref-hero{padding:44px 16px 34px}.ref-copy h1{font-size:clamp(32px,10vw,44px)}.ref-copy h1 span{white-space:normal}.ref-sub{font-size:16px}.ref-ctas{flex-direction:column;gap:12px}.ref-btn{width:100%;min-width:0}.ref-wallet-line{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding:7px 13px;border-radius:14px}.ref-market-card{padding:18px;border-radius:18px}.ref-card-head{align-items:flex-start}.ref-market-row{grid-template-columns:38px 1fr;gap:12px}.ref-chart{grid-column:2;width:100%;max-width:210px}.ref-card-foot{align-items:flex-start;flex-direction:column}.ref-panel-index{display:none}}
      `}</style>
    </>
  )
}
