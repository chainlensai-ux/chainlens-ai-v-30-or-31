'use client'

import { useEffect, useState } from 'react'
import LiquiditySafetyVerdictCard, {
  type LiquiditySafetyResult,
} from '@/components/LiquiditySafetyVerdictCard'
import LPSafetyExtendedBox from '@/components/LPSafetyExtendedBox'
import { usePlanWithLoading, LockedPanel, canAccessFeature, PlanGateSkeleton } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

// CHAIN SELECTOR, DISCLOSED (reported live: "we have a liquidity safety problem for the chain
// robinhood"). This page previously sent NO chain at all, so /api/liquidity-safety always fell
// through to its "base" default — a Robinhood token could not be analyzed here at any URL, and a
// Robinhood address that happened to also exist on Base would have been reported using BASE's
// pools and BASE's LP proof. The route half of this fix makes "robinhood" a real ChainKey (see its
// header); this half gives users a way to actually select it. Robinhood only appears once
// /api/base-radar/chain-status confirms the deployment has it enabled AND RPC-configured — the
// same gate the Base Radar selector uses, and the same boolean the route itself enforces, so the
// option can never be offered for a chain the backend would silently downgrade to Base.
type LiquidityChain = 'base' | 'eth' | 'robinhood'
const CHAIN_LABEL: Record<LiquidityChain, string> = { base: 'Base', eth: 'Ethereum', robinhood: 'Robinhood' }

export default function LiquiditySafetyPage() {
  const { plan, loading: planLoading } = usePlanWithLoading()
  const [input, setInput]     = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState<LiquiditySafetyResult | null>(null)
  const [error, setError]     = useState<string | null>(null)
  const [chain, setChain]     = useState<LiquidityChain>('base')
  const [robinhoodAvailable, setRobinhoodAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/base-radar/chain-status?selectedChain=base')
        const json = await res.json().catch(() => null)
        if (!cancelled && json?.robinhood?.available === true) setRobinhoodAvailable(true)
      } catch { /* best-effort: on failure Robinhood simply stays hidden, never shown unverified */ }
    })()
    return () => { cancelled = true }
  }, [])

  async function handleScan() {
    const q = input.trim()
    if (!q || loading) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const isContract = /^0x[a-fA-F0-9]{40}$/.test(q)
      const body = isContract ? { contract: q, chain } : { query: q, chain }

      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res  = await fetch('/api/liquidity-safety', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      } as RequestInit)
      const json = await res.json()

      if (!res.ok || !json.ok) {
        setError(json.error ?? `Token not found on ${CHAIN_LABEL[chain]}.`)
      } else {
        setResult(json.data)
      }
    } catch {
      setError('Network error — check your connection.')
    } finally {
      setLoading(false)
    }
  }

  // SKELETON, NOT A TEXT WALL, DISCLOSED (performance + UX optimization task): this was a
  // full-screen "Loading plan access…" wall that ALSO rendered into the SSR HTML, so it flashed on
  // every single load even for a user whose plan was already cached. PlanGateSkeleton mirrors the
  // page's real rhythm so nothing jumps when content replaces it, and the shared account store now
  // only reports loading:true when there is genuinely no cached plan to trust.
  if (planLoading) return <PlanGateSkeleton />
  if (!canAccessFeature(plan, 'liquidity-safety')) return <LockedPanel feature="liquidity-safety" />

  return (
    <>
      <style>{`
        .lp-scan-btn:not(:disabled):hover { filter: brightness(1.08); transform: translateY(-1px); }
        .lp-scan-btn { transition: all 0.15s; }
        @keyframes lp-dot { 0%,80%,100%{opacity:.25;transform:scale(.75)} 40%{opacity:1;transform:scale(1)} }
        @media (max-width: 768px) {
          .lp-shell { flex-direction: column !important; height: auto !important; }
          .lp-main { padding: 20px 14px 120px !important; }
          .lp-input-row { flex-direction: column; }
          .lp-input-row button { width: 100%; }
          .lp-card { padding: 16px 14px !important; max-width: 100% !important; }
          .lp-report {
            width: 100% !important;
            border-left: none !important;
            border-top: 1px solid rgba(255,255,255,0.08) !important;
            max-height: 56dvh !important;
            min-height: 240px;
            overflow: hidden !important;
          }
          .lp-report-body { overflow-y: auto !important; min-height: 0 !important; }
        }
      `}</style>

      {/* ── Two-column shell ──────────────────────────────────────────── */}
      <div className="lp-shell" style={{ display: 'flex', height: '100%', overflow: 'hidden', color: '#e2e8f0' }}>

        {/* ── Left: scrollable main content ─────────────────────────── */}
        <div className="lp-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '40px 48px 120px' }}>

          {/* Page header */}
          <div style={{ marginBottom: '32px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              background: 'rgba(45,212,191,0.08)',
              border: '1px solid rgba(45,212,191,0.22)',
              borderRadius: '99px', padding: '5px 14px', marginBottom: '16px',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.9)', flexShrink: 0,
              }} />
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em',
                color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase',
              }}>
                Liquidity Safety
              </span>
            </div>
            <h1 style={{ fontSize: '26px', fontWeight: 700, color: '#f8fafc', lineHeight: 1.2, margin: '0 0 8px' }}>
              LP Safety <span style={{ color: '#2DD4BF' }}>Analyzer</span>
            </h1>
            <p style={{ fontSize: '13px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
              Analyze on-chain liquidity depth, fragmentation, and stability risk for any {CHAIN_LABEL[chain]} token.
            </p>
          </div>

          {/* Search */}
          <div className="lp-card" style={{
            background: '#080c14', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '14px', padding: '20px 24px', marginBottom: '28px', maxWidth: '680px',
          }}>
            <p style={{
              fontSize: '9px', fontWeight: 700, letterSpacing: '0.16em', color: '#3a5268',
              textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', marginBottom: '12px',
            }}>
              Token Address or Name
            </p>
            {/* Chain chips. 'eth' and 'base' were always accepted by the route; only 'robinhood' is
                new, and only shown when the deployment genuinely has it available. */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
              {(['base', 'eth', ...(robinhoodAvailable ? ['robinhood' as const] : [])] as LiquidityChain[]).map((c) => {
                const active = chain === c
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => { setChain(c); setResult(null); setError(null) }}
                    disabled={loading}
                    style={{
                      padding: '6px 14px', borderRadius: '999px', cursor: loading ? 'not-allowed' : 'pointer',
                      background: active ? 'rgba(45,212,191,0.12)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${active ? 'rgba(45,212,191,0.45)' : 'rgba(255,255,255,0.08)'}`,
                      color: active ? '#2DD4BF' : '#64748b',
                      fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em',
                      fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase',
                      transition: 'all 0.15s',
                    }}
                  >
                    {CHAIN_LABEL[c]}
                  </button>
                )
              })}
            </div>
            <div className="lp-input-row" style={{ display: 'flex', gap: '10px' }}>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
                disabled={loading}
                placeholder="0x… or token name  (e.g. brett, doginme, toshi)"
                style={{
                  flex: 1, padding: '12px 16px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '10px', color: '#e2e8f0', fontSize: '16px',
                  fontFamily: 'var(--font-plex-mono)', outline: 'none',
                  opacity: loading ? 0.5 : 1, transition: 'border-color 0.15s',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.40)' }}
                onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
              />
              <button
                className="lp-scan-btn"
                onClick={handleScan}
                disabled={loading || !input.trim()}
                style={{
                  padding: '12px 28px', borderRadius: '10px', border: 'none',
                  background: loading || !input.trim()
                    ? 'rgba(45,212,191,0.08)'
                    : 'linear-gradient(135deg, #2DD4BF 0%, #06b6d4 100%)',
                  color: loading || !input.trim() ? 'rgba(255,255,255,0.20)' : '#020a0a',
                  fontSize: '11px', fontWeight: 800,
                  fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.12em',
                  cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                  flexShrink: 0, textTransform: 'uppercase',
                }}
              >
                {loading ? 'SCANNING…' : 'SCAN LP'}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div style={{
              maxWidth: '680px', padding: '14px 18px',
              background: 'rgba(244,63,94,0.06)', border: '1px solid rgba(244,63,94,0.20)',
              borderRadius: '10px', color: '#fda4af',
              fontSize: '13px', fontFamily: 'var(--font-plex-mono)',
              marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '10px',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: '#f43f5e',
                flexShrink: 0, boxShadow: '0 0 6px rgba(244,63,94,0.8)',
              }} />
              {error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !result && !error && (
            <div style={{ maxWidth: '680px', padding: '60px 0', textAlign: 'center' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: 'rgba(45,212,191,0.06)', border: '1px solid rgba(45,212,191,0.12)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 16px',
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Z"
                    stroke="#2DD4BF" strokeOpacity="0.4" strokeWidth="1.5" />
                  <path d="M8 12h8M12 8v8" stroke="#2DD4BF" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <p style={{
                fontFamily: 'var(--font-plex-mono)', fontSize: '12px',
                letterSpacing: '0.08em', color: '#1e2e38', margin: 0,
              }}>
                enter a token to analyze its LP safety
              </p>
            </div>
          )}

          {/* Result card */}
          {result && (
            <div style={{ maxWidth: '760px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '20px' }}>
                <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                  {result.name}
                </h2>
                {result.symbol && (
                  <span style={{ fontSize: '13px', fontWeight: 700, color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}>
                    {result.symbol}
                  </span>
                )}
                {result.contract && (
                  <span style={{ fontSize: '11px', color: '#2a3f50', fontFamily: 'var(--font-plex-mono)' }}>
                    {result.contract.slice(0, 6)}…{result.contract.slice(-4)}
                  </span>
                )}
              </div>

              <LiquiditySafetyVerdictCard result={result} loading={false} error={null} />
            </div>
          )}

        </div>

        {/* ── Right: Extended LP Safety panel (420px) ───────────────── */}
        <aside className="lp-report" style={{
          width: '520px',
          flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: '#080c14',
          overflowY: 'auto',
          padding: '0',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {/* Idle */}
          {!loading && !result && (
            <div style={{ padding: '28px 16px' }}>
              <p style={{
                fontSize: '11px', color: '#1e3a44',
                fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6,
              }}>
                scan a token to see the extended LP safety report
              </p>
            </div>
          )}

          {/* Loading dots */}
          {loading && (
            <div style={{ padding: '28px 16px', display: 'flex', alignItems: 'center', gap: '5px' }}>
              {[0, 1, 2].map(i => (
                <span key={i} style={{
                  width: 5, height: 5, borderRadius: '50%', background: '#2DD4BF',
                  display: 'inline-block',
                  animation: `lp-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          )}

          {/* Extended box — flush to top, full width, scrollable */}
          {result && (
            <div className="lp-report-body" style={{ flex: 1, overflowY: 'auto' }}>
              <LPSafetyExtendedBox data={result} />
            </div>
          )}
        </aside>

      </div>
    </>
  )
}
