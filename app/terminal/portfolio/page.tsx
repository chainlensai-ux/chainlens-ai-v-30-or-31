'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { useWeb3Modal } from '@web3modal/wagmi/react'

type Holding = { symbol: string; name: string; chain: string; price: number; balance: number; value: number; change24h: number | null }
const fmtUSD = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtPrice = (v: number) => v <= 0 ? 'Unpriced' : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(6)}`
const fmtBalance = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1000 ? `${(v / 1000).toFixed(2)}K` : v.toFixed(v < 1 ? 4 : 2)
const formatShortAddress = (address?: string | null) => {
  if (!address) return 'No wallet'
  if (address.length <= 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

const spark = (seed: string, up: boolean) => {
  let x = seed.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 93
  return Array.from({ length: 20 }, (_, i) => {
    x = (x * 31 + 11) % 97
    const y = (up ? 32 - i * 0.8 : 15 + i * 0.7) + (x % 11) - 5
    return `${(i / 19) * 100},${Math.max(5, Math.min(36, y))}`
  }).join(' ')
}

export default function PortfolioPage() {
  const { address, isConnected } = useAccount()
  const { open } = useWeb3Modal()
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [loading, setLoading] = useState(false)
  const [portfolioError, setPortfolioError] = useState<string | null>(null)
  const [clarkText, setClarkText] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [range, setRange] = useState<'24H' | '7D' | '30D' | '90D' | 'ALL'>('24H')

  const sorted = useMemo(() => [...holdings].sort((a, b) => b.value - a.value), [holdings])
  const filtered = useMemo(() => sorted.filter((h) => h.value > 0 && `${h.symbol} ${h.name}`.toLowerCase().includes(search.toLowerCase())), [sorted, search])
  const totalValue = sorted.reduce((s, h) => s + h.value, 0)
  const withPnl = sorted.filter((h) => typeof h.change24h === 'number')
  const totalPnL = withPnl.reduce((s, h) => s + h.value * ((h.change24h ?? 0) / 100), 0)
  const hasPnl = withPnl.length > 0 && totalValue > 0
  const pnlPct = hasPnl ? (totalPnL / totalValue) * 100 : null
  const topHolding = sorted[0]
  const bestPerformer = [...withPnl].sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0))[0]

  const stable = sorted.filter((h) => ['USDC', 'USDT', 'DAI'].includes(h.symbol.toUpperCase())).reduce((s, h) => s + h.value, 0)
  const concentration = topHolding && totalValue > 0 ? (topHolding.value / totalValue) * 100 : 0
  const diversification = sorted.length === 0 ? 0 : Math.max(10, Math.min(100, 100 - concentration))
  const safety = sorted.length === 0 ? 0 : Math.max(12, Math.min(100, 38 + stable / Math.max(totalValue, 1) * 100 + (concentration < 50 ? 16 : 0)))
  const momentum = hasPnl ? Math.max(10, Math.min(100, 50 + (withPnl.reduce((s, h) => s + (h.change24h ?? 0), 0) / withPnl.length) * 6)) : 0
  const profitability = hasPnl ? Math.max(10, Math.min(100, 50 + (pnlPct ?? 0) * 7)) : 0
  const avgScore = (profitability + safety + momentum + diversification) / 4
  const verdict = sorted.length === 0 ? 'NEEDS DATA' : avgScore > 68 ? 'BULLISH' : avgScore > 52 ? 'NEUTRAL' : avgScore > 35 ? 'CAUTIOUS' : 'DEFENSIVE'

  const chartPoints = useMemo(() => {
    if (sorted.length === 0) return ''
    const base = Math.max(totalValue, 0.01)
    let v = base * 0.58
    return Array.from({ length: 36 }, (_, i) => {
      const drift = (i / 36) * (hasPnl ? (pnlPct ?? 0) / 100 : 0.07)
      const noise = (Math.sin(i * 0.7) + Math.cos(i * 0.33)) * 0.018
      v = Math.max(base * 0.22, v * (1 + drift + noise))
      const y = 88 - Math.min(76, Math.max(8, (v / Math.max(base * 1.1, 1e-6)) * 64))
      return `${(i / 35) * 100},${y}`
    }).join(' ')
  }, [sorted, totalValue, hasPnl, pnlPct])

  useEffect(() => {
    const run = async () => {
      if (!isConnected || !address) { setHoldings([]); setPortfolioError(null); setClarkText(null); return }
      setLoading(true); setPortfolioError(null); setClarkText(null)
      try {
        const res = await fetch('/api/wallet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) })
        const json = await res.json(); if (!res.ok) throw new Error()
        const baseHoldings = (json?.holdings ?? []).filter((h: Holding) => (h.chain ?? '').toLowerCase().includes('base')).map((h: Holding) => ({ symbol: h.symbol ?? '?', name: h.name ?? 'Unknown', chain: h.chain ?? 'base', price: Number(h.price ?? 0), balance: Number(h.balance ?? 0), value: Number(h.value ?? 0), change24h: typeof h.change24h === 'number' ? h.change24h : null }))
        setHoldings(baseHoldings)
        if (baseHoldings.length > 0) {
          setClarkLoading(true)
          const prompt = `Analyze this Base wallet portfolio in concise portfolio language only. Avoid token-resolution chatter.\n${baseHoldings.map((t: Holding) => `${t.symbol}: ${fmtUSD(t.value)}${typeof t.change24h === 'number' ? ` (${t.change24h.toFixed(2)}% 24h)` : ''}`).join('\n')}`
          const c = await fetch('/api/clark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'clark-ai', prompt, message: prompt, mode: 'portfolio', context: { holdings: baseHoldings } }) })
          const cj = await c.json(); if (cj?.ok) setClarkText(cj?.data?.reply ?? cj?.data?.analysis ?? null)
          setClarkLoading(false)
        }
      } catch {
        setPortfolioError('Portfolio data is currently unavailable. Please try again shortly.')
        setHoldings([])
      } finally { setLoading(false) }
    }
    run()
  }, [isConnected, address])

  const empty = isConnected && !loading && !portfolioError && filtered.length === 0

  return <div style={{ height: '100%', overflow: 'auto', background: 'radial-gradient(circle at 18% -10%, rgba(34,211,238,.12), transparent 34%), radial-gradient(circle at 86% 2%, rgba(217,70,239,.13), transparent 34%), #05070d', color: '#e2e8f0', padding: 18 }}>
    <style>{`.glass{background:linear-gradient(165deg,rgba(8,16,32,.88),rgba(5,10,20,.82));border:1px solid rgba(125,211,252,.14);border-radius:18px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.02)}.sk{background:linear-gradient(90deg,rgba(148,163,184,.12),rgba(148,163,184,.22),rgba(148,163,184,.12));background-size:180% 100%;animation:sh 1.45s infinite}@keyframes sh{from{background-position:180% 0}to{background-position:-180% 0}}`}</style>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10, marginBottom: 12 }}>
      {[['PORTFOLIO VALUE', isConnected ? fmtUSD(totalValue) : '—', totalValue > 0 ? `≈ ${(totalValue / 2600).toFixed(4)} ETH` : ''], ['24H PNL', isConnected ? (hasPnl ? `${totalPnL >= 0 ? '+' : ''}${fmtUSD(totalPnL)}` : 'PnL unavailable') : '—', hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}%` : ''], ['TOKENS', isConnected ? `${sorted.length}` : '—', 'Base assets'], ['WALLET', isConnected && address ? formatShortAddress(address) : 'Not connected', isConnected ? 'View on Explorer ↗' : ''], ['NETWORK', 'Base', 'Healthy']].map(([k, v, s], i) => <div key={String(k)} className='glass' style={{ padding: 14, minHeight: 92 }}>{loading ? <div className='sk' style={{ height: 54, borderRadius: 12 }} /> : <><div style={{ fontSize: 10, letterSpacing: '.15em', color: '#94a3b8' }}>{k}</div><div style={{ fontSize: i === 3 ? 24 : 34, fontWeight: 800, marginTop: 4, color: i === 1 && hasPnl ? ((pnlPct ?? 0) >= 0 ? '#2dd4bf' : '#fb7185') : '#f8fafc' }}>{v}</div><div style={{ fontSize: 12, color: '#67e8f9' }}>{s}</div></>}</div>)}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.1fr) minmax(320px,1fr)', gap: 12 }}>
      <div style={{ display: 'grid', gap: 12 }}>
        <section className='glass' style={{ padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}><div><div style={{ fontSize: 32, fontWeight: 800 }}>{fmtUSD(totalValue)}</div><div style={{ color: hasPnl ? ((pnlPct ?? 0) >= 0 ? '#2dd4bf' : '#fb7185') : '#94a3b8' }}>{hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}% (24H)` : 'No chart data yet'}</div></div><div>{(['24H', '7D', '30D', '90D', 'ALL'] as const).map((r) => <button key={r} onClick={() => setRange(r)} style={{ marginLeft: 6, borderRadius: 10, border: '1px solid rgba(125,211,252,.24)', padding: '6px 11px', background: range === r ? 'rgba(34,211,238,.2)' : 'transparent', color: range === r ? '#67e8f9' : '#94a3b8' }}>{r}</button>)}</div></div>
          {loading ? <div className='sk' style={{ height: 250, borderRadius: 14 }} /> : sorted.length === 0 ? <div style={{ height: 250, borderRadius: 14, display: 'grid', placeItems: 'center', textAlign: 'center', border: '1px dashed rgba(125,211,252,.22)', color: '#94a3b8' }}><div><div style={{ fontWeight: 700, color: '#e2e8f0' }}>No chart data yet.</div><div>Connect or scan a wallet with supported Base assets to populate your portfolio.</div></div></div> : <svg viewBox='0 0 100 100' style={{ width: '100%', height: 250, borderRadius: 14, background: 'radial-gradient(circle at 50% 0%, rgba(56,189,248,.08), rgba(6,10,22,.95) 58%)' }}><defs><linearGradient id='pl' x1='0' x2='1'><stop offset='0%' stopColor='#22d3ee'/><stop offset='40%' stopColor='#60a5fa'/><stop offset='72%' stopColor='#a78bfa'/><stop offset='100%' stopColor='#ec4899'/></linearGradient></defs><polyline fill='none' stroke='rgba(148,163,184,.15)' strokeWidth='0.4' points='0,80 100,80' /><polyline fill='none' stroke='url(#pl)' strokeWidth='1.6' points={chartPoints} /><polyline fill='url(#pl)' opacity='0.16' points={`${chartPoints} 100,94 0,94`} /></svg>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 8, marginTop: 10 }}>{[
            ['Highest Holding', topHolding ? `${topHolding.symbol} • ${fmtUSD(topHolding.value)}` : '—'],
            ['Best Performer', bestPerformer && typeof bestPerformer.change24h === 'number' ? `${bestPerformer.symbol} • +${bestPerformer.change24h.toFixed(2)}%` : '—'],
            ['Portfolio Change', hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}%` : 'Unverified'],
            ['Risk Score', sorted.length ? `${Math.round(100 - safety)}/100` : 'Unverified'],
          ].map(([k, v]) => <div key={String(k)} className='glass' style={{ padding: 10, borderRadius: 12 }}><div style={{ fontSize: 10, color: '#94a3b8' }}>{k}</div><div style={{ fontWeight: 700, marginTop: 4 }}>{v}</div></div>)}</div>
        </section>

        <section className='glass' style={{ padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}><h3 style={{ margin: 0 }}>Your Holdings</h3><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder='Search tokens...' style={{ borderRadius: 10, border: '1px solid rgba(125,211,252,.24)', background: 'rgba(10,14,26,.75)', color: '#e2e8f0', padding: '8px 10px' }} /></div>
          {loading ? <div className='sk' style={{ height: 220, borderRadius: 12 }} /> : empty ? <div style={{ border: '1px dashed rgba(125,211,252,.24)', borderRadius: 12, padding: 28, textAlign: 'center' }}><div style={{ fontWeight: 700 }}>No supported Base token balances found</div><div style={{ color: '#94a3b8', marginTop: 6 }}>Connect or scan a wallet with supported Base assets to populate your portfolio.</div></div> : <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr style={{ color: '#94a3b8', fontSize: 12 }}><th align='left'>Asset</th><th align='right'>Balance</th><th align='right'>Price</th><th align='right'>Value</th><th align='right'>24H %</th><th align='center'>Trend</th><th align='right'>Allocation</th></tr></thead><tbody>{filtered.map((h) => {const up=(h.change24h??0)>=0; const alloc=totalValue>0?(h.value/totalValue)*100:0; return <tr key={`${h.symbol}-${h.name}`} style={{ borderTop: '1px solid rgba(148,163,184,.12)' }}><td style={{ padding: '10px 0' }}><div style={{ fontWeight: 700 }}>{h.symbol}</div><div style={{ color: '#94a3b8', fontSize: 12 }}>{h.name}</div></td><td align='right'>{fmtBalance(h.balance)}</td><td align='right'>{fmtPrice(h.price)}</td><td align='right'>{fmtUSD(h.value)}</td><td align='right' style={{ color: typeof h.change24h === 'number' ? (up ? '#2dd4bf' : '#fb7185') : '#94a3b8' }}>{typeof h.change24h === 'number' ? `${up ? '+' : ''}${h.change24h.toFixed(2)}%` : '—'}</td><td align='center'><svg width='72' height='22' viewBox='0 0 100 40'><polyline fill='none' stroke={up ? '#2dd4bf' : '#f43f5e'} strokeWidth='3' points={spark(h.symbol, up)} /></svg></td><td align='right'><div>{alloc.toFixed(1)}%</div><div style={{ height: 5, borderRadius: 999, background: 'rgba(100,116,139,.25)', marginTop: 4 }}><div style={{ height: '100%', width: `${alloc}%`, borderRadius: 999, background: 'linear-gradient(90deg,#22d3ee,#a855f7)' }} /></div></td></tr>})}</tbody></table></div>}
        </section>
      </div>

      <aside style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        <section className='glass' style={{ padding: 14 }}>
          <h3 style={{ marginTop: 0 }}>Clark AI Insights</h3>
          {clarkLoading || loading ? <div className='sk' style={{ height: 220, borderRadius: 12 }} /> : sorted.length === 0 ? <div style={{ color: '#94a3b8' }}>Clark needs portfolio data to generate a stronger read.</div> : <><div style={{ fontSize: 12, color: '#94a3b8' }}>Portfolio Verdict</div><div style={{ fontSize: 38, fontWeight: 900, color: verdict === 'BULLISH' ? '#2dd4bf' : verdict === 'NEUTRAL' ? '#67e8f9' : verdict === 'CAUTIOUS' ? '#f59e0b' : '#fb7185' }}>{verdict}</div>{clarkText && <p style={{ fontSize: 12, color: '#cbd5e1', whiteSpace: 'pre-line' }}>{clarkText.split('\n').slice(0, 4).join('\n')}</p>}
            {[['Profitability', profitability], ['Safety', safety], ['Momentum', momentum], ['Diversification', diversification]].map(([n, sc]) => <div key={String(n)} style={{ marginTop: 8 }}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span>{n}</span><span>{Math.round(sc as number)}/100</span></div><div style={{ height: 6, borderRadius: 999, background: 'rgba(100,116,139,.22)' }}><div style={{ height: '100%', width: `${Math.round(sc as number)}%`, borderRadius: 999, background: 'linear-gradient(90deg,#22d3ee,#a855f7)' }} /></div></div>)}
            <div className='glass' style={{ marginTop: 12, padding: 10, borderRadius: 12 }}><div style={{ color: '#67e8f9', fontSize: 11 }}>Top Opportunity</div><div>{bestPerformer ? `${bestPerformer.symbol} shows strongest short-term momentum.` : 'No strong opportunity detected yet.'}</div><div style={{ color: '#67e8f9', marginTop: 6 }}>View More →</div></div></>}
        </section>
        <section className='glass' style={{ padding: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><h3 style={{ marginTop: 0 }}>Recent Activity</h3><span style={{ color: '#67e8f9' }}>View All</span></div>{loading ? <div className='sk' style={{ height: 170, borderRadius: 12 }} /> : <div style={{ border: '1px dashed rgba(125,211,252,.2)', borderRadius: 12, padding: 16, color: '#94a3b8' }}>Recent wallet activity will appear here once transactions are detected.</div>}</section>
      </aside>
    </div>

    {!isConnected && <div className='glass' style={{ marginTop: 12, padding: 18, textAlign: 'center' }}><div style={{ fontWeight: 700, fontSize: 18 }}>Connect your wallet to unlock your portfolio cockpit.</div><button onClick={() => open()} style={{ marginTop: 10, borderRadius: 10, border: '1px solid rgba(45,212,191,.44)', background: 'rgba(45,212,191,.18)', color: '#99f6e4', padding: '10px 16px' }}>Connect Wallet</button></div>}
  </div>
}
