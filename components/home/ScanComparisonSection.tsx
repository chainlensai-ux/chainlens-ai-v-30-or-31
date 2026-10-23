'use client'

// "See what others miss": what a trader sees before scanning vs what ChainLens flags after, as an
// illustrative example (disclaimer under the section). Matches the hero's black / silver / mint
// language. Plain CSS (scoped .scx-* classes) because this project's Tailwind build does not
// generate most utilities.
//
// Reveal: the server markup is fully visible; the hidden start state is only armed on the client
// when the section is still below the viewport, so nothing flashes. On entering view the header
// fades in, then the left card, then the right card with its signals one by one. The centre scan
// beam loops only while the section is on screen. All of it is off under prefers-reduced-motion.
import Link from 'next/link'
import { useEffect, useRef, type CSSProperties } from 'react'

const SURFACE = ['Price up 42%', '1,200 holders', 'Trending on X', 'Volume increasing']
const RISKS = ['LP unlocked', 'Top 10 wallets hold 61%', 'Deployer wallet is 3 days old', 'Linked wallet cluster detected']

export default function ScanComparisonSection() {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    if (el.getBoundingClientRect().top > window.innerHeight * 0.85) {
      el.classList.add('scx-armed')
      const reveal = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return
        el.classList.add('scx-in')
        reveal.disconnect()
      }, { threshold: 0.2 })
      reveal.observe(el)
    }

    const beam = new IntersectionObserver(([entry]) => el.classList.toggle('scx-offscreen', !entry.isIntersecting))
    beam.observe(el)
    return () => beam.disconnect()
  }, [])

  return (
    <section ref={ref} className="scx" aria-labelledby="scx-heading">
      <div className="scx-inner">
        <header className="scx-header scx-r" style={{ '--d': '0ms' } as CSSProperties}>
          <div className="scx-eyebrow"><i aria-hidden="true" /><span>See what others miss</span><i aria-hidden="true" /></div>
          <h2 id="scx-heading" className="scx-heading">Looks good at first glance. Until you scan it.</h2>
          <p className="scx-sub">ChainLens surfaces the LP, holder concentration, deployer risk, and wallet patterns before you enter.</p>
        </header>

        <div className="scx-grid">
          <article className="scx-card scx-before scx-r" style={{ '--d': '150ms' } as CSSProperties}>
            <div className="scx-card-head">
              <h3 className="scx-title">Before the scan</h3>
              <span className="scx-label">Surface signals</span>
            </div>
            <ul className="scx-list">
              {SURFACE.map((s) => (
                <li key={s}><span className="scx-dot" aria-hidden="true" />{s}</li>
              ))}
            </ul>
            <p className="scx-foot">Looks fine.</p>
          </article>

          <div className="scx-beam" aria-hidden="true"><span /></div>

          <article className="scx-card scx-after scx-r" style={{ '--d': '420ms' } as CSSProperties}>
            <div className="scx-card-head">
              <h3 className="scx-title">What ChainLens flagged</h3>
              <span className="scx-label scx-label-risk">Risk signals</span>
            </div>
            <ul className="scx-list">
              {RISKS.map((r, i) => (
                <li key={r} className="scx-r" style={{ '--d': `${700 + i * 140}ms` } as CSSProperties}>
                  <svg className="scx-flag" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3l9.5 17h-19z" /><path d="M12 10v4.5" /><path d="M12 17.5h.01" />
                  </svg>
                  {r}
                </li>
              ))}
              <li className="scx-verdict scx-r" style={{ '--d': `${700 + RISKS.length * 140}ms` } as CSSProperties}>
                <span>Verdict:</span><b>High risk</b>
              </li>
            </ul>
            <div className="scx-cta-wrap scx-r" style={{ '--d': `${840 + RISKS.length * 140}ms` } as CSSProperties}>
            <Link href="/terminal/token-scanner" className="scx-cta">
              Scan Token Free
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </Link>
            </div>
          </article>
        </div>

        <p className="scx-disclaimer">Illustrative example only. Not financial advice.</p>
      </div>

      <style>{`
        .scx{--mint:#1fd6dc;--risk:#f0857c;position:relative;z-index:1;width:100%;
          background:radial-gradient(60% 50% at 50% 46%,rgba(31,214,220,.045),transparent 70%),linear-gradient(180deg,#05050b 0,#020303 22%,#020303 78%,#05050b 100%);
          font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}
        .scx-inner{max-width:1060px;margin:0 auto;padding:96px 24px 88px;box-sizing:border-box}

        .scx-header{text-align:center;margin-bottom:56px}
        .scx-eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:18px}
        .scx-eyebrow i{display:block;width:28px;height:1px;background:linear-gradient(90deg,transparent,var(--mint))}
        .scx-eyebrow i:last-child{background:linear-gradient(90deg,var(--mint),transparent)}
        .scx-eyebrow span{font:700 10px/1 var(--font-plex-mono,'IBM Plex Mono',monospace);letter-spacing:.22em;text-transform:uppercase;color:var(--mint)}
        .scx-heading{margin:0 auto 16px;max-width:760px;font-family:var(--font-sora,'Sora',sans-serif);font-weight:800;font-size:clamp(28px,3.8vw,46px);line-height:1.1;letter-spacing:-.02em;
          color:#eef1f2;background:linear-gradient(172deg,#ffffff 0%,#f1f3f4 45%,#bfc6cb 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
        .scx-sub{margin:0 auto;max-width:560px;font-size:16px;line-height:1.65;color:rgba(196,204,210,.62)}

        .scx-grid{display:grid;grid-template-columns:1fr 56px 1fr;align-items:stretch}

        .scx-card{position:relative;display:flex;flex-direction:column;padding:30px 30px 28px;border-radius:20px;box-sizing:border-box;
          background:linear-gradient(180deg,rgba(22,24,26,.82) 0%,rgba(8,9,10,.9) 100%);
          border:1px solid rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 18px 44px rgba(0,0,0,.42)}
        .scx-card::before{content:"";position:absolute;top:0;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.34),transparent)}
        .scx-after{border-color:rgba(31,214,220,.22);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 18px 44px rgba(0,0,0,.42),0 0 40px rgba(31,214,220,.05)}
        .scx-after::before{background:linear-gradient(90deg,transparent,rgba(98,241,241,.55),transparent)}

        .scx-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,.06)}
        .scx-title{margin:0;font-size:18px;font-weight:700;line-height:1.25;letter-spacing:-.01em;color:#f4f6f7}
        .scx-label{flex-shrink:0;padding:5px 9px;border-radius:999px;font:700 9.5px/1 var(--font-plex-mono,'IBM Plex Mono',monospace);letter-spacing:.16em;text-transform:uppercase;color:rgba(196,204,210,.6);border:1px solid rgba(255,255,255,.10)}
        .scx-label-risk{color:var(--mint);border-color:rgba(31,214,220,.35);background:rgba(31,214,220,.05)}

        .scx-list{list-style:none;margin:0 0 22px;padding:0;display:flex;flex-direction:column;gap:14px}
        .scx-list li{display:flex;align-items:center;gap:12px;font-size:15px;line-height:1.4;color:rgba(214,220,224,.86)}
        .scx-before .scx-list li{color:rgba(196,204,210,.72)}
        .scx-dot{flex-shrink:0;width:6px;height:6px;margin:0 4px;border-radius:50%;background:rgba(196,204,210,.4)}
        .scx-flag{flex-shrink:0;color:var(--risk)}
        .scx-list .scx-verdict{margin-top:4px;padding-top:16px;border-top:1px solid rgba(255,255,255,.06);gap:10px;color:rgba(196,204,210,.7)}
        .scx-verdict b{padding:5px 11px;border-radius:8px;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#ffd9d5;background:rgba(240,133,124,.12);border:1px solid rgba(240,133,124,.4)}
        .scx-foot{margin:auto 0 0;padding-top:16px;border-top:1px solid rgba(255,255,255,.06);font-size:15px;font-style:italic;color:rgba(196,204,210,.5)}

        .scx-after .scx-list{margin-bottom:0}
        .scx-cta-wrap{margin-top:26px}
        .scx-cta{display:inline-flex;align-items:center;gap:9px;height:48px;padding:0 22px;border-radius:12px;box-sizing:border-box;
          font-size:15px;font-weight:700;color:#fff;text-decoration:none;
          background:radial-gradient(120% 150% at 50% -10%,rgba(92,240,240,.22) 0%,rgba(31,214,220,.07) 48%,rgba(3,9,10,.92) 100%);
          border:1.5px solid #2ad8df;box-shadow:0 0 0 3px rgba(31,214,220,.06),0 0 18px rgba(31,214,220,.22),inset 0 1px 0 rgba(255,255,255,.18);
          transition:box-shadow .2s ease,border-color .2s ease,transform .2s ease}
        .scx-cta svg{transition:transform .2s ease}
        @media(hover:hover){
          .scx-cta:hover{border-color:#6ff3f3;box-shadow:0 0 0 3px rgba(31,214,220,.10),0 0 28px rgba(31,214,220,.38),inset 0 1px 0 rgba(255,255,255,.24);transform:translateY(-1px)}
          .scx-cta:hover svg{transform:translateX(2px)}
        }
        .scx-cta:focus-visible{outline:2px solid #5cf0f0;outline-offset:3px}

        /* Centre scan beam: a hairline with a soft light travelling down it. */
        .scx-beam{position:relative;display:flex;justify-content:center}
        .scx-beam::before{content:"";position:absolute;top:8%;bottom:8%;width:1px;background:linear-gradient(180deg,transparent,rgba(31,214,220,.35) 20%,rgba(205,213,218,.18) 50%,rgba(31,214,220,.35) 80%,transparent)}
        .scx-beam span{position:absolute;top:8%;width:3px;height:72px;margin-left:-1px;border-radius:3px;background:linear-gradient(180deg,transparent,rgba(98,241,241,.85),transparent);box-shadow:0 0 12px rgba(31,214,220,.45);animation:scxBeam 4.2s cubic-bezier(.45,0,.55,1) infinite}
        /* Animates top (a 3px element, so negligible layout cost) to travel the real gutter height. */
        @keyframes scxBeam{0%{top:8%;opacity:0}12%{opacity:1}78%{opacity:1}90%,100%{top:calc(92% - 72px);opacity:0}}
        @keyframes scxBeamX{0%{left:12%;opacity:0}12%{opacity:1}78%{opacity:1}90%,100%{left:calc(88% - 64px);opacity:0}}
        .scx-offscreen .scx-beam span{animation-play-state:paused}

        .scx-disclaimer{margin:28px 0 0;text-align:center;font-size:12px;color:rgba(196,204,210,.42)}

        /* Reveal (armed client-side only when the section starts below the viewport). */
        .scx-armed .scx-r{opacity:0;transform:translate3d(0,14px,0)}
        .scx-armed .scx-before.scx-r{transform:translate3d(-18px,0,0)}
        .scx-armed .scx-after.scx-r{transform:translate3d(18px,0,0)}
        .scx-armed .scx-after .scx-r{transform:translate3d(10px,0,0)}
        .scx-armed .scx-beam{opacity:0;transition:opacity .6s ease .3s}
        .scx-armed.scx-in .scx-r{opacity:1;transform:none;transition:opacity .6s cubic-bezier(.22,1,.36,1) var(--d,0ms),transform .7s cubic-bezier(.22,1,.36,1) var(--d,0ms)}
        .scx-armed.scx-in .scx-beam{opacity:1}

        @media(max-width:860px){
          .scx-grid{grid-template-columns:1fr;max-width:560px;margin:0 auto}
          .scx-beam{height:44px;align-items:center}
          .scx-beam::before{top:auto;bottom:auto;left:12%;right:12%;width:auto;height:1px;background:linear-gradient(90deg,transparent,rgba(31,214,220,.35) 20%,rgba(205,213,218,.18) 50%,rgba(31,214,220,.35) 80%,transparent)}
          .scx-beam span{top:auto;left:12%;width:64px;height:3px;margin:-1px 0 0;background:linear-gradient(90deg,transparent,rgba(98,241,241,.85),transparent);animation-name:scxBeamX}
          .scx-armed .scx-before.scx-r,.scx-armed .scx-after.scx-r{transform:translate3d(0,16px,0)}
        }
        @media(max-width:767px){
          .scx-inner{padding:64px 16px 64px}
          .scx-header{margin-bottom:36px}
          .scx-card{padding:24px 20px 22px}
          .scx-card-head{flex-wrap:wrap;margin-bottom:18px;padding-bottom:14px}
          .scx-list li{font-size:14.5px}
          .scx-cta{display:flex;justify-content:center}
          /* globals.css turns CSS animations off at this width, so the travelling light would sit
             still; keep just the hairline. */
          .scx-beam span{display:none}
        }
        @media(prefers-reduced-motion:reduce){
          .scx-beam span{animation:none;display:none}
          .scx-cta,.scx-cta svg{transition:none}
          .scx-cta:hover{transform:none}
        }
      `}</style>
    </section>
  )
}
