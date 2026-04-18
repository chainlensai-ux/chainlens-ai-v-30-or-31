'use client'

import { useState } from 'react'
import LiquiditySafetyVerdictCard, {
  type LiquiditySafetyResult,
} from '@/components/LiquiditySafetyVerdictCard'

// ─── Page ─────────────────────────────────────────────────────────────────────

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
        cache: 'no-store',
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
    <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>

      {/* ── Main scrollable area ─────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '40px 48px' }}>

        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.25)',
            borderRadius: '99px', padding: '4px 12px', marginBottom: '16px',
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
            color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.80)',
              flexShrink: 0,
            }} />
            LIQUIDITY SAFETY
          </div>
          <h1 style={{ fontSize: '26px', fontWeight: 700, color: '#f8fafc', lineHeight: 1.2, margin: 0 }}>
            Liquidity Safety{' '}
            <span style={{ color: '#2DD4BF' }}>Analyzer</span>
          </h1>
        </div>

        {/* Input row */}
        <div style={{ display: 'flex', gap: '10px', maxWidth: '680px', marginBottom: '28px' }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
            disabled={loading}
            placeholder="0x… or token name (brett, doginme, toshi…)"
            style={{
              flex: 1, padding: '12px 16px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '10px',
              color: '#e2e8f0', fontSize: '14px',
              fontFamily: 'var(--font-plex-mono)',
              outline: 'none',
              opacity: loading ? 0.6 : 1,
              transition: 'border-color 0.15s',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.45)' }}
            onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)' }}
          />
          <button
            onClick={handleScan}
            disabled={loading || !input.trim()}
            style={{
              padding: '12px 28px', borderRadius: '10px', border: 'none',
              background: loading || !input.trim()
                ? 'rgba(45,212,191,0.12)'
                : 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 100%)',
              color: loading || !input.trim() ? 'rgba(255,255,255,0.25)' : '#06060a',
              fontSize: '12px', fontWeight: 700,
              fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.10em',
              cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              flexShrink: 0, transition: 'all 0.15s',
            }}
          >
            {loading ? 'SCANNING…' : 'SCAN'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            maxWidth: '680px', padding: '13px 18px',
            background: 'rgba(248,113,113,0.07)',
            border: '1px solid rgba(248,113,113,0.22)',
            borderRadius: '10px', color: '#fca5a5',
            fontSize: '13px', fontFamily: 'var(--font-plex-mono)',
            marginBottom: '24px',
          }}>
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !result && !error && (
          <div style={{ maxWidth: '680px', padding: '48px 0', textAlign: 'center' }}>
            <p style={{
              fontFamily: 'var(--font-plex-mono)', fontSize: '12px',
              letterSpacing: '0.08em', color: '#1e2e38',
            }}>
              no token scanned yet
            </p>
          </div>
        )}

        {/* Result header */}
        {result && (
          <div style={{ marginBottom: '24px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc', margin: '0 0 4px' }}>
              {result.name}
              {result.symbol && (
                <span style={{
                  marginLeft: '10px', fontSize: '14px',
                  color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)',
                }}>
                  {result.symbol}
                </span>
              )}
            </h2>
            {result.contract && (
              <p style={{
                fontSize: '11px', color: '#3a5268',
                fontFamily: 'var(--font-plex-mono)', margin: 0,
              }}>
                {result.contract}
              </p>
            )}
          </div>
        )}

        {/* Verdict card */}
        <div style={{ maxWidth: '820px' }}>
          <LiquiditySafetyVerdictCard
            result={result}
            loading={loading}
            error={null}
          />
        </div>

      </div>
    </div>
  )
}
