'use client'

// Reversible homepage experiment: flip USE_REFERENCE_HERO to false to restore legacy homepage.
import Link from 'next/link'
import dynamic from 'next/dynamic'

const ConnectWallet = dynamic(() => import('@/components/ConnectWallet'), { ssr: false })

const featureCards = [
  { color: '#55E6D2', title: 'Token Risk Reads', desc: 'LP, owner, holders, security, deployer', icon: 'shield' },
  { color: '#7B61D9', title: 'Wallet Behavior', desc: 'FIFO lots, trade style, recovery gaps', icon: 'wallet' },
  { color: '#1FD7E8', title: 'Base Radar', desc: 'Early movers with liquidity filters', icon: 'bolt' },
  { color: '#D95AA8', title: 'Clark AI', desc: 'Ask questions across every scan', icon: 'target' },
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
            <div className="ref-badge"><span />POWERED BY CORTEX ENGINE</div>
            <h1>Find the move<br /><span>before the crowd.</span></h1>
            <p className="ref-sub">Scan tokens, wallets, whales, and onchain momentum with Clark — your AI onchain analyst.</p>
            <div className="ref-ctas">
              <Link className="ref-btn ref-btn-primary" href="/terminal"><span className="ref-terminal-mark">›_</span> Launch Terminal <span>→</span></Link>
              <Link className="ref-btn ref-btn-secondary" href="/terminal/token-scanner">Scan Token Free</Link>
            </div>
            <div className="ref-wallet-line"><span>Connect wallet later —</span><div className="ref-wallet-mini"><ConnectWallet /></div></div>
            <p className="ref-trust">No hype. No fake scores. ChainLens shows evidence, gaps, and risk before you trade.</p>
          </div>

          <aside className="ref-market-card" aria-label="Market overview">
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
          </aside>

          <div className="ref-features">
            {featureCards.map((item, index) => <div className="ref-feature" key={item.title}><div className="ref-feature-icon" style={{ color: item.color, borderColor: `${item.color}55`, boxShadow: `0 0 18px ${item.color}24` }}><Icon name={item.icon} /></div><div><strong>{item.title}</strong><span>{item.desc}</span></div>{index < featureCards.length - 1 ? <em /> : null}</div>)}
          </div>
        </main>
      </section>
      <style>{`
        .ref-home-shell{--mint:#55E6D2;--pink:#D95AA8;--purple:#7B61D9;--cyan:#1FD7E8;position:relative;min-height:760px;background:#03060D;overflow:hidden;margin-top:-94px;padding-top:94px;color:#fff}.ref-bg{position:absolute;inset:0;background:radial-gradient(42% 36% at 20% 24%,rgba(85,230,210,.12),transparent 58%),radial-gradient(38% 38% at 88% 24%,rgba(123,97,217,.16),transparent 62%),radial-gradient(28% 30% at 72% 68%,rgba(217,90,168,.10),transparent 68%),linear-gradient(180deg,#03060D 0%,#050812 56%,#03060D 100%)}.ref-bg:before{content:"";position:absolute;left:-8%;right:-8%;bottom:40px;height:250px;background:repeating-radial-gradient(ellipse at 50% 110%,transparent 0 26px,rgba(85,230,210,.08) 27px,transparent 29px),repeating-radial-gradient(ellipse at 50% 112%,transparent 0 42px,rgba(123,97,217,.10) 43px,transparent 45px);filter:blur(.4px);opacity:.58}.ref-bg:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px);background-size:96px 96px;mask-image:radial-gradient(circle at 50% 35%,black,transparent 72%);opacity:.18}.ref-hero{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:94px 24px 54px;display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,520px);gap:72px;align-items:center}.ref-copy{padding-left:4px}.ref-badge{display:inline-flex;align-items:center;gap:9px;margin-bottom:22px;padding:8px 15px;border:1px solid rgba(85,230,210,.28);border-radius:999px;background:rgba(85,230,210,.045);color:var(--mint);font:800 10px/1 var(--font-plex-mono,monospace);letter-spacing:.16em}.ref-badge span{width:6px;height:6px;border-radius:50%;background:#64f08b;box-shadow:0 0 9px rgba(100,240,139,.72)}.ref-copy h1{margin:0 0 18px;font-size:clamp(44px,5.3vw,74px);line-height:.99;letter-spacing:-.052em;font-weight:900;color:#f8fafc;text-shadow:0 14px 40px rgba(0,0,0,.48)}.ref-copy h1 span{background:linear-gradient(94deg,var(--pink) 3%,var(--purple) 54%,var(--mint) 108%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}.ref-sub{max-width:560px;margin:0 0 30px;color:rgba(226,232,240,.68);font-size:18px;line-height:1.62}.ref-ctas{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:18px}.ref-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:12px;min-height:54px;padding:0 28px;border-radius:13px;color:#fff;text-decoration:none;text-transform:uppercase;font-size:12px;font-weight:850;letter-spacing:.055em;background:linear-gradient(#070b16,#070b16) padding-box,linear-gradient(105deg,var(--pink),var(--purple),var(--mint)) border-box;border:1px solid transparent;box-shadow:0 0 28px rgba(123,97,217,.18),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .18s ease,box-shadow .18s ease,filter .18s ease}.ref-btn:hover{transform:translateY(-2px);box-shadow:0 0 30px rgba(85,230,210,.18),0 0 38px rgba(217,90,168,.18),inset 0 1px 0 rgba(255,255,255,.14);filter:brightness(1.08)}.ref-btn-primary{min-width:230px}.ref-btn-secondary{min-width:184px;background:linear-gradient(rgba(8,10,24,.92),rgba(8,10,24,.92)) padding-box,linear-gradient(105deg,rgba(123,97,217,.75),rgba(85,230,210,.42)) border-box}.ref-terminal-mark{font-family:var(--font-plex-mono,monospace);font-size:16px;color:#d8fff8}.ref-wallet-line{display:flex;align-items:center;gap:10px;margin:3px 0 19px;color:rgba(226,232,240,.48);font-size:13px}.ref-wallet-mini{transform:scale(.78);transform-origin:left center;max-height:34px}.ref-trust{max-width:525px;margin:0;color:rgba(226,232,240,.45);font-size:13px;line-height:1.65}.ref-market-card{padding:22px;border-radius:21px;background:linear-gradient(180deg,rgba(8,14,31,.78),rgba(5,9,22,.62));border:1px solid rgba(148,163,184,.16);box-shadow:0 28px 70px rgba(0,0,0,.42),0 0 50px rgba(85,230,210,.055),inset 0 1px 0 rgba(255,255,255,.07);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.ref-card-head,.ref-card-foot{display:flex;align-items:center;justify-content:space-between;gap:14px}.ref-card-head{margin-bottom:13px}.ref-card-head>span{font-size:13px;font-weight:800;color:rgba(248,250,252,.86)}.ref-card-head button{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;color:rgba(226,232,240,.75);font-size:12px}.ref-card-head button span{width:12px;height:12px;border-radius:50%;background:#3272ff;box-shadow:inset -3px -3px 0 rgba(255,255,255,.18)}.ref-market-list{display:flex;flex-direction:column}.ref-market-row{display:grid;grid-template-columns:42px minmax(0,1fr) 92px;gap:14px;align-items:center;padding:14px 0;border-top:1px solid rgba(148,163,184,.09)}.ref-market-row:first-child{border-top:0}.ref-market-icon{width:40px;height:40px;border:1px solid;border-radius:50%;display:flex;align-items:center;justify-content:center}.ref-market-text strong{display:block;color:#f8fafc;font-size:13px;margin-bottom:3px}.ref-market-text span{display:block;color:rgba(226,232,240,.63);font-size:12px;line-height:1.34}.ref-chart{opacity:.78;filter:drop-shadow(0 0 8px currentColor)}.ref-card-foot{padding-top:13px;border-top:1px solid rgba(148,163,184,.09);font-size:11px;color:rgba(226,232,240,.55)}.ref-updated{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}.ref-updated i{width:9px;height:9px;border:1.5px solid #55E6D2;border-left-color:transparent;border-radius:50%}.ref-features{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,1fr);margin-top:8px;border:1px solid rgba(148,163,184,.16);border-radius:20px;background:linear-gradient(180deg,rgba(8,14,31,.78),rgba(5,9,22,.66));box-shadow:0 22px 60px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden}.ref-feature{position:relative;display:flex;align-items:center;gap:15px;padding:24px 22px;min-width:0}.ref-feature em{position:absolute;right:0;top:18%;bottom:18%;width:1px;background:rgba(148,163,184,.14)}.ref-feature-icon{width:40px;height:40px;flex:0 0 auto;border:1px solid;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.54)}.ref-feature strong{display:block;color:#f8fafc;font-size:13px;margin-bottom:4px}.ref-feature span{display:block;color:rgba(226,232,240,.60);font-size:12px;line-height:1.42}@media(max-width:980px){.ref-home-shell{margin-top:-78px;padding-top:78px}.ref-hero{grid-template-columns:1fr;gap:34px;padding:70px 20px 44px}.ref-copy{padding-left:0}.ref-market-card{max-width:620px;width:100%}.ref-features{grid-template-columns:repeat(2,1fr);margin-top:10px}.ref-feature:nth-child(2) em{display:none}}@media(max-width:640px){.ref-home-shell{margin-top:-78px;padding-top:78px}.ref-hero{padding:52px 16px 34px}.ref-copy h1{font-size:clamp(40px,14vw,58px)}.ref-sub{font-size:16px}.ref-ctas{flex-direction:column;gap:12px}.ref-btn{width:100%;min-width:0}.ref-wallet-line{align-items:flex-start;flex-direction:column;gap:6px}.ref-market-card{padding:18px;border-radius:18px}.ref-card-head{align-items:flex-start}.ref-market-row{grid-template-columns:38px 1fr;gap:12px}.ref-chart{grid-column:2;width:100%;max-width:210px}.ref-card-foot{align-items:flex-start;flex-direction:column}.ref-features{grid-template-columns:1fr}.ref-feature{padding:20px}.ref-feature em{display:none}}
      `}</style>
    </>
  )
}
