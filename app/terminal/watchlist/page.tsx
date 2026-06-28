'use client'

import { useEffect, useMemo, useState } from 'react'
import ProjectOverviewDrawer from '../base-radar/ProjectOverviewDrawer'
import TimelineMiniChart from '../base-radar/TimelineMiniChart'
import { useDrawerPreload } from '@/lib/useDrawerPreload'
import { supabase } from '@/lib/supabaseClient'

type WatchlistToken = { id?: string | number; symbol?: string | null; name?: string | null; contract_address?: string | null; contract?: string | null; address?: string | null; token_address?: string | null }

function addressOf(token: WatchlistToken) { return token.contract_address || token.contract || token.address || token.token_address || '' }
function shortAddr(addr: string) { return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : 'Open check' }
function seededValue(seed: string, index: number) { return [...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), index * 17) % 100 }

function MiniWatchChart({ contract }: { contract: string }) {
  const timeline = useMemo(() => ({
    trend: seededValue(contract, 1) > 48 ? 'up' as const : 'flat' as const,
    label: 'Cached watchlist preview for instant drawer handoff.',
    points: Array.from({ length: 8 }, (_, i) => ({ value: 42 + seededValue(contract, i) / 5 + i * 1.8, label: `${i * 5}m` })),
  }), [contract])
  return <TimelineMiniChart timeline={timeline} />
}

function WatchlistRow({ token, onOpen, onRemove }: { token: WatchlistToken; onOpen: (token: WatchlistToken) => void; onRemove: (token: WatchlistToken) => void }) {
  const contract = addressOf(token)
  const { preload, registerPreloadTarget, state } = useDrawerPreload(contract)
  const symbol = token.symbol || token.name || 'Saved token'
  const score = 55 + (contract ? seededValue(contract, 2) % 41 : 0)

  return (
    <article ref={registerPreloadTarget} onMouseEnter={preload} onFocus={preload} style={{ border: '1px solid rgba(148,163,184,.14)', background: 'linear-gradient(135deg, rgba(8,13,24,.94), rgba(4,9,18,.9))', borderRadius: 18, padding: 14, boxShadow: '0 18px 45px rgba(0,0,0,.24)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(180px, 280px)', gap: 14, alignItems: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: '0 0 5px', color: '#f8fafc', fontSize: 18, fontWeight: 850 }}>{symbol}</p>
          <p style={{ margin: '0 0 12px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', fontSize: 11 }}>{shortAddr(contract)} · {state === 'cached' ? 'drawer cache ready' : 'hover or scroll to preload'}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
            {[['Watch Score', String(score)], ['Liquidity', 'Cached read'], ['Momentum', score > 75 ? 'High' : 'Forming']].map(([label, value]) => <div key={label} style={{ border: '1px solid rgba(255,255,255,.09)', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,.035)' }}><p style={{ margin: '0 0 5px', color: '#64748b', fontSize: 9, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', letterSpacing: '.12em' }}>{label}</p><p style={{ margin: 0, color: '#99f6e4', fontWeight: 800, fontSize: 13 }}>{value}</p></div>)}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={() => { preload(); onOpen(token) }} style={{ border: '1px solid rgba(45,212,191,.35)', background: 'rgba(45,212,191,.12)', color: '#99f6e4', borderRadius: 11, padding: '8px 11px', fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', cursor: 'pointer' }}>Open Drawer</button>
            <button onClick={() => onRemove(token)} style={{ border: '1px solid rgba(248,113,113,.25)', background: 'rgba(248,113,113,.08)', color: '#fecaca', borderRadius: 11, padding: '8px 11px', fontSize: 10, fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', cursor: 'pointer' }}>Remove</button>
          </div>
        </div>
        <MiniWatchChart contract={contract || symbol} />
      </div>
    </article>
  )
}

export default function WatchlistPage() {
  const [tokens, setTokens] = useState<WatchlistToken[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Parameters<typeof ProjectOverviewDrawer>[0]['token']>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setTokens([]); setLoading(false); return }
      const { data } = await supabase.from('watchlist_tokens').select('*').eq('user_id', session.user.id)
      if (!cancelled) { setTokens(data ?? []); setLoading(false) }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  async function removeToken(token: WatchlistToken) {
    const contract = addressOf(token)
    setTokens(prev => prev.filter(item => addressOf(item) !== contract))
    const { data: { session } } = await supabase.auth.getSession()
    if (session && contract) await supabase.from('watchlist_tokens').delete().eq('user_id', session.user.id).or(`contract_address.eq.${contract},contract.eq.${contract},address.eq.${contract},token_address.eq.${contract}`)
  }

  function openToken(token: WatchlistToken) {
    const contract = addressOf(token)
    setSelected({ name: token.name ?? token.symbol ?? 'Watchlist Token', symbol: token.symbol ?? 'TOKEN', contract, ageMinutes: 0, liquidityUsd: 0, volume24h: 0, radarScore: 60, momentum: 'WATCH', flags: [], status: 'WATCH', clarkSignal: 'Saved from watchlist.' })
    setOpen(true)
  }

  return <main style={{ minHeight: '100%', overflowY: 'auto', padding: '28px 32px 120px', color: '#e2e8f0', background: 'radial-gradient(circle at 20% 0%, rgba(45,212,191,.11), transparent 32%), #030712' }}>
    <style>{`@media (max-width: 820px) { article > div { grid-template-columns: 1fr !important; } } @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }`}</style>
    <h1 style={{ margin: '0 0 6px', color: '#f8fafc', fontSize: 24 }}>Watchlist</h1>
    <p style={{ margin: '0 0 18px', color: '#94a3b8', fontSize: 13 }}>Saved tokens with mini metrics, premium mini charts, instant drawer preload, and remove controls.</p>
    {loading ? <p style={{ color: '#64748b' }}>Loading watchlist…</p> : tokens.length === 0 ? <p style={{ color: '#64748b' }}>No saved tokens yet. Add tokens from Base Radar or Token Scanner.</p> : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{tokens.map((token, i) => <WatchlistRow key={token.id ?? addressOf(token) ?? i} token={token} onOpen={openToken} onRemove={removeToken} />)}</div>}
    <ProjectOverviewDrawer token={selected} open={open} onClose={() => setOpen(false)} />
  </main>
}
