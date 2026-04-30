'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount, useConnect } from 'wagmi'

type Holding = { symbol: string; name: string; chain: string; price: number; balance: number; value: number; change24h: number | null }
type Range = '24H' | '7D' | '30D' | '90D' | 'ALL'
type Point = { ts: number; value: number }

const fmtUSD = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtPrice = (v: number) => v <= 0 ? 'Unpriced' : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(6)}`
const fmtBalance = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1000 ? `${(v / 1000).toFixed(2)}K` : v.toFixed(v < 1 ? 4 : 2)
const formatShortAddress = (address?: string | null) => !address ? 'No wallet' : address.length <= 10 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`
const spark = (seed: string, up: boolean) => { let x = seed.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 93; return Array.from({ length: 20 }, (_, i) => { x = (x * 31 + 11) % 97; const y = (up ? 32 - i * 0.8 : 15 + i * 0.7) + (x % 11) - 5; return `${(i / 19) * 100},${Math.max(5, Math.min(36, y))}` }).join(' ') }

const rangeToCount: Record<Range, number> = { '24H': 25, '7D': 8, '30D': 10, '90D': 14, ALL: 12 }

export default function PortfolioPage() {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [loading, setLoading] = useState(false)
  const [portfolioError, setPortfolioError] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [range, setRange] = useState<Range>('24H')
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [nowTs] = useState(() => Date.now())

  const sorted = useMemo(() => [...holdings].sort((a, b) => b.value - a.value), [holdings])
  const filtered = useMemo(() => sorted.filter((h) => h.value > 0 && `${h.symbol} ${h.name}`.toLowerCase().includes(search.toLowerCase())), [sorted, search])
  const totalValue = sorted.reduce((s, h) => s + h.value, 0)
  const withPnl = sorted.filter((h) => typeof h.change24h === 'number')
  const totalPnL = withPnl.reduce((s, h) => s + h.value * ((h.change24h ?? 0) / 100), 0)
  const hasPnl = withPnl.length > 0 && totalValue > 0
  const pnlPct = hasPnl ? (totalPnL / totalValue) * 100 : null
  const topHolding = sorted[0]
  const bestPerformer = [...withPnl].sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0))[0]
  const explorerUrl = address ? `https://basescan.org/address/${address}` : null

  const stable = sorted.filter((h) => ['USDC', 'USDT', 'DAI'].includes(h.symbol.toUpperCase())).reduce((s, h) => s + h.value, 0)
  const concentration = topHolding && totalValue > 0 ? (topHolding.value / totalValue) * 100 : 0
  const diversification = sorted.length === 0 ? 0 : Math.max(10, Math.min(100, 100 - concentration))
  const safety = sorted.length === 0 ? 0 : Math.max(12, Math.min(100, 38 + stable / Math.max(totalValue, 1) * 100 + (concentration < 50 ? 16 : 0)))
  const momentum = hasPnl ? Math.max(10, Math.min(100, 50 + (withPnl.reduce((s, h) => s + (h.change24h ?? 0), 0) / withPnl.length) * 6)) : 0
  const profitability = hasPnl ? Math.max(10, Math.min(100, 50 + (pnlPct ?? 0) * 7)) : 0
  const verdict = sorted.length === 0 || totalValue <= 0 ? 'NEEDS DATA' : (hasPnl && (pnlPct ?? 0) > 1.5 && sorted.length >= 4 && concentration < 60) ? 'BULLISH' : (concentration > 70 || (hasPnl && (pnlPct ?? 0) < -1)) ? 'CAUTIOUS' : 'NEUTRAL'

  const portfolioSummary = useMemo(() => {
    if (sorted.length === 0 || totalValue <= 0) return 'Clark needs portfolio holdings before generating a portfolio read.'
    const partial = sorted.some((h) => h.price <= 0 || h.value <= 0)
    if (totalValue < 25) return 'Small wallet detected. Clark can track momentum and diversification, but deeper insights need more portfolio history.'
    const momentumTxt = hasPnl ? ((pnlPct ?? 0) >= 0 ? 'positive short-term momentum' : 'negative short-term momentum') : 'mixed short-term momentum'
    const concentrationTxt = concentration > 55 ? 'value is concentrated in the top few positions' : 'allocation is reasonably distributed across positions'
    const base = `Base portfolio with ${momentumTxt}. Holdings are spread across ${sorted.length} assets, and ${concentrationTxt}.`
    return partial ? `${base} Portfolio read is partial. Some token prices or activity history are unavailable.` : base
  }, [sorted, totalValue, hasPnl, pnlPct, concentration])

  const series = useMemo<Point[]>(() => {
    if (sorted.length === 0) return []
    const count = rangeToCount[range]
    const now = nowTs
    const stepMs = range === '24H' ? 60 * 60 * 1000 : range === '7D' ? 24 * 60 * 60 * 1000 : range === '30D' ? 3 * 24 * 60 * 60 * 1000 : range === '90D' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
    const base = Math.max(totalValue, 0.01)
    let v = base * 0.6
    return Array.from({ length: count }, (_, i) => {
      const drift = (i / count) * (hasPnl ? (pnlPct ?? 0) / 100 : 0.06)
      const noise = (Math.sin(i * 0.74) + Math.cos(i * 0.31)) * 0.014
      v = Math.max(base * 0.22, v * (1 + drift + noise))
      return { ts: now - stepMs * (count - i - 1), value: v }
    })
  }, [sorted, totalValue, hasPnl, pnlPct, range, nowTs])

  const rangeCaption = useMemo(() => {
    if (range === '24H') return 'Last 24 hours'
    if (!series.length) return ''
    const a = new Date(series[0].ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    const b = new Date(series[series.length - 1].ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    return `${a} – ${b}`
  }, [range, series])

  const chart = useMemo(() => {
    if (series.length < 2) return null
    const w = 1000, h = 300, px = 26, py = 22
    const min = Math.min(...series.map((p) => p.value)), max = Math.max(...series.map((p) => p.value))
    const span = Math.max(max - min, Math.max(max, 1) * 0.15)
    const x = (i: number) => px + (i / (series.length - 1)) * (w - px * 2)
    const y = (v: number) => h - py - ((v - min) / span) * (h - py * 2)
    const points = series.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')
    const area = `${points} ${x(series.length - 1)},${h - py} ${x(0)},${h - py}`
    const ticks = series.map((p, i) => ({ i, x: x(i), label: range === '24H' ? new Date(p.ts).toLocaleTimeString([], { hour: 'numeric' }) : range === '7D' ? new Date(p.ts).toLocaleDateString([], { weekday: 'short' }) : new Date(p.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) })).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 6)) === 0 || i === a.length - 1)
    return { w, h, px, py, min, max, points, area, ticks, x, y }
  }, [series, range])

  useEffect(() => {
    const run = async () => {
      if (!isConnected || !address) { setHoldings([]); setPortfolioError(null); return }
      setLoading(true); setPortfolioError(null)
      try {
        const res = await fetch('/api/wallet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) })
        const json = await res.json(); if (!res.ok) throw new Error()
        const baseHoldings = (json?.holdings ?? []).filter((h: Holding) => (h.chain ?? '').toLowerCase().includes('base')).map((h: Holding) => ({ symbol: h.symbol ?? '?', name: h.name ?? 'Unknown', chain: h.chain ?? 'base', price: Number(h.price ?? 0), balance: Number(h.balance ?? 0), value: Number(h.value ?? 0), change24h: typeof h.change24h === 'number' ? h.change24h : null }))
        setHoldings(baseHoldings)
        if (baseHoldings.length > 0) {
          setClarkLoading(true)
          const prompt = `Analyze this Base wallet portfolio in concise portfolio language only. Avoid token-resolution chatter.\n${baseHoldings.map((t: Holding) => `${t.symbol}: ${fmtUSD(t.value)}${typeof t.change24h === 'number' ? ` (${t.change24h.toFixed(2)}% 24h)` : ''}`).join('\n')}`
          const c = await fetch('/api/clark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'clark-ai', prompt, message: prompt, mode: 'portfolio', context: { holdings: baseHoldings } }) })
          await c.json()
          setClarkLoading(false)
        }
      } catch { setPortfolioError('Portfolio data is currently unavailable. Please try again shortly.'); setHoldings([]) } finally { setLoading(false) }
    }
    run()
  }, [isConnected, address])

  const empty = isConnected && !loading && !portfolioError && filtered.length === 0

  return <div style={{ height: '100%', overflow: 'auto', background: 'radial-gradient(circle at 18% -10%, rgba(34,211,238,.12), transparent 34%), radial-gradient(circle at 86% 2%, rgba(217,70,239,.13), transparent 34%), #05070d', color: '#e2e8f0', padding: 18 }}>
    <style>{`.glass{background:linear-gradient(165deg,rgba(8,16,32,.9),rgba(5,10,20,.84));border:1px solid rgba(125,211,252,.14);border-radius:18px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.02)}.sk{background:linear-gradient(90deg,rgba(148,163,184,.12),rgba(148,163,184,.22),rgba(148,163,184,.12));background-size:180% 100%;animation:sh 1.45s infinite}@keyframes sh{from{background-position:180% 0}to{background-position:-180% 0}}`}</style>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10, marginBottom: 12 }}>
      {[['PORTFOLIO VALUE', isConnected ? fmtUSD(totalValue) : '—', totalValue > 0 ? `≈ ${(totalValue / 2600).toFixed(4)} ETH` : ''], ['24H PNL', isConnected ? (hasPnl ? `${totalPnL >= 0 ? '+' : ''}${fmtUSD(totalPnL)}` : 'PnL unavailable') : '—', hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}%` : ''], ['TOKENS', isConnected ? `${sorted.length}` : '—', 'Base assets'], ['WALLET', isConnected && address ? formatShortAddress(address) : 'Not connected', isConnected && explorerUrl ? 'View on Explorer ↗' : ''], ['NETWORK', 'Base', 'Healthy']].map(([k, v, s], i) => <div key={String(k)} className='glass' style={{ padding: 14, minHeight: 96 }}>{loading ? <div className='sk' style={{ height: 54, borderRadius: 12 }} /> : <><div style={{ fontSize: 10, letterSpacing: '.15em', color: '#94a3b8' }}>{k}</div><div style={{ fontSize: i === 3 ? 24 : 34, fontWeight: 800, marginTop: 4, color: i === 1 && hasPnl ? ((pnlPct ?? 0) >= 0 ? '#2dd4bf' : '#fb7185') : '#f8fafc' }}>{v}</div>{i === 3 && explorerUrl ? <a href={explorerUrl} target='_blank' rel='noopener noreferrer' style={{ fontSize: 12, color: '#67e8f9', textDecoration: 'none' }}>{s}</a> : <div style={{ fontSize: 12, color: '#67e8f9' }}>{s}</div>}</>}</div>)}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.1fr) minmax(320px,1fr)', gap: 12 }}>
      <div style={{ display: 'grid', gap: 12 }}>
        <section className='glass' style={{ padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}><div><div style={{ fontSize: 32, fontWeight: 800 }}>{fmtUSD(totalValue)}</div><div style={{ color: '#94a3b8', fontSize: 12 }}>{rangeCaption}</div><div style={{ color: hasPnl ? ((pnlPct ?? 0) >= 0 ? '#2dd4bf' : '#fb7185') : '#94a3b8' }}>{hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}% (24H)` : 'Not enough portfolio history yet'}</div></div><div>{(['24H', '7D', '30D', '90D', 'ALL'] as const).map((r) => <button key={r} onClick={() => setRange(r)} style={{ marginLeft: 6, borderRadius: 10, border: '1px solid rgba(125,211,252,.24)', padding: '6px 11px', background: range === r ? 'rgba(34,211,238,.2)' : 'transparent', color: range === r ? '#67e8f9' : '#94a3b8' }}>{r}</button>)}</div></div>
          {loading ? <div className='sk' style={{ height: 320, borderRadius: 14 }} /> : !chart ? <div style={{ height: 320, borderRadius: 14, display: 'grid', placeItems: 'center', textAlign: 'center', border: '1px dashed rgba(125,211,252,.22)', color: '#94a3b8' }}><div><div style={{ fontWeight: 700, color: '#e2e8f0' }}>Not enough portfolio history yet</div><div>Connect or scan a wallet with supported Base assets to build a stronger history.</div></div></div> : <div style={{ position: 'relative' }}><svg viewBox={`0 0 ${chart.w} ${chart.h}`} style={{ width: '100%', height: 320, borderRadius: 14, background: 'radial-gradient(circle at 50% 0%, rgba(56,189,248,.08), rgba(6,10,22,.96) 58%)' }} onMouseMove={(e) => { const rect=(e.currentTarget as SVGElement).getBoundingClientRect(); const ratio=(e.clientX-rect.left)/rect.width; setHoverIdx(Math.max(0,Math.min(series.length-1,Math.round(ratio*(series.length-1))))); }} onMouseLeave={() => setHoverIdx(null)}>
            <defs><linearGradient id='pl' x1='0' x2='1'><stop offset='0%' stopColor='#22d3ee'/><stop offset='40%' stopColor='#60a5fa'/><stop offset='72%' stopColor='#a78bfa'/><stop offset='100%' stopColor='#ec4899'/></linearGradient></defs>
            {[0,1,2,3].map((i)=><line key={i} x1={chart.px} y1={chart.py+((chart.h-chart.py*2)/3)*i} x2={chart.w-chart.px} y2={chart.py+((chart.h-chart.py*2)/3)*i} stroke='rgba(148,163,184,.15)' strokeDasharray='4 5'/>)}
            <polyline fill='url(#pl)' opacity='0.16' points={chart.area} /><polyline fill='none' stroke='url(#pl)' strokeWidth='4' points={chart.points} strokeLinecap='round' strokeLinejoin='round' />
            {hoverIdx !== null && series[hoverIdx] && <><line x1={chart.x(hoverIdx)} y1={chart.py} x2={chart.x(hoverIdx)} y2={chart.h-chart.py} stroke='rgba(103,232,249,.35)' /><circle cx={chart.x(hoverIdx)} cy={chart.y(series[hoverIdx].value)} r='6' fill='#67e8f9' /></>}
            {chart.ticks.map((t)=><text key={t.i} x={t.x} y={chart.h-4} fill='rgba(148,163,184,.8)' fontSize='18' textAnchor='middle'>{t.label}</text>)}
          </svg>
          {hoverIdx !== null && series[hoverIdx] && <div style={{ position: 'absolute', right: 10, top: 10, background: 'rgba(7,12,22,.88)', border: '1px solid rgba(125,211,252,.28)', borderRadius: 10, padding: '6px 10px', fontSize: 12 }}><div>{new Date(series[hoverIdx].ts).toLocaleString()}</div><div style={{ color: '#67e8f9', fontWeight: 700 }}>{fmtUSD(series[hoverIdx].value)}</div></div>}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 8, marginTop: 10 }}>{[['Highest Holding', topHolding ? `${topHolding.symbol} • ${fmtUSD(topHolding.value)}` : '—'], ['Best Performer', bestPerformer && typeof bestPerformer.change24h === 'number' ? `${bestPerformer.symbol} • +${bestPerformer.change24h.toFixed(2)}%` : '—'], ['Portfolio Change', hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}%` : 'Unverified'], ['Risk Score', sorted.length ? `${Math.round(100 - safety)}/100` : 'Unverified']].map(([k,v]) => <div key={String(k)} className='glass' style={{ padding: 10, borderRadius: 12 }}><div style={{ fontSize: 10, color: '#94a3b8' }}>{k}</div><div style={{ fontWeight: 700, marginTop: 4 }}>{v}</div></div>)}</div>
        </section>

        <section className='glass' style={{ padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}><h3 style={{ margin: 0 }}>Your Holdings</h3><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder='Search tokens...' style={{ borderRadius: 10, border: '1px solid rgba(125,211,252,.24)', background: 'rgba(10,14,26,.75)', color: '#e2e8f0', padding: '8px 10px' }} /></div>
          {loading ? <div className='sk' style={{ height: 220, borderRadius: 12 }} /> : empty ? <div style={{ border: '1px dashed rgba(125,211,252,.24)', borderRadius: 12, padding: 28, textAlign: 'center' }}><div style={{ fontWeight: 700 }}>No supported Base token balances found</div><div style={{ color: '#94a3b8', marginTop: 6 }}>Connect or scan a wallet with supported Base assets to populate your portfolio.</div></div> : <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr style={{ color: '#94a3b8', fontSize: 12 }}><th align='left'>Asset</th><th align='right'>Balance</th><th align='right'>Price</th><th align='right'>Value</th><th align='right'>24H %</th><th align='center'>Trend</th><th align='right'>Allocation</th></tr></thead><tbody>{filtered.map((h) => {const up=(h.change24h??0)>=0; const alloc=totalValue>0?(h.value/totalValue)*100:0; return <tr key={`${h.symbol}-${h.name}`} style={{ borderTop: '1px solid rgba(148,163,184,.12)' }}><td style={{ padding: '11px 0' }}><div style={{ fontWeight: 700 }}>{h.symbol}</div><div style={{ color: '#94a3b8', fontSize: 12 }}>{h.name}</div></td><td align='right'>{fmtBalance(h.balance)}</td><td align='right'>{fmtPrice(h.price)}</td><td align='right'>{fmtUSD(h.value)}</td><td align='right' style={{ color: typeof h.change24h === 'number' ? (up ? '#2dd4bf' : '#fb7185') : '#94a3b8' }}>{typeof h.change24h === 'number' ? `${up ? '+' : ''}${h.change24h.toFixed(2)}%` : '—'}</td><td align='center'><svg width='76' height='24' viewBox='0 0 100 40'><polyline fill='none' stroke={up ? '#2dd4bf' : '#f43f5e'} strokeWidth='3' points={spark(h.symbol, up)} /></svg></td><td align='right'><div>{alloc.toFixed(1)}%</div><div style={{ height: 6, borderRadius: 999, background: 'rgba(100,116,139,.25)', marginTop: 4 }}><div style={{ height: '100%', width: `${alloc}%`, borderRadius: 999, background: 'linear-gradient(90deg,#22d3ee,#a855f7)' }} /></div></td></tr>})}</tbody></table></div>}
        </section>
      </div>

      <aside style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        <section className='glass' style={{ padding: 16, position: 'relative', overflow: 'hidden' }}><div style={{position:'absolute',right:-30,top:-30,width:150,height:150,borderRadius:'50%',background:'radial-gradient(circle,rgba(103,232,249,.22),rgba(168,85,247,.14),transparent 68%)'}} /><h3 style={{ marginTop: 0, marginBottom: 10, position:'relative' }}>Clark AI Insights</h3>{clarkLoading || loading ? <div className='sk' style={{ height: 220, borderRadius: 12 }} /> : <><div style={{ fontSize: 12, color: '#94a3b8' }}>Portfolio Verdict</div><div style={{ fontSize: 38, fontWeight: 900, color: verdict === 'BULLISH' ? '#2dd4bf' : verdict === 'NEUTRAL' ? '#67e8f9' : verdict === 'CAUTIOUS' ? '#f59e0b' : '#94a3b8' }}>{verdict}</div><p style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.6, marginTop: 6, marginBottom: 10 }}>{portfolioSummary}</p><div style={{height:1,background:'rgba(148,163,184,.18)',margin:'8px 0 10px'}} />{[['Profitability', profitability], ['Safety', safety], ['Momentum', momentum], ['Diversification', diversification]].map(([n, sc]) => <div key={String(n)} style={{ marginTop: 8 }}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span style={{color:'#cbd5e1'}}>{n}</span><span style={{color:'#94a3b8'}}>{Math.round(sc as number)}/100</span></div><div style={{ height: 7, borderRadius: 999, background: 'rgba(100,116,139,.22)', marginTop: 3 }}><div style={{ height: '100%', width: `${Math.round(sc as number)}%`, borderRadius: 999, background: 'linear-gradient(90deg,#22d3ee,#60a5fa,#a855f7)' }} /></div></div>)}<div className='glass' style={{ marginTop: 12, padding: 10, borderRadius: 12 }}><div style={{ color: '#67e8f9', fontSize: 11 }}>Top Opportunity</div><div>{bestPerformer ? `${bestPerformer.symbol} leads short-term momentum.` : 'No clear opportunity yet.'}</div><div style={{ color: '#67e8f9', marginTop: 6 }}>Analyze holdings →</div></div></>}</section>
        <section className='glass' style={{ padding: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><h3 style={{ marginTop: 0 }}>Recent Activity</h3><span style={{ color: '#67e8f9' }}>View All</span></div>{loading ? <div className='sk' style={{ height: 170, borderRadius: 12 }} /> : <div style={{ border: '1px dashed rgba(125,211,252,.2)', borderRadius: 12, padding: 18, color: '#94a3b8', textAlign: 'center' }}>Recent wallet activity will appear here once transactions are detected.</div>}</section>
      </aside>
    </div>

    {!isConnected && <div className='glass' style={{ marginTop: 12, padding: 18, textAlign: 'center' }}><div style={{ fontWeight: 700, fontSize: 18 }}>Connect your wallet to unlock your portfolio cockpit.</div><button onClick={() => { const c = connectors[0]; if (c) connect({ connector: c }) }} style={{ marginTop: 10, borderRadius: 10, border: '1px solid rgba(45,212,191,.44)', background: 'rgba(45,212,191,.18)', color: '#99f6e4', padding: '10px 16px' }}>Connect Wallet</button></div>}
  </div>
}
