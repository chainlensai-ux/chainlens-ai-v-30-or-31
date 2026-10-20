'use client'

// Reversible homepage experiment: flip USE_REFERENCE_HERO to false to restore legacy homepage.
import Link from 'next/link'
import { useEffect, useRef, type RefObject } from 'react'

// An illustrative Token Scanner result, labelled "Example scan" on the card. The same three
// findings feed the proof block under the hero so the two always agree.
const exampleScan = {
  ticker: '$XMPL',
  chain: 'Base',
  riskScore: 82,
  riskLabel: 'High risk',
  rows: [
    { label: 'LP', value: 'Unlocked', note: 'Deployer can pull liquidity', tone: 'bad' },
    { label: 'Top-10 holders', value: '61%', note: 'of supply in ten wallets', tone: 'bad' },
    { label: 'Deployer age', value: '3 days', note: 'Fresh wallet, no history', tone: 'warn' },
  ],
  verdict: 'Unlocked LP · concentrated holders · don\u2019t enter.',
} as const

const lookedFine = ['Chart up 40% today', '1,200 holders', 'Trending on X']
const flagged = [
  { title: 'LP unlocked', body: 'The deployer can pull the liquidity at any time.' },
  { title: 'Top 10 wallets hold 61%', body: 'A few sellers can take the price down alone.' },
  { title: 'Deployer wallet is 3 days old', body: 'No track record to check it against.' },
]

// Scroll-linked split (desktop only; phones and reduced-motion keep the static hero).
// The server renders the hero together, and --split / --late default to 0, so the first paint
// is always the original layout. Scrolling down drives both values from scroll position alone:
// the headline drifts left and up, the scan card right and up, and the subcopy and buttons fade and
// drop once the split is under way. Scrolling back to the top returns both values to exactly 0.
const SPLIT_RUN_VH = 0.5 // scroll distance, as a share of the viewport, for the full split
const LATE_START = 0.25 // share of the split before the subcopy and buttons begin to leave

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const smooth = (t: number) => t * t * (3 - 2 * t)

function useHeroSplit(shellRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const motionQuery = window.matchMedia('(min-width: 981px) and (prefers-reduced-motion: no-preference)')

    // Every load starts together: never let the browser restore a mid-split scroll position.
    const previousRestoration = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    window.scrollTo(0, 0)
    let userScrolled = false
    const markUserScroll = () => { userScrolled = true }
    const onLoad = () => { if (!userScrolled) window.scrollTo(0, 0); schedule() }
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) { window.scrollTo(0, 0); schedule() } }

    let frame = 0
    const update = () => {
      frame = 0
      const progress = motionQuery.matches ? clamp01(window.scrollY / (window.innerHeight * SPLIT_RUN_VH)) : 0
      if (progress === 0) {
        shell.style.removeProperty('--split')
        shell.style.removeProperty('--late')
        return
      }
      shell.style.setProperty('--split', smooth(progress).toFixed(4))
      shell.style.setProperty('--late', smooth(clamp01((progress - LATE_START) / (1 - LATE_START))).toFixed(4))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }

    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    motionQuery.addEventListener('change', schedule)
    window.addEventListener('pageshow', onPageShow)
    for (const type of ['wheel', 'touchstart', 'keydown'] as const) window.addEventListener(type, markUserScroll, { passive: true, once: true })
    if (document.readyState !== 'complete') window.addEventListener('load', onLoad, { once: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      motionQuery.removeEventListener('change', schedule)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('load', onLoad)
      for (const type of ['wheel', 'touchstart', 'keydown'] as const) window.removeEventListener(type, markUserScroll)
      window.history.scrollRestoration = previousRestoration
      shell.style.removeProperty('--split')
      shell.style.removeProperty('--late')
    }
  }, [shellRef])
}

export default function ReferenceHero() {
  const shellRef = useRef<HTMLElement>(null)
  useHeroSplit(shellRef)
  return (
    <>
      <section className="ref-home-shell" ref={shellRef}>
        <div className="ref-bg" aria-hidden="true" />
        <main className="ref-hero">
          <div className="ref-copy">
            <div className="ref-copy-head">
              <div className="ref-badge"><span className="ref-badge-tick"><i /></span>Powered by <b>Cortex Engine</b></div>
              <h1>Don&apos;t ape<br /><span>blind.</span></h1>
            </div>
            <div className="ref-copy-tail">
              <p className="ref-sub">Paste a token. Get the LP, the holders, the deployer, and the gaps before you buy.</p>
              <div className="ref-ctas">
                <Link className="ref-btn ref-btn-scan" href="/terminal/token-scanner">Scan Token Free</Link>
                <Link className="ref-btn ref-btn-terminal" href="/terminal"><span className="ref-terminal-mark" aria-hidden="true">›_</span>Launch Terminal</Link>
              </div>
            </div>
          </div>

          <aside className="ref-market-card ref-receipt" aria-label="Example Token Scanner result">
            <div className="ref-card-head"><span>TOKEN SCANNER</span><em className="ref-receipt-tag">Example scan</em></div>
            <div className="ref-receipt-token">
              <strong>{exampleScan.ticker}</strong>
              <span className="ref-receipt-chain"><i />{exampleScan.chain}</span>
            </div>
            <div className="ref-receipt-score">
              <div><span className="ref-receipt-label">Risk score</span><b>{exampleScan.riskScore}<small>/100</small></b></div>
              <span className="ref-receipt-pill">{exampleScan.riskLabel}</span>
            </div>
            <div className="ref-receipt-bar" aria-hidden="true"><i style={{ width: `${exampleScan.riskScore}%` }} /></div>
            <dl className="ref-receipt-rows">
              {exampleScan.rows.map((row) => (
                <div key={row.label} className={`ref-receipt-row is-${row.tone}`}>
                  <dt>{row.label}</dt>
                  <dd><b>{row.value}</b><span>{row.note}</span></dd>
                </div>
              ))}
            </dl>
            <p className="ref-receipt-verdict">{exampleScan.verdict}</p>
          </aside>

          <section className="ref-proof" aria-label="What a scan changes">
            <div className="ref-proof-before">
              <span className="ref-proof-kicker">Before the scan</span>
              <h2>Looked fine.</h2>
              <ul>{lookedFine.map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
            <div className="ref-proof-after">
              <span className="ref-proof-kicker">What ChainLens flagged</span>
              <ol>
                {flagged.map((item) => (
                  <li key={item.title}><strong>{item.title}</strong><span>{item.body}</span></li>
                ))}
              </ol>
            </div>
          </section>
        </main>
      </section>
      <style>{`
        .ref-home-shell{--split:0;--late:0;--drift-x:min(120px,8vw);--drift-y:36px;--mint:#53F3C3;--pink:#E053C2;--purple:#B666F3;--cyan:#5b9dff;position:relative;min-height:760px;background:#03060D;overflow:hidden;margin-top:-80px;padding-top:80px;color:#fff}.ref-bg{position:absolute;inset:0;background:radial-gradient(42% 36% at 20% 24%,rgba(83,243,195,.12),transparent 58%),radial-gradient(38% 38% at 88% 24%,rgba(182,102,243,.16),transparent 62%),radial-gradient(28% 30% at 72% 68%,rgba(224,83,194,.10),transparent 68%),linear-gradient(180deg,#03060D 0%,#050812 56%,#03060D 100%)}.ref-bg:before{content:"";position:absolute;left:-8%;right:-8%;bottom:40px;height:250px;background:repeating-radial-gradient(ellipse at 50% 110%,transparent 0 26px,rgba(83,243,195,.08) 27px,transparent 29px),repeating-radial-gradient(ellipse at 50% 112%,transparent 0 42px,rgba(182,102,243,.10) 43px,transparent 45px);filter:blur(.4px);opacity:.58}.ref-bg:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px);background-size:96px 96px;mask-image:radial-gradient(circle at 50% 35%,black,transparent 72%);opacity:.18}.ref-hero{position:relative;z-index:1;max-width:1220px;margin:0 auto;padding:28px 24px 28px;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(390px,540px);column-gap:60px;row-gap:20px;align-items:center;font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}.ref-copy{padding-left:4px}.ref-badge{display:inline-flex;align-items:center;gap:10px;margin-bottom:18px;font:500 11px/1 var(--font-plex-mono,monospace);letter-spacing:.1em;color:rgba(226,232,240,.62);text-transform:uppercase}.ref-badge b{color:#d7bcf7;font-weight:600}.ref-badge-tick{width:15px;height:15px;border-radius:4px;border:1.4px solid rgba(182,102,243,.5);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}.ref-badge-tick i{width:5px;height:5px;border-radius:1px;background:var(--purple)}.ref-copy h1{margin:0 0 16px;font-size:clamp(36px,4.6vw,58px);line-height:1.07;letter-spacing:-.025em;font-weight:800;color:#f8fafc;font-family:var(--font-sora,'Sora',sans-serif)}.ref-copy h1 span{white-space:nowrap;background:linear-gradient(94deg,var(--pink) 3%,var(--purple) 54%,var(--mint) 108%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}.ref-sub{max-width:480px;margin:0 0 24px;color:rgba(226,232,240,.62);font-size:16.5px;line-height:1.6;font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}.ref-ctas{display:flex;gap:14px;flex-wrap:wrap}.ref-btn{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:12px;min-height:54px;padding:0 28px;border-radius:13px;color:#fff;text-decoration:none;text-transform:uppercase;font-size:12px;font-weight:800;letter-spacing:.05em;transition:transform .18s ease,box-shadow .18s ease,background .18s ease,border-color .18s ease}.ref-btn::after{content:'';position:absolute;top:0;left:-70%;width:45%;height:100%;background:linear-gradient(115deg,transparent,rgba(255,255,255,.5),transparent);transform:skewX(-18deg);transition:left .55s ease}.ref-btn:hover::after{left:130%}.ref-btn-secondary{min-width:184px;border:1px solid rgba(148,163,184,.22);background:rgba(255,255,255,.02)}.ref-btn-secondary:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.34);background:rgba(255,255,255,.04)}.ref-market-card{padding:20px 24px;border-radius:22px;background:linear-gradient(180deg,rgba(8,14,31,.80),rgba(5,9,22,.64));border:1px solid rgba(148,163,184,.20);box-shadow:0 32px 84px rgba(0,0,0,.50),0 0 44px rgba(83,243,195,.05),0 0 64px rgba(182,102,243,.035),inset 0 1px 0 rgba(255,255,255,.09);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.ref-card-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}.ref-card-head>span{font-size:13px;font-weight:800;color:rgba(248,250,252,.86)}.ref-btn{min-height:52px}.ref-btn-scan{min-width:212px;border:1px solid rgba(83,243,195,.62);background:rgba(8,20,24,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:#d8fff4;letter-spacing:.08em}.ref-btn-scan:hover{transform:translateY(-2px);border-color:#53F3C3;background:rgba(83,243,195,.07);color:#fff}.ref-btn-terminal{min-width:212px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.02);color:rgba(255,255,255,.86);letter-spacing:.08em}.ref-btn-terminal:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.3);background:rgba(255,255,255,.045);color:#fff}.ref-terminal-mark{font-family:var(--font-plex-mono,monospace);font-size:15px;color:rgba(216,255,248,.8);letter-spacing:0}.ref-card-head{margin-bottom:14px}.ref-receipt-tag{font:600 10px/1 var(--font-plex-mono,monospace);font-style:normal;letter-spacing:.08em;text-transform:uppercase;color:rgba(226,232,240,.5);padding:5px 9px;border:1px solid rgba(148,163,184,.18);border-radius:999px}.ref-receipt-token{display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid rgba(148,163,184,.09)}.ref-receipt-token strong{font:700 26px/1 var(--font-sora,'Sora',sans-serif);letter-spacing:-.02em;color:#f8fafc}.ref-receipt-chain{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:rgba(50,114,255,.1);border:1px solid rgba(50,114,255,.28);color:#a9c4ff;font-size:11px;font-weight:600}.ref-receipt-chain i{width:8px;height:8px;border-radius:50%;background:#3272ff}.ref-receipt-score{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;padding-top:14px}.ref-receipt-label{display:block;font-size:11px;color:rgba(226,232,240,.55);margin-bottom:6px}.ref-receipt-score b{font:700 40px/1 var(--font-sora,'Sora',sans-serif);color:#f87171;letter-spacing:-.03em}.ref-receipt-score small{font-size:14px;color:rgba(226,232,240,.4);font-weight:600;margin-left:3px;letter-spacing:0}.ref-receipt-pill{padding:5px 10px;border-radius:999px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.32);color:#fca5a5;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.ref-receipt-bar{height:4px;margin:12px 0 4px;border-radius:999px;background:rgba(148,163,184,.12);overflow:hidden}.ref-receipt-bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#f59e0b,#ef4444)}.ref-receipt-rows{margin:0}.ref-receipt-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:14px;align-items:baseline;padding:11px 0;border-top:1px solid rgba(148,163,184,.09)}.ref-receipt-row:first-child{border-top:0}.ref-receipt-row dt{font-size:12px;color:rgba(226,232,240,.55)}.ref-receipt-row dd{margin:0;display:flex;align-items:baseline;gap:10px;min-width:0}.ref-receipt-row dd b{font-size:14px;font-weight:700}.ref-receipt-row dd span{font-size:12px;color:rgba(226,232,240,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ref-receipt-row.is-bad dd b{color:#f87171}.ref-receipt-row.is-warn dd b{color:#fbbf24}.ref-receipt-verdict{margin:4px 0 0;padding:11px 14px;border-radius:12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.22);color:#fecaca;font-size:13px;font-weight:600}.ref-proof{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);margin-top:0;border:1px solid rgba(148,163,184,.16);border-radius:20px;background:linear-gradient(180deg,rgba(8,14,31,.78),rgba(5,9,22,.66));box-shadow:0 22px 60px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden}.ref-proof-before,.ref-proof-after{padding:20px 28px}.ref-proof-before{border-right:1px solid rgba(148,163,184,.12)}.ref-proof-after{background:linear-gradient(90deg,rgba(239,68,68,.05),transparent 70%)}.ref-proof-kicker{display:block;margin-bottom:10px;font:600 10px/1 var(--font-plex-mono,monospace);letter-spacing:.12em;text-transform:uppercase;color:rgba(226,232,240,.5)}.ref-proof-after .ref-proof-kicker{color:#fca5a5}.ref-proof h2{margin:0 0 12px;font:800 26px/1.1 var(--font-sora,'Sora',sans-serif);letter-spacing:-.02em;color:#f8fafc}.ref-proof ul{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:8px}.ref-proof ul li{padding:6px 11px;border-radius:999px;background:rgba(97,214,111,.07);border:1px solid rgba(97,214,111,.2);color:#a7e8b0;font-size:12px}.ref-proof ol{margin:0;padding:0;list-style:none;counter-reset:flag}.ref-proof ol li{counter-increment:flag;display:grid;grid-template-columns:30px minmax(0,1fr);column-gap:8px;padding:7px 0;border-top:1px solid rgba(148,163,184,.09)}.ref-proof ol li:first-child{border-top:0;padding-top:2px}.ref-proof ol li::before{content:counter(flag,decimal-leading-zero);grid-row:span 2;font:600 11px/1.6 var(--font-plex-mono,monospace);color:#f87171}.ref-proof ol strong{font-size:14px;color:#f8fafc}.ref-proof ol span{font-size:13px;color:rgba(226,232,240,.58);line-height:1.5}.ref-copy-head{transform:translate3d(calc(var(--split) * var(--drift-x) * -1),calc(var(--split) * var(--drift-y) * -1),0)}.ref-copy-tail{opacity:calc(1 - var(--late));transform:translate3d(calc(var(--split) * var(--drift-x) * -1),calc(var(--late) * 28px - var(--split) * var(--drift-y)),0)}.ref-market-card{transform:translate3d(calc(var(--split) * var(--drift-x)),calc(var(--split) * var(--drift-y) * -1),0)}@media(max-width:980px){.ref-home-shell{--split:0!important;--late:0!important}.ref-proof{grid-template-columns:1fr}.ref-proof-before{border-right:0;border-bottom:1px solid rgba(148,163,184,.12)}.ref-home-shell{margin-top:-64px;padding-top:64px}.ref-hero{grid-template-columns:1fr;gap:34px;padding:58px 20px 44px;max-width:760px}.ref-copy{padding-left:0}.ref-market-card{max-width:620px;width:100%}}@media(max-width:640px){.ref-receipt-row{grid-template-columns:96px minmax(0,1fr)}.ref-receipt-row dd{flex-direction:column;gap:2px}.ref-receipt-row dd span{white-space:normal}.ref-proof-before,.ref-proof-after{padding:22px 20px}.ref-home-shell{margin-top:-64px;padding-top:64px}.ref-hero{padding:44px 16px 34px}.ref-copy h1{font-size:clamp(32px,10vw,44px)}.ref-copy h1 span{white-space:normal}.ref-sub{font-size:16px}.ref-ctas{flex-direction:column;gap:12px}.ref-btn{width:100%;min-width:0}.ref-market-card{padding:18px;border-radius:18px}.ref-card-head{align-items:flex-start}}
      `}</style>
    </>
  )
}
