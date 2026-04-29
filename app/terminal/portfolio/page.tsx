'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { useWeb3Modal } from '@web3modal/wagmi/react'

type Holding = {
  symbol: string
  name: string
  chain: string
  price: number
  balance: number
  value: number
  change24h: number | null
}

function fmtPrice(v: number): string {
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (v >= 1) return `$${v.toFixed(2)}`
  if (v >= 0.001) return `$${v.toFixed(4)}`
  if (v >= 0.000001) return `$${v.toFixed(6)}`
  return `$${v.toExponential(2)}`
}

function fmtUSD(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtBalance(v: number): string {
  if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(2)}K`
  return v.toFixed(v < 1 ? 4 : 2)
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function sparklinePoints(seed: string, positive: boolean) {
  const points: number[] = []
  let x = seed.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 97
  for (let i = 0; i < 24; i++) {
    x = (x * 29 + 17) % 97
    const base = positive ? 40 - i * 0.9 : 15 + i * 0.7
    points.push(Math.max(4, Math.min(46, base + (x % 10) - 5)))
  }
  return points.map((p, i) => `${(i / 23) * 100},${p}`).join(' ')
}

export default function PortfolioPage() {
  const { address, isConnected } = useAccount()
  const { open } = useWeb3Modal()
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [loadingPortfolio, setLoadingPortfolio] = useState(false)
  const [portfolioError, setPortfolioError] = useState<string | null>(null)
  const [clarkVerdict, setClarkVerdict] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkError, setClarkError] = useState<string | null>(null)
  const [range, setRange] = useState<'24H' | '7D' | '30D' | 'ALL'>('24H')
  const [search, setSearch] = useState('')

  const totalValue = holdings.reduce((s, h) => s + h.value, 0)
  const holdingsWithPnl = holdings.filter((h) => typeof h.change24h === 'number')
  const totalPnL = holdingsWithPnl.reduce((s, h) => s + h.value * ((h.change24h ?? 0) / 100), 0)
  const hasPnlData = holdingsWithPnl.length > 0
  const pnlPositive = totalPnL >= 0

  const filteredHoldings = useMemo(
    () => holdings.filter((h) => `${h.symbol} ${h.name}`.toLowerCase().includes(search.toLowerCase())),
    [holdings, search]
  )

  const topHolding = holdings.length > 0 ? [...holdings].sort((a, b) => b.value - a.value)[0] : null
  const bestPerformer = holdingsWithPnl.length > 0 ? [...holdingsWithPnl].sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0))[0] : null
  const diversification = holdings.length > 0 && topHolding ? Math.max(20, 100 - (topHolding.value / totalValue) * 100) : 0
  const profitability = hasPnlData && totalValue > 0 ? Math.max(0, Math.min(100, 50 + (totalPnL / totalValue) * 400)) : 0
  const momentum = hasPnlData ? Math.max(10, Math.min(100, 45 + holdingsWithPnl.reduce((s, h) => s + (h.change24h ?? 0), 0) / holdingsWithPnl.length * 5)) : 0
  const safety = Math.max(10, Math.min(100, 100 - (topHolding && totalValue > 0 ? (topHolding.value / totalValue) * 100 : 60)))
  const score = (profitability + momentum + safety + diversification) / 4
  const verdict = score > 66 ? 'BULLISH' : score > 45 ? 'NEUTRAL' : 'CAUTIOUS'

  async function analyzePortfolio(h: Holding[]) {
    setClarkLoading(true)
    setClarkVerdict(null)
    setClarkError(null)
    try {
      const prompt = `You are Clark, the AI analyst of ChainLens AI. Analyze this Base wallet portfolio and provide exactly four lines with no markdown, no bullet points, no headers — just plain text:\n\nLine 1 — Trader personality type\nLine 2 — Risk score: X/100 and one sentence reason\nLine 3 — Biggest risk flag in this portfolio\nLine 4 — One paragraph verdict on this portfolio\n\nPortfolio:\n${h.map((t) => `${t.symbol} (${t.name}): $${t.value.toFixed(2)} value${typeof t.change24h === 'number' ? `, ${t.change24h > 0 ? '+' : ''}${t.change24h.toFixed(2)}% 24h` : ''}`).join('\n')}\nTotal portfolio value: ${fmtUSD(h.reduce((s, t) => s + t.value, 0))}`
      const res = await fetch('/api/clark', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'clark-ai', prompt, message: prompt, mode: 'portfolio', context: { holdings: h } }),
      })
      const json = await res.json()
      if (json.ok) setClarkVerdict(json.data?.reply ?? json.data?.analysis ?? json.data?.response ?? 'No verdict returned.')
      else setClarkError(json.error ?? 'Clark analysis failed.')
    } catch {
      setClarkError('Network error — Clark unavailable.')
    } finally { setClarkLoading(false) }
  }

  useEffect(() => {
    async function loadPortfolio() {
      if (!isConnected || !address) {
        setHoldings([]); setPortfolioError(null); setClarkVerdict(null); setClarkError(null); return
      }
      setLoadingPortfolio(true); setPortfolioError(null); setClarkVerdict(null); setClarkError(null)
      try {
        const res = await fetch('/api/wallet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) })
        const json = await res.json()
        if (!res.ok) throw new Error(json?.error ?? 'Portfolio lookup failed')
        const baseHoldings = (json?.holdings ?? []).filter((h: Holding) => (h.chain ?? '').toLowerCase().includes('base')).map((h: Holding) => ({
          symbol: h.symbol ?? '?', name: h.name ?? 'Unknown', chain: h.chain ?? 'base', price: Number(h.price ?? 0), balance: Number(h.balance ?? 0), value: Number(h.value ?? 0), change24h: typeof h.change24h === 'number' ? h.change24h : null,
        }))
        setHoldings(baseHoldings)
        if (baseHoldings.length > 0) analyzePortfolio(baseHoldings)
      } catch {
        setHoldings([]); setPortfolioError('Portfolio data unavailable right now. Try again in a moment.')
      } finally { setLoadingPortfolio(false) }
    }
    loadPortfolio()
  }, [isConnected, address])

  const empty = isConnected && !loadingPortfolio && !portfolioError && holdings.length === 0

  return <div style={{ height: '100%', overflow: 'auto', background: 'radial-gradient(circle at 20% -20%, rgba(45,212,191,0.16), transparent 35%), radial-gradient(circle at 90% 0%, rgba(168,85,247,0.18), transparent 30%), #04070f', color: '#e2e8f0', padding: 20 }}>
    <style>{`.glass{background:linear-gradient(160deg,rgba(16,24,42,.82),rgba(7,11,22,.76));border:1px solid rgba(123,151,196,.17);backdrop-filter: blur(8px);border-radius:18px}.sk{background:linear-gradient(90deg,rgba(148,163,184,.12),rgba(148,163,184,.22),rgba(148,163,184,.12));background-size:200% 100%;animation:sh 1.6s infinite}@keyframes sh{from{background-position:200% 0}to{background-position:-200% 0}}`}</style>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 16 }}>
      {[['Portfolio Value', isConnected ? fmtUSD(totalValue) : '—'], ['24H PnL', isConnected ? (hasPnlData ? `${pnlPositive ? '+' : ''}${fmtUSD(totalPnL)}` : 'Unavailable') : '—'], ['Tokens', isConnected ? `${holdings.length}` : '—'], ['Wallet', isConnected && address ? shortAddress(address) : 'Not connected'], ['Network', 'Base']].map(([k, v], idx) => <div key={k} className='glass' style={{ padding: 14 }}>{loadingPortfolio ? <div className='sk' style={{ height: 40, borderRadius: 12 }} /> : <><div style={{ fontSize: 10, letterSpacing: '.15em', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>{k}</div><div style={{ fontSize: idx === 3 ? 16 : 28, fontWeight: 800, marginTop: 6 }}>{v}</div></>}</div>)}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(300px,1fr)', gap: 14 }}>
      <div style={{ display: 'grid', gap: 14 }}>
        <div className='glass' style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}><h3 style={{ margin: 0 }}>Portfolio Overview</h3><div>{(['24H','7D','30D','ALL'] as const).map(r => <button key={r} onClick={() => setRange(r)} style={{ marginLeft: 6, borderRadius: 999, border: '1px solid rgba(148,163,184,.3)', background: range===r?'rgba(34,211,238,.18)':'transparent', color: '#cbd5e1', padding: '4px 10px' }}>{r}</button>)}</div></div>
          {loadingPortfolio ? <div className='sk' style={{ height: 280, borderRadius: 16 }} /> : empty ? <div style={{height:280,display:'grid',placeItems:'center',textAlign:'center',border:'1px dashed rgba(125,211,252,.28)',borderRadius:16,color:'#94a3b8'}}><div><div style={{fontSize:20,fontWeight:700,color:'#e2e8f0'}}>No supported Base token balances found yet.</div><div>Connect or scan a wallet with supported Base assets to populate your portfolio.</div></div></div> : <svg viewBox='0 0 100 40' style={{ width: '100%', height: 280, borderRadius: 16, background: 'linear-gradient(180deg,rgba(6,12,24,.7),rgba(4,6,14,.95))' }}><polyline fill='none' stroke='url(#g)' strokeWidth='1.4' points={sparklinePoints((address ?? 'portfolio') + range, true)} /><defs><linearGradient id='g'><stop stopColor='#2dd4bf'/><stop offset='1' stopColor='#d946ef'/></linearGradient></defs></svg>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 10, marginTop: 12 }}>{[
            ['Highest Holding', topHolding ? `${topHolding.symbol} • ${fmtUSD(topHolding.value)}` : '—'],
            ['Best Performer', bestPerformer && typeof bestPerformer.change24h==='number' ? `${bestPerformer.symbol} • +${bestPerformer.change24h.toFixed(2)}%` : '—'],
            ['Portfolio Change', hasPnlData ? `${pnlPositive?'+':''}${((totalPnL/Math.max(totalValue,1))*100).toFixed(2)}%` : '—'],
            ['Risk Score', `${Math.round(100-safety)}/100`],
          ].map(([k,v]) => <div key={k} className='glass' style={{padding:10,borderRadius:12}}><div style={{fontSize:10,color:'#94a3b8'}}>{k}</div><div style={{fontWeight:700,marginTop:4}}>{v}</div></div>)}</div>
        </div>

        <div className='glass' style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}><h3 style={{ margin: 0 }}>Your Holdings</h3><input placeholder='Search token' value={search} onChange={(e) => setSearch(e.target.value)} style={{ background: 'rgba(15,23,42,.8)', border: '1px solid rgba(148,163,184,.25)', color: '#e2e8f0', borderRadius: 10, padding: '8px 10px' }} /></div>
          {loadingPortfolio ? <div className='sk' style={{ height: 230, borderRadius: 12 }} /> : empty ? <div style={{padding:26,textAlign:'center',color:'#94a3b8',border:'1px dashed rgba(148,163,184,.28)',borderRadius:12}}>No holdings to display yet.</div> : <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr style={{ color: '#94a3b8', fontSize: 12 }}><th align='left'>Token</th><th align='right'>Balance</th><th align='right'>Price</th><th align='right'>Value</th><th align='right'>24H</th><th align='center'>Trend</th><th align='right'>Allocation</th></tr></thead><tbody>{filteredHoldings.map((h) => {const alloc=totalValue>0?(h.value/totalValue)*100:0; const pos=(h.change24h??0)>=0; return <tr key={h.symbol} style={{ borderTop: '1px solid rgba(148,163,184,.12)' }}><td style={{ padding: '10px 0' }}><div style={{ fontWeight: 700 }}>{h.symbol}</div><div style={{ color: '#94a3b8', fontSize: 12 }}>{h.name}</div></td><td align='right'>{fmtBalance(h.balance)}</td><td align='right'>{fmtPrice(h.price)}</td><td align='right'>{fmtUSD(h.value)}</td><td align='right' style={{ color: pos ? '#2dd4bf' : '#fb7185' }}>{typeof h.change24h==='number'?`${pos?'+':''}${h.change24h.toFixed(2)}%`:'—'}</td><td align='center'><svg viewBox='0 0 100 40' width='70' height='24'><polyline fill='none' stroke={pos?'#2dd4bf':'#f43f5e'} strokeWidth='3' points={sparklinePoints(h.symbol,pos)} /></svg></td><td align='right'>{alloc.toFixed(1)}%</td></tr>})}</tbody></table></div>}
          <div style={{ marginTop: 10, textAlign: 'center', color: '#67e8f9' }}>View All Holdings →</div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        <div className='glass' style={{ padding: 16 }}><h3 style={{ marginTop: 0 }}>Clark AI Insights</h3>
          {loadingPortfolio || clarkLoading ? <div className='sk' style={{ height: 220, borderRadius: 12 }} /> : empty ? <div style={{ color: '#94a3b8' }}>Clark needs portfolio data to generate insights.</div> : <>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>Portfolio Verdict</div><div style={{ fontSize: 34, fontWeight: 900, color: verdict==='BULLISH'?'#2dd4bf':verdict==='NEUTRAL'?'#67e8f9':'#f59e0b' }}>{verdict}</div>
            {clarkVerdict && <p style={{ whiteSpace: 'pre-line', color: '#cbd5e1', fontSize: 12 }}>{clarkVerdict}</p>}
            {clarkError && <p style={{ color: '#fca5a5' }}>{clarkError}</p>}
            {[['Profitability', profitability], ['Safety', safety], ['Momentum', momentum], ['Diversification', diversification]].map(([k,v]) => <div key={k as string} style={{ marginTop: 8 }}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span>{k}</span><span>{Math.round(v as number)}/100</span></div><div style={{ height: 6, background: 'rgba(100,116,139,.25)', borderRadius: 999 }}><div style={{ width: `${Math.round(v as number)}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,#2dd4bf,#a855f7)' }} /></div></div>)}
            <div className='glass' style={{ marginTop: 12, padding: 10, borderRadius: 12 }}><div style={{ fontSize: 11, color: '#67e8f9' }}>Top Opportunity</div><div style={{ fontSize: 13 }}>{bestPerformer ? `${bestPerformer.symbol} shows strongest short-term momentum.` : 'Need more token performance data.'}</div></div>
            <div style={{ marginTop: 10, color: '#67e8f9' }}>View More →</div>
          </>}
        </div>
        <div className='glass' style={{ padding: 16 }}><h3 style={{ marginTop: 0 }}>Recent Activity</h3><div style={{ color: '#94a3b8', fontSize: 13 }}>Activity feed is unavailable in this view right now.</div><div style={{ marginTop: 10, color: '#67e8f9' }}>View All Activity →</div></div>
      </div>
    </div>

    {!isConnected && <div className='glass' style={{ marginTop: 16, padding: 20, textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Connect your wallet to unlock your premium portfolio dashboard.</div><button onClick={() => open()} style={{ borderRadius: 10, border: '1px solid rgba(45,212,191,.5)', background: 'rgba(45,212,191,.16)', color: '#99f6e4', padding: '10px 20px' }}>Connect Wallet</button></div>}
  </div>
}
