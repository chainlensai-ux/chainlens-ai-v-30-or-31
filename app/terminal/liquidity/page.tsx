'use client'

import { useState } from 'react'
import Link from 'next/link'
import LiquiditySafetyVerdictCard, {
  type LiquiditySafetyResult,
} from '@/components/LiquiditySafetyVerdictCard'
import LPSafetyExtendedBox from '@/components/LPSafetyExtendedBox'

export default function LiquiditySafetyPage() {
  const [input, setInput]     = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState<LiquiditySafetyResult | null>(null)
  const [error, setError]     = useState<string | null>(null)

  async function handleScan() {
    const q = input.trim()
    if (!q || loading) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const isContract = /^0x[a-fA-F0-9]{40}$/.test(q)
      const body = isContract ? { contract: q } : { query: q }

      const res  = await fetch('/api/liquidity-safety', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      } as RequestInit)
      const json = await res.json()

      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Token not found on Base.')
      } else {
        setResult(json.data)
      }
    } catch {
      setError('Network error — check your connection.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        .lp-scan-btn:not(:disabled):hover { filter: brightness(1.08); transform: translateY(-1px); }
        .lp-scan-btn { transition: all 0.15s; }
        @keyframes lp-dot { 0%,80%,100%{opacity:.25;transform:scale(.75)} 40%{opacity:1;transform:scale(1)} }
      `}</style>

      {/* ── Two-column shell ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden', color: '#e2e8f0' }}>

        {/* ── Left: scrollable main content ─────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '40px 48px' }}>

          {/* Back button */}
          <Link href="/terminal" style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            color: 'rgba(255,255,255,0.35)', fontSize: '12px', fontWeight: 500,
            textDecoration: 'none', marginBottom: '24px',
            fontFamily: 'var(--font-inter, Inter, sans-serif)',
            transition: 'color 0.15s',
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.75)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.35)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </Link>

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
              Analyze on-chain liquidity depth, fragmentation, and stability risk for any Base token.
            </p>
          </div>

          {/* Search */}
          <div style={{
            background: '#080c14', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '14px', padding: '20px 24px', marginBottom: '28px', maxWidth: '680px',
          }}>
            <p style={{
              fontSize: '9px', fontWeight: 700, letterSpacing: '0.16em', color: '#3a5268',
              textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', marginBottom: '12px',
            }}>
              Token Address or Name
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
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
                  borderRadius: '10px', color: '#e2e8f0', fontSize: '13px',
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
        <aside style={{
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
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <LPSafetyExtendedBox data={result} />
            </div>
          )}
        </aside>

      </div>
    </>
  )
}
