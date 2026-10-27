'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import type { EarlyBuyerIntel } from '@/lib/server/earlyBuyers/types'
import { earlyBuyerDisplayStatus, heldRawLabel } from '@/lib/server/earlyBuyers/types'

const mono = 'var(--font-plex-mono)'
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`
const link = (chain: string, hash: string) => `${chain === 'base' ? 'https://basescan.org' : 'https://etherscan.io'}/tx/${hash}`

export default function EarlyBuyersPanel({ chain, contract }: { chain: string; contract: string }) {
  const [intel, setIntel] = useState<EarlyBuyerIntel | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function load() {
    if (loading) return
    setLoading(true); setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const response = await fetch('/api/token/early-buyers', { method: 'POST', headers: { 'content-type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }, body: JSON.stringify({ chain, contract }), cache: 'no-store' })
      const payload = await response.json() as { earlyBuyerIntel?: EarlyBuyerIntel; error?: string }
      if (!response.ok || !payload.earlyBuyerIntel) throw new Error(payload.error ?? 'Early-buyer analysis unavailable')
      setIntel(payload.earlyBuyerIntel)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Early-buyer analysis unavailable') }
    finally { setLoading(false) }
  }
  const labels = intel ? earlyBuyerDisplayStatus(intel) : null
  const accent = labels?.launch === 'VERIFIED' ? '#34d399' : labels?.launch === 'PARTIAL' ? '#fbbf24' : '#94a3b8'
  return <section aria-label="Early Buyers" style={{ display: 'grid', gap: 12, color: '#cbd5e1', fontFamily: mono }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div><div style={{ color: '#7dd3fc', fontSize: 11, fontWeight: 800, letterSpacing: '.12em' }}>EARLY BUYERS</div><div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>On-chain launch window · separate from risk and Dev Control</div></div>
      <button type="button" onClick={load} disabled={loading} style={{ border: '1px solid rgba(125,211,252,.35)', background: 'rgba(125,211,252,.08)', color: '#7dd3fc', borderRadius: 9, padding: '8px 12px', cursor: loading ? 'wait' : 'pointer', fontFamily: mono, fontSize: 11 }}>{loading ? 'Checking launch…' : intel ? 'Refresh evidence' : 'Analyze early buyers'}</button>
    </div>
    {error && <div role="status" style={{ color: '#fbbf24', fontSize: 11 }}>{error}</div>}
    {intel && <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11 }}>
        <span style={{ color: accent }}>Launch investigation: {labels?.launch}</span>
        <span>Current holdings: {labels?.holdings}</span>
        <span>Launch block {intel.launch.block ?? 'unverified'} · {intel.launch.status}</span>
        <span>{intel.window.buysObserved} observed token deliveries</span>
        {intel.coverage.provisional && <span style={{ color: '#fbbf24' }}>Provisional window</span>}
      </div>
      {intel.launch.creationTx && <a href={link(chain, intel.launch.creationTx)} target="_blank" rel="noopener noreferrer" style={{ color: '#7dd3fc', fontSize: 11 }}>Pool creation {short(intel.launch.creationTx)} ↗</a>}
      {intel.groups.filter((g) => g.tier === 'T1').map((group, i) => <div key={`t1-${i}`} style={{ borderLeft: '2px solid #34d399', paddingLeft: 12, fontSize: 11 }}><div style={{ color: '#34d399', fontWeight: 800 }}>T1 · Shared transaction delivery · {group.wallets.length} recipients</div><div style={{ color: '#94a3b8', marginTop: 4 }}>{group.reason} Coordination and individual payment are not proven.</div><div style={{ marginTop: 4 }}>Received {group.boughtWithinEarlySetPct ?? 'unavailable'}% of observed pool-sourced deliveries · held now {group.heldWithinEarlySetPct == null ? 'unavailable' : `${group.heldWithinEarlySetPct}% within observed recipient set`}</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 5 }}>{group.transactions.map((hash) => <a key={hash} href={link(chain, hash)} target="_blank" rel="noopener noreferrer" style={{ color: '#7dd3fc' }}>{short(hash)} ↗</a>)}</div></div>)}
      {intel.groups.filter((g) => g.tier === 'T2').map((group, i) => <div key={`t2-${i}`} style={{ borderLeft: '2px solid #fbbf24', paddingLeft: 12, fontSize: 11 }}><div style={{ color: '#fbbf24', fontWeight: 800 }}>T2 · Association, not proof · {group.wallets.length} wallets</div><div style={{ color: '#94a3b8', marginTop: 4 }}>{group.reason}</div></div>)}
      {intel.sameBlockCount > 0 && <div style={{ color: '#94a3b8', fontSize: 11 }}>T3 · {intel.sameBlockCount} recipients shared a block. Timing alone proves no coordination or ownership.</div>}
      {intel.buyers.length > 0 && <div style={{ display: 'grid', gap: 5, fontSize: 11 }}><div style={{ color: '#7dd3fc', fontWeight: 800 }}>Observed pool-sourced recipients</div>{intel.buyers.slice(0, 20).map((buyer) => <div key={buyer.wallet} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: '#94a3b8' }}><span>{short(buyer.wallet)}</span><span>Received {buyer.boughtRaw} raw</span><span>Held {heldRawLabel(buyer.heldRaw)}</span>{buyer.evidence?.[0] && <span>Pool {short(buyer.evidence[0].pool)} · block {buyer.evidence[0].block}{buyer.evidence[0].timestampSec ? ` · ${new Date(buyer.evidence[0].timestampSec * 1000).toLocaleString()}` : ''}</span>}{buyer.transactions[0] && <a href={link(chain, buyer.transactions[0])} target="_blank" rel="noopener noreferrer" style={{ color: '#7dd3fc' }}>Tx ↗</a>}</div>)}</div>}
      {intel.discovery && <div style={{ fontSize: 10, color: '#94a3b8' }}>Earliest discovered pool {intel.discovery.earliestDiscoveredPool ? short(intel.discovery.earliestDiscoveredPool) : 'unresolved'} · earliest verified {intel.discovery.earliestVerifiedPool ? short(intel.discovery.earliestVerifiedPool) : 'unresolved'} · discovery {intel.discovery.complete ? 'complete within selected candidates' : 'incomplete'}{intel.discovery.candidates.map((candidate) => <div key={candidate.pool}>{short(candidate.pool)} · {candidate.outcome} · {candidate.reason}</div>)}</div>}
      {intel.launchDistributions.length > 0 && <div style={{ fontSize: 11, color: '#fbbf24' }}>{intel.launchDistributions.length} creator-origin launch distributions observed separately; not counted as buys.</div>}
      <div style={{ borderTop: '1px solid rgba(148,163,184,.15)', paddingTop: 8, color: '#64748b', fontSize: 10 }}>Pool-sourced token delivery is not proof that each recipient paid or coordinated. {intel.coverage.reasons.length > 0 ? `Coverage: ${intel.coverage.reasons.join(', ')}.` : 'Only the bounded early window is covered.'} {intel.budget.calls} RPC calls · {intel.budget.cu} estimated CU · {intel.budget.externalRequests ?? 0} external discovery requests; actual provider billing unavailable here.</div>
    </>}
  </section>
}
