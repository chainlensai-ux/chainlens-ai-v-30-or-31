'use client'

import { useState } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

type Holding = {
  name: string
  symbol: string
  icon: string | null
  chain: string | null
  balance: number
  value: number
  price: number | null
  change24h: number | null
  verified: boolean
}

type WalletResult = {
  address: string
  totalValue: number
  holdings: Holding[]
  txCount: number | null
  firstTxDate: string | null
  walletAgeDays: number | null
  providerUsed?: 'zerion' | 'goldrush' | 'none' | null
  providerStatus?: 'ok' | 'partial' | 'failed' | null
  holdingsCount?: number | null
  totalUsdAvailable?: boolean
  reason?: string | null
}

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function fmtBalance(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)     return `${(v / 1_000).toFixed(2)}K`
  if (v < 0.0001)     return v.toExponential(2)
  if (v < 1)          return v.toFixed(4)
  return v.toFixed(2)
}

function fmtPct(v: number | null): string {
  if (v === null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// ── Clark verdict parser ─────────────────────────────────────────────────────

type ClarkVerdictCard = {
  verdict: 'AVOID' | 'WATCH' | 'SCAN DEEPER' | 'TRUSTWORTHY' | 'UNKNOWN'
  confidence: 'Low' | 'Medium' | 'High'
  read: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

const FALLBACK_VERDICT: ClarkVerdictCard = {
  verdict: 'SCAN DEEPER',
  confidence: 'Low',
  read: 'Wallet balances loaded, but Clark could not complete the AI verdict right now.',
  keySignals: [
    'Wallet balances were retrieved',
    'Token holdings are visible',
    'Portfolio value is available if real',
  ],
  risks: [
    'AI verdict temporarily unavailable',
    'Transaction behavior not fully summarized',
    'Manual review recommended',
  ],
  nextAction: 'Review holdings now, then rerun Clark analysis in a moment.',
}

function extractSection(text: string, header: string): string {
  const m = text.match(new RegExp(`${header}\\s*:\\s*([\\s\\S]*?)(?:\\n(?:Asset|Verdict|Confidence|Read|Key signals|Risks|Next action)\\s*:|$)`, 'i'))
  return (m?.[1] ?? '').trim()
}

function parseStructuredClark(text: string): ClarkVerdictCard | null {
  const verdict = text.match(/\bVerdict:\s*(AVOID|WATCH|SCAN DEEPER|TRUSTWORTHY|UNKNOWN)\b/i)?.[1]?.toUpperCase() as ClarkVerdictCard['verdict'] | undefined
  const confidence = text.match(/\bConfidence:\s*(Low|Medium|High)\b/i)?.[1] as ClarkVerdictCard['confidence'] | undefined
  if (!verdict || !confidence) return null
  const read = extractSection(text, 'Read') || 'Not enough verified data to make a strong call.'
  const bulletify = (content: string, fallback: string[]) => {
    const rows = content
      .split(/\n|•|-/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3)
    return rows.length > 0 ? rows : fallback
  }
  return {
    verdict,
    confidence,
    read,
    keySignals: bulletify(extractSection(text, 'Key signals'), FALLBACK_VERDICT.keySignals),
    risks: bulletify(extractSection(text, 'Risks'), FALLBACK_VERDICT.risks),
    nextAction: extractSection(text, 'Next action') || FALLBACK_VERDICT.nextAction,
  }
}

// ── Loading dots ─────────────────────────────────────────────────────────────

function ClarkDots() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 0' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: '6px', height: '6px', borderRadius: '50%', background: '#2DD4BF',
          display: 'inline-block',
          animation: 'clarkDot 1.1s ease-in-out infinite',
          animationDelay: `${i * 0.18}s`,
        }} />
      ))}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function WalletScannerPage() {
  const [input, setInput]               = useState('')
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [result, setResult]             = useState<WalletResult | null>(null)
  const [clarkLoading, setClarkLoading]       = useState(false)
  const [clarkVerdict, setClarkVerdict]       = useState<ClarkVerdictCard | null>(null)
  const [showAllHoldings, setShowAllHoldings] = useState(false)

  async function handleScan() {
    const q = input.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    setResult(null)
    setClarkVerdict(null)
    setShowAllHoldings(false)

    try {
      const res  = await fetch('/api/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: q }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Scan failed')
      setResult(json)
      triggerClark(q, json)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setLoading(false)
    }
  }

  function dataQualityForWallet(data: WalletResult): 'Complete' | 'Partial' | 'Limited' {
    const hasHoldings = data.holdings.length > 0
    const hasValue = data.totalValue > 0
    const hasTxMeta = data.txCount !== null || data.firstTxDate !== null
    if (hasHoldings && hasValue && hasTxMeta) return 'Complete'
    if (hasHoldings || hasValue) return 'Partial'
    return 'Limited'
  }

  async function triggerClark(address: string, data: WalletResult) {
    setClarkLoading(true)
    try {
      const sorted = [...data.holdings].sort((a, b) => b.value - a.value)
      const topHoldings = sorted.slice(0, 10).map(h => ({
        symbol: h.symbol,
        name: h.name,
        balance: h.balance,
        valueUsd: h.value,
        change24h: h.change24h,
        chain: h.chain,
      }))
      const largest = sorted[0] ?? null
      const stablecoinExposureUsd = sorted
        .filter(h => /^(USDC|USDT|DAI|LUSD|USDE|USDBC)$/i.test(h.symbol))
        .reduce((acc, h) => acc + h.value, 0)
      const nativeEthBalance = sorted.find(h => /^ETH$/i.test(h.symbol))?.balance ?? null
      const notableActivity: string[] = []
      if (data.txCount !== null) notableActivity.push(`Transaction count observed: ${data.txCount}`)
      if (data.firstTxDate) notableActivity.push(`First seen activity: ${new Date(data.firstTxDate).toISOString().slice(0, 10)}`)
      const payload = {
        feature: 'clark-ai',
        mode: 'wallet-analysis',
        message: 'Analyze this wallet summary',
        prompt: 'Analyze this wallet summary',
        walletAddress: address,
        context: {
          walletAddress: address,
          portfolioValueUsd: data.totalValue,
          tokenCount: data.holdings.length,
          topHoldings,
          largestHolding: largest ? { symbol: largest.symbol, name: largest.name, valueUsd: largest.value } : null,
          stablecoinExposureUsd,
          nativeEthBalance,
          dataQuality: dataQualityForWallet(data),
          warnings: [],
          transactionCount: data.txCount,
          latestActivityAt: null,
          notableActivity: notableActivity.slice(0, 5),
        },
      }

      const clarkRes = await fetch('/api/clark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const clarkJson = await clarkRes.json()
      const text = clarkJson?.data?.reply ?? clarkJson?.data?.analysis ?? clarkJson?.data?.response ?? null
      const parsed = typeof text === 'string' ? parseStructuredClark(text) : null
      setClarkVerdict(parsed ?? FALLBACK_VERDICT)
    } catch {
      setClarkVerdict(FALLBACK_VERDICT)
    } finally {
      setClarkLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes clarkDot {
          0%,60%,100% { transform:translateY(0);  opacity:0.35; }
          30%          { transform:translateY(-5px); opacity:1; }
        }
        @keyframes clarkPulse {
          0%,100% { opacity:1; box-shadow:0 0 6px rgba(45,212,191,0.70); }
          50%      { opacity:0.4; box-shadow:0 0 2px rgba(45,212,191,0.20); }
        }
        .ws-row:hover { background: rgba(255,255,255,0.025) !important; }
        .ws-scan-btn:hover:not(:disabled) {
          background: #25c0a8 !important;
          box-shadow: 0 0 24px rgba(45,212,191,0.40) !important;
        }
        @media (max-width: 768px) {
          .wallet-main { padding: 20px 14px 120px !important; }
          .wallet-input-row { flex-direction: column; max-width: 100% !important; }
          .wallet-input-row button { width: 100%; justify-content: center; }
        }
      `}</style>

      <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>

        {/* ── Left: scrollable main area ───────────────────────────────── */}
        <div className="mob-scan-main wallet-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '40px 48px 120px' }}>

          {/* Header */}
          <div style={{ marginBottom: '32px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
              <h1 style={{
                fontSize: '30px', fontWeight: 800, color: '#f8fafc', lineHeight: 1.1,
                margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)',
                letterSpacing: '-0.02em',
              }}>
                Wallet Scanner
              </h1>
              <span style={{
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em',
                padding: '4px 12px', borderRadius: '99px',
                background: 'rgba(139,92,246,0.18)',
                border: '1px solid rgba(139,92,246,0.40)',
                color: '#c4b5fd',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                textTransform: 'uppercase', flexShrink: 0,
              }}>
                Elite
              </span>
            </div>
            <p style={{
              fontSize: '14px', color: '#94a3b8', margin: 0,
              fontFamily: 'var(--font-inter, Inter, sans-serif)',
            }}>
              Advanced on-chain intelligence and AI-powered wallet analysis
            </p>
          </div>

          {/* Input */}
          <div className="wallet-input-row" style={{ display: 'flex', gap: '10px', maxWidth: '680px', marginBottom: '32px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              {/* Paste icon */}
              <button
                onClick={() => navigator.clipboard.readText().then(t => setInput(t)).catch(() => {})}
                title="Paste from clipboard"
                style={{
                  position: 'absolute', left: '13px', top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', padding: '0', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.32)',
                  transition: 'color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = '#2DD4BF')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.32)')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="4" rx="1"/>
                  <rect x="4" y="6" width="16" height="16" rx="2"/>
                  <path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/>
                </svg>
              </button>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
                disabled={loading}
                placeholder="0x… wallet address"
                spellCheck={false}
                style={{
                  width: '100%', padding: '13px 16px 13px 40px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  borderRadius: '11px', color: '#e2e8f0',
                  fontSize: '13px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'rgba(45,212,191,0.45)')}
                onBlur={e  => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)')}
              />
            </div>
            <button
              className="ws-scan-btn"
              onClick={handleScan}
              disabled={loading || !input.trim()}
              style={{
                padding: '13px 22px', borderRadius: '11px', border: 'none',
                background: (loading || !input.trim()) ? 'rgba(45,212,191,0.25)' : '#2DD4BF',
                color: (loading || !input.trim()) ? 'rgba(255,255,255,0.35)' : '#04101a',
                fontSize: '12px', fontWeight: 800,
                letterSpacing: '0.10em', textTransform: 'uppercase',
                cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                boxShadow: (!loading && input.trim()) ? '0 0 20px rgba(45,212,191,0.25)' : 'none',
                transition: 'background 0.15s, box-shadow 0.15s, color 0.15s',
                whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              {loading ? 'Scanning…' : (
                <>
                  Scan
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6"/>
                  </svg>
                </>
              )}
            </button>
          </div>

          {/* Loading skeleton */}
          {loading && (
            <div style={{ maxWidth: '680px' }}>
              {[180, 80, 120, 100, 110, 90].map((w, i) => (
                <div key={i} style={{
                  height: '14px', borderRadius: '6px', marginBottom: '14px',
                  width: `${w + i * 20}px`,
                  background: 'linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.05) 75%)',
                  backgroundSize: '200% 100%',
                  animation: 'shimmer 1.5s infinite',
                }} />
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: '8px',
              padding: '12px 14px', borderRadius: '10px', maxWidth: '680px',
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.20)',
              color: '#fca5a5', fontSize: '13px', lineHeight: 1.5,
              fontFamily: 'var(--font-inter, Inter, sans-serif)',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: '1px' }}>
                <circle cx="12" cy="12" r="10" stroke="#fca5a5" strokeWidth="2"/>
                <path d="M12 8v4M12 16h.01" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              {error}
            </div>
          )}

          {/* Results */}
          {result && !loading && (() => {
            const sorted = [...result.holdings].sort((a, b) => b.value - a.value)
            const largest = sorted[0] ?? null
            const quality = dataQualityForWallet(result)
            return (
            <div style={{ maxWidth: '720px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {/* Portfolio value card */}
              <div style={{
                background: '#080c14',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '18px',
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
                  background: 'linear-gradient(90deg, #2DD4BF 0%, #8b5cf6 100%)',
                }} />
                <div style={{ padding: '28px 32px' }}>
                  <div style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                    color: '#2DD4BF', textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    marginBottom: '10px',
                  }}>
                    Portfolio Value
                  </div>
                  <div style={{
                    fontSize: '52px', fontWeight: 900, color: '#f1f5f9',
                    fontFamily: 'var(--font-inter, Inter, sans-serif)',
                    letterSpacing: '-0.03em', lineHeight: 1,
                    marginBottom: '14px',
                  }}>
                    {result.totalValue > 0 ? fmtUSD(result.totalValue) : result.holdings.length > 0 ? 'Value unavailable' : 'Unavailable'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{
                      fontSize: '12px', color: 'rgba(255,255,255,0.32)',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    }}>
                      {shortAddr(result.address)}
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                {[
                  { label: 'Portfolio Value', value: result.totalValue > 0 ? fmtUSD(result.totalValue) : result.holdings.length > 0 ? 'Value unavailable' : 'Unavailable', sub: result.providerUsed && result.providerUsed !== 'none' ? `Via ${result.providerUsed}` : 'From wallet balances', color: '#2DD4BF' },
                  { label: 'Token Count', value: sorted.length.toLocaleString(), sub: 'Visible token balances', color: '#a78bfa' },
                  { label: 'Largest Holding', value: largest ? largest.symbol : 'Unavailable', sub: largest ? fmtUSD(largest.value) : 'No holdings found', color: '#fbbf24' },
                  { label: 'Data Quality', value: quality, sub: 'Complete / Partial / Limited', color: quality === 'Complete' ? '#2DD4BF' : quality === 'Partial' ? '#fbbf24' : '#f87171' },
                ].map(card => (
                  <div key={card.label} style={{
                    background: '#080c14',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '14px', padding: '18px 20px',
                  }}>
                    <div style={{
                      fontSize: '10px', fontWeight: 700, letterSpacing: '0.13em',
                      color: 'rgba(255,255,255,0.32)', textTransform: 'uppercase',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                      marginBottom: '8px',
                    }}>
                      {card.label}
                    </div>
                    <div style={{
                      fontSize: '24px', fontWeight: 800, color: card.color,
                      fontFamily: 'var(--font-inter, Inter, sans-serif)',
                      marginBottom: '5px', letterSpacing: '-0.01em', lineHeight: 1.1,
                    }}>
                      {card.value}
                    </div>
                    <div style={{
                      fontSize: '11px', color: 'rgba(255,255,255,0.25)',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    }}>
                      {card.sub}
                    </div>
                  </div>
                ))}
              </div>

              {sorted.length > 0 ? (() => {
                const PREVIEW = 10
                const visible = showAllHoldings ? sorted : sorted.slice(0, PREVIEW)
                const hidden  = sorted.length - PREVIEW
                return (
                  <div style={{
                    background: '#080c14',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '16px', overflow: 'hidden',
                  }}>
                    {/* Table header */}
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 110px 120px 88px',
                      padding: '12px 20px',
                      borderBottom: '1px solid rgba(255,255,255,0.06)',
                      fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                      color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    }}>
                      <span>Token</span>
                      <span style={{ textAlign: 'right' }}>Balance</span>
                      <span style={{ textAlign: 'right' }}>Value USD</span>
                      <span style={{ textAlign: 'right' }}>24h</span>
                    </div>

                    {/* Rows */}
                    {visible.map((h, i) => {
                      const up = (h.change24h ?? 0) >= 0
                      const chainLabel = h.chain
                        ? h.chain.replace(/-mainnet$/, '').replace(/-/g, ' ')
                        : null
                      const isLast = i === visible.length - 1 && (showAllHoldings || sorted.length <= PREVIEW)
                      return (
                        <div
                          key={i}
                          className="ws-row"
                          style={{
                            display: 'grid', gridTemplateColumns: '1fr 110px 120px 88px',
                            padding: '14px 20px',
                            borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.04)',
                            alignItems: 'center',
                            transition: 'background 0.12s',
                          }}
                        >
                          {/* Token col */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '11px', minWidth: 0 }}>
                            {/* Logo */}
                            {h.icon ? (
                              <img src={h.icon} alt={h.symbol} width={34} height={34}
                                style={{ borderRadius: '50%', flexShrink: 0 }}
                                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                              />
                            ) : (
                              <div style={{
                                width: '34px', height: '34px', borderRadius: '50%', flexShrink: 0,
                                background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '11px', fontWeight: 800, color: '#04101a',
                              }}>
                                {h.symbol.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                            {/* Name + chain pill */}
                            <div style={{ minWidth: 0 }}>
                              <div style={{
                                fontSize: '14px', fontWeight: 600, color: '#f1f5f9',
                                fontFamily: 'var(--font-inter, Inter, sans-serif)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                marginBottom: '3px',
                              }}>
                                {h.symbol}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <span style={{
                                  fontSize: '11px', color: 'rgba(255,255,255,0.28)',
                                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  maxWidth: '80px',
                                }}>
                                  {h.name}
                                </span>
                                {chainLabel && (
                                  <span style={{
                                    fontSize: '9px', fontWeight: 700, letterSpacing: '0.07em',
                                    padding: '2px 6px', borderRadius: '99px', flexShrink: 0,
                                    background: chainLabel === 'base'
                                      ? 'rgba(0,82,255,0.14)'
                                      : chainLabel === 'ethereum'
                                        ? 'rgba(98,126,234,0.14)'
                                        : 'rgba(139,92,246,0.14)',
                                    border: chainLabel === 'base'
                                      ? '1px solid rgba(0,82,255,0.28)'
                                      : chainLabel === 'ethereum'
                                        ? '1px solid rgba(98,126,234,0.28)'
                                        : '1px solid rgba(139,92,246,0.28)',
                                    color: chainLabel === 'base'
                                      ? '#6ea8ff'
                                      : chainLabel === 'ethereum'
                                        ? '#a3b4f7'
                                        : '#c4b5fd',
                                    textTransform: 'uppercase',
                                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                                  }}>
                                    {chainLabel}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Balance */}
                          <div style={{
                            textAlign: 'right', fontSize: '13px', color: 'rgba(255,255,255,0.50)',
                            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          }}>
                            {fmtBalance(h.balance)}
                          </div>

                          {/* Value */}
                          <div style={{
                            textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#e2e8f0',
                            fontFamily: 'var(--font-inter, Inter, sans-serif)',
                          }}>
                            {fmtUSD(h.value)}
                          </div>

                          {/* 24h */}
                          <div style={{
                            textAlign: 'right', fontSize: '13px', fontWeight: 600,
                            color: h.change24h === null
                              ? 'rgba(255,255,255,0.18)'
                              : up ? '#2DD4BF' : '#ef4444',
                            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          }}>
                            {fmtPct(h.change24h)}
                          </div>
                        </div>
                      )
                    })}

                    {/* Expand / collapse button */}
                    {sorted.length > PREVIEW && (
                      <button
                        onClick={() => setShowAllHoldings(v => !v)}
                        style={{
                          width: '100%', padding: '13px 20px',
                          background: 'none',
                          border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)',
                          cursor: 'pointer', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', gap: '6px',
                          fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em',
                          color: 'rgba(255,255,255,0.40)',
                          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          transition: 'color 0.15s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#2DD4BF')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.40)')}
                      >
                        {showAllHoldings ? (
                          <>
                            Show less
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 15l-6-6-6 6"/>
                            </svg>
                          </>
                        ) : (
                          <>
                            View all tokens ({hidden} more)
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M6 9l6 6 6-6"/>
                            </svg>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )
              })() : (
                <div style={{
                  padding: '40px 24px', textAlign: 'center',
                  background: '#080c14', border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '14px', color: 'rgba(255,255,255,0.30)',
                  fontSize: '13px', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                }}>
                  {result.reason
                    ? result.reason
                    : 'No token balances found for this wallet.'}
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.18)', marginTop: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    {result.providerUsed && result.providerUsed !== 'none' ? `Checked via ${result.providerUsed}` : 'All data providers checked'} · Try a different wallet or check back later
                  </div>
                </div>
              )}
            </div>
            )
          })()}
        </div>

        {/* ── Right: Clark verdict panel ───────────────────────────────── */}
        <aside className="mob-verdict-panel" style={{
          width: '380px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: '#080c14',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Top gradient accent */}
          <div style={{
            height: '2px', flexShrink: 0,
            background: 'linear-gradient(90deg, #2DD4BF, #8b5cf6)',
            opacity: (clarkLoading || clarkVerdict) ? 1 : 0.18,
            transition: 'opacity 0.4s',
          }} />

          {/* Header */}
          <div style={{
            padding: '20px 24px 16px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: result ? '10px' : 0 }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                background: (clarkLoading || clarkVerdict) ? '#2DD4BF' : 'rgba(45,212,191,0.22)',
                boxShadow: (clarkLoading || clarkVerdict) ? '0 0 8px rgba(45,212,191,0.70)' : 'none',
                animation: clarkLoading ? 'clarkPulse 1.2s ease-in-out infinite' : 'none',
                transition: 'background 0.3s, box-shadow 0.3s',
              }} />
              <span style={{
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.18em',
                color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>
                Clark AI Verdict
              </span>
            </div>
            {result && (
              <div style={{
                fontSize: '11px', color: 'rgba(255,255,255,0.28)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {result.address.slice(0, 10)}…{result.address.slice(-8)}
              </div>
            )}
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* Idle */}
            {!result && !clarkLoading && !clarkVerdict && (
              <p style={{
                fontSize: '13px', color: 'rgba(255,255,255,0.22)', lineHeight: 1.7,
                fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0,
              }}>
                Scan a wallet and Clark will return a structured verdict with key signals and risks.
              </p>
            )}

            {/* Loading */}
            {clarkLoading && <ClarkDots />}

            {/* Structured verdict */}
            {clarkVerdict && !clarkLoading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '12px', padding: '14px 16px',
                }}>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: '#2DD4BF', letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      {clarkVerdict.verdict}
                    </span>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: '#fbbf24', letterSpacing: '0.10em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      {clarkVerdict.confidence} confidence
                    </span>
                  </div>

                  <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', margin: '0 0 6px' }}>Read</p>
                  <p style={{ fontSize: '13px', color: '#ffffff', lineHeight: 1.6, margin: '0 0 12px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                    {clarkVerdict.read}
                  </p>

                  <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', margin: '0 0 6px' }}>Key signals</p>
                  {clarkVerdict.keySignals.slice(0, 3).map((line, i) => (
                    <p key={`s-${i}`} style={{ fontSize: '12px', color: '#cbd5e1', margin: '0 0 4px' }}>- {line}</p>
                  ))}

                  <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', margin: '12px 0 6px' }}>Risks</p>
                  {clarkVerdict.risks.slice(0, 3).map((line, i) => (
                    <p key={`r-${i}`} style={{ fontSize: '12px', color: '#fca5a5', margin: '0 0 4px' }}>- {line}</p>
                  ))}

                  <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', margin: '12px 0 6px' }}>Next action</p>
                  <p style={{ fontSize: '12px', color: '#94a3b8', margin: 0 }}>{clarkVerdict.nextAction}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{
            flexShrink: 0, padding: '12px 24px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            fontSize: '10px', color: 'rgba(255,255,255,0.20)',
            letterSpacing: '0.05em', lineHeight: 1.5,
            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          }}>
            Powered by CORTEX — Real-time onchain analysis
          </div>
        </aside>
      </div>
    </>
  )
}
