'use client'

// Stats strip + "Three steps. Total clarity." in the homepage hero's black / graphite / silver /
// mint language. One shared background (charcoal fading to black, thin flowing strands kept to the
// edges) so the strip and the steps read as one block. Plain CSS (scoped .hiw-* classes) because
// this project's Tailwind build does not generate most utilities.
//
// The small demo in each card only shows things the product really has: the scanners' own input
// placeholders, the token scanner's check categories, and Clark's verdict set (see
// app/api/clark/route.ts). No values, scores or token names are shown.
import { useEffect, useRef } from 'react'

const STATS = [
  { value: '8', label: 'Intelligence Features' },
  { value: 'Base', label: 'Built Natively On' },
  { value: 'CORTEX', label: 'Powered by Engine' },
]

const STEPS = [
  { step: '01', title: 'Paste any wallet or token', desc: 'Drop in any address, contract, or token. Clark handles the rest.' },
  { step: '02', title: 'CORTEX analyses the data', desc: 'Our engine pulls onchain data, scores risk, and maps smart money in seconds.' },
  { step: '03', title: 'Clark tells you what it means', desc: 'No charts to decode. Clark gives you clear, plain-English intelligence.' },
]

// Token scanner checks, as listed on the "Analyze Base Tokens" capability card.
const CHECKS = ['Price', 'Liquidity', 'LP control', 'Holders', 'Security / tax', 'Dev / deployer risk']
// Clark's verdict set (app/api/clark/route.ts).
const VERDICTS = ['Trustworthy', 'Watch', 'Scan deeper', 'Avoid']

// ─── Background strands ─────────────────────────────────────────────────────
// Bundles of thin sine strands that repeat every PERIOD px; each <svg> is three periods wide and
// slides by exactly one period per loop (seamless, composited transform only).
const PERIOD = 640
const SPAN = PERIOD * 3

function strands(count: number, amp: number, gap: number, phase: number) {
  const out: string[] = []
  for (let s = 0; s < count; s++) {
    const k = s / (count - 1)
    let d = ''
    for (let x = 0; x <= SPAN; x += 16) {
      const a = (Math.PI * 2 * x) / PERIOD
      const y = 120 + amp * Math.sin(a + phase + k * 0.8) + (k - 0.5) * gap * (1 + 0.6 * Math.sin(a + phase + 1.3))
      d += `${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(1)}`
    }
    out.push(d)
  }
  return out
}

const BANDS = [
  { cls: 'hiw-band-a', paths: strands(14, 38, 92, 0.4) },
  { cls: 'hiw-band-b', paths: strands(12, 34, 80, 2.6) },
]

function StepDemo({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div className="hiw-demo" aria-hidden="true">
        <div className="hiw-input">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <span className="hiw-ph">
            <span className="hiw-ph-a">Enter contract address, ticker, or token name…</span>
            <span className="hiw-ph-b">0x… wallet address</span>
          </span>
          <span className="hiw-scan">Scan</span>
        </div>
        <div className="hiw-modes"><span className="hiw-mode-a">Token Scanner</span><span className="hiw-mode-b">Wallet Scanner</span></div>
      </div>
    )
  }
  if (index === 1) {
    return (
      <ul className="hiw-demo hiw-checks" aria-hidden="true">
        {CHECKS.map((c, i) => (
          <li key={c} style={{ animationDelay: `${i * 0.45}s` }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            {c}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className="hiw-demo" aria-hidden="true">
      <div className="hiw-verdict-label">Clark verdict</div>
      <div className="hiw-verdicts">
        {VERDICTS.map((v, i) => <span key={v} style={{ animationDelay: `${i * 2}s` }}>{v}</span>)}
      </div>
    </div>
  )
}

export default function HowItWorksSection() {
  const ref = useRef<HTMLElement>(null)

  // Pause the strands and demo loops while the block is off-screen.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => el.classList.toggle('hiw-paused', !entry.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <section ref={ref} className="hiw">
      <div className="hiw-waves" aria-hidden="true">
        {BANDS.map((b) => (
          <svg key={b.cls} className={`hiw-band ${b.cls}`} width={SPAN} height={240} viewBox={`0 0 ${SPAN} 240`} fill="none">
            {b.paths.map((d, i) => (
              <path key={i} d={d} stroke={i === b.paths.length - 1 ? 'rgba(31,214,220,0.30)' : 'rgba(205,213,218,0.08)'} strokeWidth={i === b.paths.length - 1 ? 1.1 : 0.8} />
            ))}
          </svg>
        ))}
      </div>

      {/* Stats strip */}
      <div className="hiw-stats">
        {STATS.map((s) => (
          <div key={s.value} className="hiw-stat">
            <span className="hiw-stat-value">{s.value}</span>
            <span className="hiw-stat-label">{s.label}</span>
          </div>
        ))}
      </div>

      {/* How it works */}
      <div className="hiw-inner">
        <header className="hiw-header">
          <div className="hiw-eyebrow"><i aria-hidden="true" /><span>How It Works</span><i aria-hidden="true" /></div>
          <h2 className="hiw-heading">Three steps. Total clarity.</h2>
        </header>

        <div className="hiw-steps-wrap">
        <span className="hiw-rail" aria-hidden="true" />
        <ol className="hiw-steps">
          {STEPS.map((s, i) => (
            <li key={s.step} className="hiw-card">
              <span className="hiw-node" aria-hidden="true" />
              <div className="hiw-step">{s.step}</div>
              <h3 className="hiw-title">{s.title}</h3>
              <p className="hiw-desc">{s.desc}</p>
              <StepDemo index={i} />
            </li>
          ))}
        </ol>
        </div>
      </div>

      <style>{`
        .hiw{--mint:#1fd6dc;position:relative;z-index:1;width:100%;overflow:hidden;isolation:isolate;
          background:linear-gradient(180deg,#05050b 0,#0a0b0c 90px,#060707 46%,#020303 78%,#05050b 100%);
          font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}

        /* Strands: kept to the left/right edges; the centre stays clean and dark. */
        .hiw-waves{position:absolute;inset:0;z-index:0;pointer-events:none;
          -webkit-mask-image:linear-gradient(90deg,#000 0,rgba(0,0,0,.9) 14%,transparent 36%,transparent 64%,rgba(0,0,0,.9) 86%,#000 100%);
          mask-image:linear-gradient(90deg,#000 0,rgba(0,0,0,.9) 14%,transparent 36%,transparent 64%,rgba(0,0,0,.9) 86%,#000 100%)}
        .hiw-band{position:absolute;left:0;will-change:transform;animation:hiwFlow 56s linear infinite}
        .hiw-band-a{top:34%}
        .hiw-band-b{top:58%;animation-duration:70s;animation-direction:reverse;opacity:.8}
        @keyframes hiwFlow{from{transform:translate3d(0,0,0)}to{transform:translate3d(-${PERIOD}px,0,0)}}

        /* Stats strip */
        .hiw-stats{position:relative;z-index:1;display:grid;grid-template-columns:repeat(3,1fr);max-width:860px;margin:0 auto;padding:26px 24px}
        .hiw-stats::before,.hiw-stats::after{content:"";position:absolute;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.10) 22%,rgba(255,255,255,.22) 50%,rgba(255,255,255,.10) 78%,transparent)}
        .hiw-stats::before{top:0}
        .hiw-stats::after{bottom:0}
        .hiw-stat{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:0 16px;text-align:center}
        .hiw-stat + .hiw-stat::before{content:"";position:absolute;left:0;top:10%;bottom:10%;width:1px;background:linear-gradient(180deg,transparent,rgba(255,255,255,.14),transparent)}
        .hiw-stat-value{font-family:var(--font-sora,'Sora',sans-serif);font-weight:700;font-size:clamp(22px,2.4vw,28px);line-height:1;letter-spacing:-.01em;color:#eef1f2}
        .hiw-stat:first-child .hiw-stat-value{color:var(--mint)}
        .hiw-stat-label{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:rgba(196,204,210,.55)}

        .hiw-inner{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:84px 24px 100px;box-sizing:border-box}
        .hiw-header{text-align:center;margin-bottom:52px}
        .hiw-eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:16px}
        .hiw-eyebrow i{display:block;width:28px;height:1px;background:linear-gradient(90deg,transparent,var(--mint))}
        .hiw-eyebrow i:last-child{background:linear-gradient(90deg,var(--mint),transparent)}
        .hiw-eyebrow span{font:700 10px/1 var(--font-plex-mono,'IBM Plex Mono',monospace);letter-spacing:.22em;text-transform:uppercase;color:var(--mint)}
        .hiw-heading{margin:0;font-family:var(--font-sora,'Sora',sans-serif);font-weight:800;font-size:clamp(28px,3.6vw,44px);line-height:1.1;letter-spacing:-.02em;
          color:#eef1f2;background:linear-gradient(172deg,#ffffff 0%,#f1f3f4 45%,#bfc6cb 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}

        /* Steps + connecting rail */
        .hiw-steps-wrap{position:relative}
        .hiw-steps{position:relative;list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:28px}
        .hiw-rail{position:absolute;left:8%;right:8%;top:46px;height:1px;z-index:0;
          background:linear-gradient(90deg,transparent,rgba(31,214,220,.45) 12%,rgba(205,213,218,.30) 50%,rgba(31,214,220,.45) 88%,transparent)}
        .hiw-rail::after{content:"";position:absolute;top:-1px;left:0;width:90px;height:3px;border-radius:2px;
          background:linear-gradient(90deg,transparent,rgba(98,241,241,.7),transparent);filter:blur(.5px);animation:hiwRail 7s cubic-bezier(.45,0,.55,1) infinite}
        @keyframes hiwRail{0%{transform:translateX(-90px);opacity:0}10%{opacity:1}55%{opacity:1}65%,100%{transform:translateX(min(84vw,1000px));opacity:0}}

        .hiw-card{position:relative;z-index:1;display:flex;flex-direction:column;padding:30px 26px 24px;border-radius:20px;
          background:linear-gradient(180deg,rgba(24,26,28,.86) 0%,rgba(9,10,11,.92) 100%);
          border:1px solid rgba(255,255,255,.08);
          box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 18px 44px rgba(0,0,0,.42);
          transition:transform .32s cubic-bezier(.22,1,.36,1),border-color .32s ease,box-shadow .32s ease}
        .hiw-card::before{content:"";position:absolute;top:0;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.38),transparent);transition:background .32s ease}
        /* Connection points where the rail meets each card's edges. */
        .hiw-node,.hiw-card::after{position:absolute;top:43px;width:7px;height:7px;border-radius:50%;background:#0b0d0e;border:1px solid rgba(31,214,220,.7);box-shadow:0 0 6px rgba(31,214,220,.35)}
        .hiw-node{left:-4px}
        .hiw-card::after{content:"";right:-4px}
        .hiw-steps > .hiw-card:first-of-type .hiw-node,.hiw-steps > .hiw-card:last-of-type::after{display:none}
        @media(hover:hover){
          .hiw-card:hover{transform:translateY(-3px);border-color:rgba(31,214,220,.34);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 24px 52px rgba(0,0,0,.5),0 0 22px rgba(31,214,220,.07)}
          .hiw-card:hover::before{background:linear-gradient(90deg,transparent,rgba(98,241,241,.6),transparent)}
        }

        .hiw-step{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;margin-bottom:22px;border-radius:50%;
          font:600 12px/1 var(--font-plex-mono,'IBM Plex Mono',monospace);letter-spacing:.04em;color:var(--mint);
          background:rgba(31,214,220,.06);border:1px solid rgba(31,214,220,.32)}
        .hiw-title{margin:0 0 10px;font-size:17.5px;font-weight:700;line-height:1.3;letter-spacing:-.01em;color:#f4f6f7}
        .hiw-desc{margin:0 0 24px;font-size:14.5px;line-height:1.7;color:rgba(196,204,210,.64)}

        /* Demos */
        .hiw-demo{margin-top:auto;min-height:92px;box-sizing:border-box;padding:14px;border-radius:14px;background:rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.06);font-size:12px;color:rgba(196,204,210,.7)}
        .hiw-input{display:flex;align-items:center;gap:9px;height:36px;padding:0 6px 0 11px;border-radius:10px;background:#050606;border:1px solid rgba(255,255,255,.09);color:rgba(196,204,210,.5)}
        .hiw-ph{position:relative;flex:1;min-width:0;height:16px;overflow:hidden}
        .hiw-ph span{position:absolute;inset:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:16px}
        .hiw-ph-a,.hiw-mode-a{animation:hiwSwapA 8s ease-in-out infinite}
        .hiw-ph-b,.hiw-mode-b{animation:hiwSwapB 8s ease-in-out infinite}
        .hiw-ph-b{opacity:0}
        /* The two placeholders never overlap: one fades fully out before the other fades in. */
        @keyframes hiwSwapA{0%,40%{opacity:1}46%,94%{opacity:0}100%{opacity:1}}
        @keyframes hiwSwapB{0%,48%{opacity:0}54%,86%{opacity:1}92%,100%{opacity:0}}
        .hiw-scan{flex-shrink:0;padding:6px 11px;border-radius:7px;font-size:11px;font-weight:700;color:#04181a;background:linear-gradient(135deg,#5cf0f0,#1fd6dc 60%,#12bccb)}
        .hiw-modes{display:flex;gap:6px;margin-top:10px}
        .hiw-modes span{padding:4px 9px;border-radius:999px;font-size:10.5px;font-weight:600;letter-spacing:.02em;border:1px solid rgba(255,255,255,.08);color:rgba(196,204,210,.55)}
        .hiw-mode-a,.hiw-mode-b{animation-name:hiwModeA}
        .hiw-mode-b{animation-name:hiwModeB}
        @keyframes hiwModeA{0%,42%{border-color:rgba(31,214,220,.45);color:#cfeff1}50%,92%{border-color:rgba(255,255,255,.08);color:rgba(196,204,210,.55)}100%{border-color:rgba(31,214,220,.45);color:#cfeff1}}
        @keyframes hiwModeB{0%,42%{border-color:rgba(255,255,255,.08);color:rgba(196,204,210,.55)}50%,92%{border-color:rgba(31,214,220,.45);color:#cfeff1}100%{border-color:rgba(255,255,255,.08);color:rgba(196,204,210,.55)}}

        .hiw-checks{list-style:none;margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:7px 10px}
        .hiw-checks li{display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:hiwCheck 6s ease-in-out infinite}
        .hiw-checks svg{flex-shrink:0;padding:2px;border-radius:50%;border:1px solid rgba(255,255,255,.12);color:transparent;animation:inherit;animation-name:hiwTick}
        @keyframes hiwCheck{0%,4%{color:rgba(196,204,210,.4)}12%,88%{color:rgba(214,222,226,.82)}100%{color:rgba(196,204,210,.4)}}
        @keyframes hiwTick{0%,4%{color:transparent;border-color:rgba(255,255,255,.12)}12%,88%{color:var(--mint);border-color:rgba(31,214,220,.45)}100%{color:transparent;border-color:rgba(255,255,255,.12)}}

        .hiw-verdict-label{margin-bottom:10px;font:700 9.5px/1 var(--font-plex-mono,'IBM Plex Mono',monospace);letter-spacing:.18em;text-transform:uppercase;color:rgba(196,204,210,.5)}
        .hiw-verdicts{display:flex;flex-wrap:wrap;gap:6px}
        .hiw-verdicts span{padding:6px 10px;border-radius:8px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border:1px solid rgba(255,255,255,.08);color:rgba(196,204,210,.55);background:rgba(255,255,255,.02);animation:hiwVerdict 8s ease-in-out infinite}
        @keyframes hiwVerdict{0%,22%{border-color:rgba(31,214,220,.5);color:#dff8f9;background:rgba(31,214,220,.07)}28%,100%{border-color:rgba(255,255,255,.08);color:rgba(196,204,210,.55);background:rgba(255,255,255,.02)}}

        .hiw-paused .hiw-band,.hiw-paused .hiw-rail::after,.hiw-paused .hiw-demo *,.hiw-paused .hiw-checks li{animation-play-state:paused}

        @media(max-width:900px){
          .hiw-steps-wrap{max-width:560px;margin:0 auto;padding-left:22px}
          .hiw-steps{grid-template-columns:1fr;gap:18px}
          .hiw-rail{left:0;right:auto;top:20px;bottom:20px;width:1px;height:auto;
            background:linear-gradient(180deg,transparent,rgba(31,214,220,.45) 10%,rgba(205,213,218,.30) 50%,rgba(31,214,220,.45) 90%,transparent)}
          .hiw-rail::after{display:none}
          .hiw-node{display:block!important;left:-26px;top:38px}
          .hiw-card::after{display:none}
        }
        @media(max-width:767px){
          .hiw-stats{padding:20px 12px}
          .hiw-stat{padding:0 8px}
          .hiw-stat-label{font-size:9.5px;letter-spacing:.1em}
          .hiw-inner{padding:60px 16px 72px}
          .hiw-header{margin-bottom:36px}
          .hiw-card{padding:24px 20px 20px}
        }
        @media(prefers-reduced-motion:reduce){
          .hiw-band,.hiw-rail::after,.hiw-demo *,.hiw-checks li{animation:none!important}
          .hiw-rail::after{display:none}
          .hiw-ph-b{opacity:0}
          .hiw-mode-a{border-color:rgba(31,214,220,.45);color:#cfeff1}
          .hiw-checks li{color:rgba(214,222,226,.82)}
          .hiw-checks svg{color:var(--mint);border-color:rgba(31,214,220,.45)}
          .hiw-card{transition:none}
          .hiw-card:hover{transform:none}
        }
      `}</style>
    </section>
  )
}
