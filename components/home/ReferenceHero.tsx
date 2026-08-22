'use client'

// Reversible homepage experiment: flip USE_REFERENCE_HERO to false to restore legacy homepage.
import Link from 'next/link'
import dynamic from 'next/dynamic'
import Reveal from './Reveal'

const ConnectWallet = dynamic(() => import('@/components/ConnectWallet'), { ssr: false })

const featureCards = [
  { color: '#53F3C3', title: 'Token Risk Reads', desc: 'LP, owner, holders, security, deployer', icon: 'shield' },
  { color: '#E053C2', title: 'Wallet Behavior', desc: 'FIFO lots, trade style, recovery gaps', icon: 'wallet' },
  { color: '#B666F3', title: 'Base Radar', desc: 'Early movers with liquidity filters', icon: 'bolt' },
  { color: '#5b9dff', title: 'Clark AI', desc: 'Ask questions across every scan', icon: 'target' },
]

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
  return <svg className="ref-chart" width="86" height="36" viewBox="0 0 86 36" aria-hidden="true"><path d={paths[variant]} fill="none" stroke={color} strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /><path d={`${paths[variant]} V36 H2 Z`} fill={color} opacity="0.08" /></svg>
}

function Icon({ name }: { name: string }) {
  const props = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (name === 'shield') return <svg {...props}><path d="M12 3l7 3v5c0 4.5-2.8 7.5-7 9-4.2-1.5-7-4.5-7-9V6l7-3z" /><path d="M9 12l2 2 4-5" /></svg>
  if (name === 'wallet') return <svg {...props}><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><circle cx="16.5" cy="15" r="1" /></svg>
  if (name === 'bolt') return <svg {...props}><path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z" /></svg>
  return <svg {...props}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
}

export default function ReferenceHero() {
  return (
    <>
      <section className="ref-home-shell">
        <div className="ref-bg" aria-hidden="true" />
        <main className="ref-hero">
          <div className="ref-copy">
            {/* SCROLL REVEAL, DISCLOSED (homepage reveal task): badge -> title -> buttons -> trust
                line, staggered per the task's required order. The wallet-connection line is
                deliberately left OUT of the reveal (always rendered, never animated) — this is a
                live, clickable control (ConnectWallet), not decorative copy. */}
            <Reveal><div className="ref-badge"><span className="ref-badge-tick"><i /></span>Powered by <b>Cortex Engine</b></div></Reveal>
            <Reveal delayMs={70}><h1>Find the move<br />before the <span>crowd.</span></h1></Reveal>
            <Reveal delayMs={120}><p className="ref-sub">CORTEX reads token risk, wallet behavior, and liquidity on Base in real time, so you move before the crowd does.</p></Reveal>
            <Reveal delayMs={170}><div className="ref-ctas">
              <Link className="ref-btn ref-btn-primary" href="/terminal"><span className="ref-terminal-mark">›_</span> Launch Terminal <span>→</span></Link>
              <Link className="ref-btn ref-btn-secondary" href="/terminal/token-scanner">Scan Token Free</Link>
            </div></Reveal>
            <div className="ref-wallet-line" aria-label="Wallet connection status"><span className="ref-wallet-dot" /><div className="ref-wallet-mini"><ConnectWallet className="ref-wallet-widget" /></div></div>
          </div>

          <Reveal delayMs={100}><aside className="ref-market-card" aria-label="Market overview">
            <div className="ref-card-head"><span>MARKET OVERVIEW</span><button type="button"><span />Base Network <svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg></button></div>
            <div className="ref-market-list">
              {marketRows.map((row, index) => (
                <div className="ref-market-row" key={row.title}>
                  <div className="ref-market-icon" style={{ color: row.color, background: `${row.color}16`, borderColor: `${row.color}28` }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={row.path} /></svg></div>
                  <div className="ref-market-text"><strong>{row.title}</strong><span>{row.body}</span></div>
                  <MiniChart color={row.color} variant={index} />
                </div>
              ))}
            </div>
            <div className="ref-card-foot"><span>Live data from onchain activity and liquidity, not hype.</span><span className="ref-updated"><i />Updated just now</span></div>
          </aside></Reveal>

          <div className="ref-features">
            {featureCards.map((item, index) => (
              <Reveal key={item.title} delayMs={260 + index * 70}>
                <div className="ref-feature"><div className="ref-feature-icon" style={{ color: item.color, borderColor: `${item.color}55`, boxShadow: `0 0 12px ${item.color}18` }}><Icon name={item.icon} /></div><div><strong>{item.title}</strong><span>{item.desc}</span></div>{index < featureCards.length - 1 ? <em /> : null}</div>
              </Reveal>
            ))}
          </div>
        </main>
      </section>
      <style>{`
        .ref-home-shell{--mint:#53F3C3;--pink:#E053C2;--purple:#B666F3;--cyan:#5b9dff;position:relative;min-height:760px;background:#03060D;overflow:hidden;margin-top:-80px;padding-top:80px;color:#fff}.ref-bg{position:absolute;inset:0;background:radial-gradient(42% 36% at 20% 24%,rgba(83,243,195,.12),transparent 58%),radial-gradient(38% 38% at 88% 24%,rgba(182,102,243,.16),transparent 62%),radial-gradient(28% 30% at 72% 68%,rgba(224,83,194,.10),transparent 68%),linear-gradient(180deg,#03060D 0%,#050812 56%,#03060D 100%)}.ref-bg:before{content:"";position:absolute;left:-8%;right:-8%;bottom:40px;height:250px;background:repeating-radial-gradient(ellipse at 50% 110%,transparent 0 26px,rgba(83,243,195,.08) 27px,transparent 29px),repeating-radial-gradient(ellipse at 50% 112%,transparent 0 42px,rgba(182,102,243,.10) 43px,transparent 45px);filter:blur(.4px);opacity:.58}.ref-bg:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px);background-size:96px 96px;mask-image:radial-gradient(circle at 50% 35%,black,transparent 72%);opacity:.18}.ref-hero{position:relative;z-index:1;max-width:1220px;margin:0 auto;padding:76px 24px 54px;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(390px,540px);gap:60px;align-items:center;font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}.ref-copy{padding-left:4px}.ref-badge{display:inline-flex;align-items:center;gap:10px;margin-bottom:18px;font:500 11px/1 var(--font-plex-mono,monospace);letter-spacing:.1em;color:rgba(226,232,240,.62);text-transform:uppercase}.ref-badge b{color:#d7bcf7;font-weight:600}.ref-badge-tick{width:15px;height:15px;border-radius:4px;border:1.4px solid rgba(182,102,243,.5);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}.ref-badge-tick i{width:5px;height:5px;border-radius:1px;background:var(--purple)}.ref-copy h1{margin:0 0 16px;font-size:clamp(36px,4.6vw,58px);line-height:1.07;letter-spacing:-.025em;font-weight:800;color:#f8fafc;font-family:var(--font-sora,'Sora',sans-serif)}.ref-copy h1 span{white-space:nowrap;background:linear-gradient(94deg,var(--pink) 3%,var(--purple) 54%,var(--mint) 108%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}.ref-sub{max-width:480px;margin:0 0 28px;color:rgba(226,232,240,.62);font-size:16.5px;line-height:1.6;font-family:var(--font-jakarta,'Plus Jakarta Sans',sans-serif)}.ref-ctas{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:18px}.ref-btn{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:12px;min-height:54px;padding:0 28px;border-radius:13px;color:#fff;text-decoration:none;text-transform:uppercase;font-size:12px;font-weight:800;letter-spacing:.05em;transition:transform .18s ease,box-shadow .18s ease,background .18s ease,border-color .18s ease}.ref-btn::after{content:'';position:absolute;top:0;left:-70%;width:45%;height:100%;background:linear-gradient(115deg,transparent,rgba(255,255,255,.5),transparent);transform:skewX(-18deg);transition:left .55s ease}.ref-btn:hover::after{left:130%}.ref-btn-primary{min-width:230px;border:1.5px solid rgba(224,83,194,.75);background:rgba(182,102,243,.08);box-shadow:0 0 0 1px rgba(182,102,243,.12) inset,0 0 22px rgba(224,83,194,.16)}.ref-btn-primary:hover{transform:translateY(-2px);border-color:var(--mint);background:rgba(182,102,243,.16);box-shadow:0 0 0 1px rgba(182,102,243,.2) inset,0 12px 34px rgba(224,83,194,.32),0 0 26px rgba(83,243,195,.2)}.ref-btn-secondary{min-width:184px;border:1px solid rgba(148,163,184,.22);background:rgba(255,255,255,.02)}.ref-btn-secondary:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.34);background:rgba(255,255,255,.04)}.ref-terminal-mark{font-family:var(--font-plex-mono,monospace);font-size:16px;color:#d8fff8}.ref-wallet-line{display:inline-flex;align-items:center;gap:9px;margin:2px 0 20px;padding:7px 14px;border:1px solid rgba(148,163,184,.16);border-radius:999px;background:rgba(255,255,255,.02)}.ref-wallet-dot{width:6px;height:6px;border-radius:50%;background:var(--mint);box-shadow:0 0 6px rgba(83,243,195,.70);flex-shrink:0}.ref-wallet-mini{display:flex;align-items:center}.ref-wallet-widget{display:flex!important;align-items:center!important;gap:8px!important}.ref-wallet-widget>button,button.ref-wallet-widget{width:auto!important;min-width:0!important;padding:5px 13px!important;font-size:10.5px!important;font-weight:700!important;letter-spacing:.05em!important;text-transform:uppercase!important;border-radius:999px!important;box-shadow:none!important;background:rgba(255,255,255,.025)!important;color:#9fdccb!important;border:1px solid rgba(255,255,255,.14)!important;transition:background .15s,border-color .15s!important}.ref-wallet-widget>button:hover,button.ref-wallet-widget:hover{background:rgba(83,243,195,.09)!important;border-color:rgba(83,243,195,.4)!important}.ref-wallet-widget>div:nth-of-type(1){order:-1;font-size:12px!important;color:rgba(226,232,240,.66)!important;text-align:left!important;font-family:var(--font-plex-mono,monospace)!important;letter-spacing:.02em!important}.ref-wallet-widget>div:nth-of-type(1)::after{content:'·';margin-left:6px;color:rgba(148,163,184,.35)}.ref-wallet-widget>div:nth-of-type(2){display:none!important}.ref-market-card{padding:26px;border-radius:22px;background:linear-gradient(180deg,rgba(8,14,31,.80),rgba(5,9,22,.64));border:1px solid rgba(148,163,184,.20);box-shadow:0 32px 84px rgba(0,0,0,.50),0 0 44px rgba(83,243,195,.05),0 0 64px rgba(182,102,243,.035),inset 0 1px 0 rgba(255,255,255,.09);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.ref-card-head,.ref-card-foot{display:flex;align-items:center;justify-content:space-between;gap:14px}.ref-card-head{margin-bottom:16px}.ref-card-head>span{font-size:13px;font-weight:800;color:rgba(248,250,252,.86)}.ref-card-head button{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;color:rgba(226,232,240,.75);font-size:12px}.ref-card-head button span{width:12px;height:12px;border-radius:50%;background:#3272ff;box-shadow:inset -3px -3px 0 rgba(255,255,255,.18)}.ref-market-list{display:flex;flex-direction:column}.ref-market-row{display:grid;grid-template-columns:46px minmax(0,1fr) 96px;gap:15px;align-items:center;padding:17px 14px;margin:0 -14px;border-radius:12px;border-top:1px solid rgba(148,163,184,.09);transition:background .15s ease}.ref-market-row:first-child{border-top:0}.ref-market-row:hover{background:rgba(255,255,255,.022)}.ref-market-icon{width:44px;height:44px;border:1px solid;border-radius:50%;display:flex;align-items:center;justify-content:center}.ref-market-text strong{display:block;color:#f8fafc;font-size:13px;margin-bottom:3px}.ref-market-text span{display:block;color:rgba(226,232,240,.63);font-size:12px;line-height:1.42}.ref-chart{opacity:.78;filter:drop-shadow(0 0 8px currentColor)}.ref-card-foot{padding-top:13px;border-top:1px solid rgba(148,163,184,.09);font-size:11px;color:rgba(226,232,240,.55)}.ref-updated{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}.ref-updated i{width:9px;height:9px;border:1.5px solid #53F3C3;border-left-color:transparent;border-radius:50%}.ref-features{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,1fr);margin-top:32px;border:1px solid rgba(148,163,184,.16);border-radius:20px;background:linear-gradient(180deg,rgba(8,14,31,.78),rgba(5,9,22,.66));box-shadow:0 22px 60px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden}.ref-feature{position:relative;display:flex;align-items:center;gap:15px;padding:24px 22px;min-width:0;transition:background .15s ease}.ref-feature:hover{background:rgba(255,255,255,.02)}.ref-feature em{position:absolute;right:0;top:18%;bottom:18%;width:1px;background:rgba(148,163,184,.14)}.ref-feature-icon{width:40px;height:40px;flex:0 0 auto;border:1px solid;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.54)}.ref-feature strong{display:block;color:#f8fafc;font-size:13px;margin-bottom:4px}.ref-feature span{display:block;color:rgba(226,232,240,.60);font-size:12px;line-height:1.42}@media(max-width:980px){.ref-home-shell{margin-top:-64px;padding-top:64px}.ref-hero{grid-template-columns:1fr;gap:34px;padding:58px 20px 44px;max-width:760px}.ref-copy{padding-left:0}.ref-market-card{max-width:620px;width:100%}.ref-features{grid-template-columns:repeat(2,1fr);margin-top:24px}.ref-feature:nth-child(2) em{display:none}}@media(max-width:640px){.ref-home-shell{margin-top:-64px;padding-top:64px}.ref-hero{padding:44px 16px 34px}.ref-copy h1{font-size:clamp(32px,10vw,44px)}.ref-copy h1 span{white-space:normal}.ref-sub{font-size:16px}.ref-ctas{flex-direction:column;gap:12px}.ref-btn{width:100%;min-width:0}.ref-wallet-line{display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding:7px 13px;border-radius:14px}.ref-market-card{padding:18px;border-radius:18px}.ref-card-head{align-items:flex-start}.ref-market-row{grid-template-columns:38px 1fr;gap:12px}.ref-chart{grid-column:2;width:100%;max-width:210px}.ref-card-foot{align-items:flex-start;flex-direction:column}.ref-features{grid-template-columns:1fr;margin-top:20px}.ref-feature{padding:20px}.ref-feature em{display:none}}
      `}</style>
    </>
  )
}
