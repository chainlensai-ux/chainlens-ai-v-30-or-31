'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import type { EarlyBuyerIntel } from '@/lib/server/earlyBuyers/types'
import EarlyBuyersReport from './EarlyBuyersReport'
import { earlyBuyersRequestFailure, type EarlyBuyersRequestFailure } from './earlyBuyersView'

// One request per click. A failure is shown as a plain message with the server's request id (the key to its log
// line); a timeout or gateway page that is not JSON no longer surfaces as a JSON parse error.
export default function EarlyBuyersPanel({ chain, contract, decimals = null, tokenSymbol = null }: { chain: string; contract: string; decimals?: number | null; tokenSymbol?: string | null }) {
  const [intel, setIntel] = useState<EarlyBuyerIntel | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<EarlyBuyersRequestFailure | null>(null)
  async function load() {
    if (loading) return
    setLoading(true); setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch('/api/token/early-buyers', { method: 'POST', headers: { 'content-type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }, body: JSON.stringify({ chain, contract }), cache: 'no-store' })
      const requestId = response.headers.get('x-early-buyers-request-id')
      const body = await response.text()
      let payload: { earlyBuyerIntel?: EarlyBuyerIntel } | null = null
      try { payload = JSON.parse(body) as { earlyBuyerIntel?: EarlyBuyerIntel } } catch { payload = null }
      if (!response.ok || !payload?.earlyBuyerIntel) { setError(earlyBuyersRequestFailure(response.ok ? 502 : response.status, body, requestId)); return }
      setIntel(payload.earlyBuyerIntel)
    } catch {
      setError({ message: 'Early Buyers could not be reached. Check your connection and try again.', code: null, requestId: null })
    }
    finally { setLoading(false) }
  }
  return <section aria-label="Early Buyers" aria-busy={loading} style={{ display: 'grid', gap: 14, fontFamily: 'var(--font-plex-mono)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
      <div>
        <h3 style={{ margin: 0, color: '#a9e9ec', fontSize: 11, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase' }}>Early Buyers</h3>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: '#6f7275' }}>Bounded first-trade investigation · separate from risk scoring and Dev Control</p>
      </div>
      <button type="button" onClick={load} disabled={loading} style={{ border: '1px solid rgba(169,233,236,.35)', background: 'rgba(169,233,236,.06)', color: '#a9e9ec', borderRadius: 9, padding: '8px 12px', cursor: loading ? 'wait' : 'pointer', fontFamily: 'var(--font-plex-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '.06em' }}>{loading ? 'Checking launch…' : intel ? 'Refresh evidence' : 'Analyze early buyers'}</button>
    </div>
    {!intel && !error && !loading && <p style={{ margin: 0, fontSize: 11.5, color: '#9ea1a4', maxWidth: '68ch' }}>Reads the first trades after verified launch liquidity on Base or Ethereum and lists which wallets received tokens from the pool, with transaction evidence. It does not show who paid, who owns which wallet, or every launch buyer.</p>}
    {error && <div role="status" style={{ color: '#fbbf24', fontSize: 11, lineHeight: 1.6 }}>
      {error.message}
      {(error.code || error.requestId) && <div style={{ color: '#6f7275', fontSize: 10, marginTop: 4 }}>{[error.code, error.requestId ? `ref ${error.requestId}` : null].filter(Boolean).join(' · ')}</div>}
    </div>}
    {intel && <EarlyBuyersReport intel={intel} chain={chain} decimals={decimals} tokenSymbol={tokenSymbol} decimalsSource={decimals != null ? 'decimals from token metadata' : undefined} />}
  </section>
}
