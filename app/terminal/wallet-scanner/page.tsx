'use client'

import { useState } from 'react'
import Link from 'next/link'

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
  txCount: number
  firstTxDate: string | null
  walletAgeDays: number | null
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

function fmtAge(days: number | null): string {
  if (days === null) return '—'
  if (days < 30)     return `${days}d`
  if (days < 365)    return `${Math.floor(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}

function fmtPct(v: number | null): string {
  if (v === null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
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
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkVerdict, setClarkVerdict] = useState<string | null>(null)
  const [clarkError, setClarkError]     = useState<string | null>(null)

  async function handleScan() {
    const q = input.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    setResult(null)
    setClarkVerdict(null)
    setClarkError(null)

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

  async function triggerClark(address: string, data: WalletResult) {
    setClarkLoading(true)
    try {
      const sorted = [...data.holdings].sort((a, b) => b.value - a.value)
      const holdingLines = sorted.slice(0, 10).map(h =>
        `  - ${h.symbol} (${h.name}): balance=${fmtBalance(h.balance)}, value=${fmtUSD(h.value)}, 24h=${fmtPct(h.change24h)}, chain=${h.chain ?? 'unknown'}`
      ).join('\n')

      const prompt =
        `Scan this wallet and give me a personality read + risk verdict.\n\n` +
        `Wallet address: ${address}\n` +
        `Total portfolio value: ${fmtUSD(data.totalValue)}\n` +
        `Token count: ${data.holdings.length}\n` +
        `Transaction count (Ethereum nonce): ${data.txCount}\n` +
        `Wallet age: ${fmtAge(data.walletAgeDays)}` +
        (data.firstTxDate ? ` (first tx: ${new Date(data.firstTxDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })})` : '') + '\n\n' +
        `Top holdings:\n${holdingLines || '  none'}\n\n` +
        `Using only the wallet data above, give:\n` +
        `1. PERSONALITY TYPE — one punchy label (e.g. Diamond Hand Degen, Yield Farmer, NFT Flipper, Airdrop Hunter)\n` +
        `2. RISK SCORE — 1–10 with one sentence why\n` +
        `3. BIGGEST FLAG — top risk pattern you see\n` +
        `4. VERDICT — 2–3 lines, direct, Base-native tone`

      const clarkRes = await fetch('/api/clark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'clark-ai', prompt, walletAddress: address }),
      })
      const clarkJson = await clarkRes.json()
      const text = clarkJson.data?.analysis ?? clarkJson.data?.response ?? null
      if (text) {
        setClarkVerdict(text)
      } else {
        setClarkError(clarkJson.error ?? 'No verdict returned.')
      }
    } catch {
      setClarkError('Clark analysis failed.')
    } finally {
      setClarkLoading(false)
    }
  }

  const totalPnlPct = result && result.holdings.length > 0
    ? result.holdings.reduce((s, h) => s + (h.change24h ?? 0) * h.value, 0) /
      (result.totalValue || 1)
    : null

  return (
    <>
      <style>{`
        @keyframes clarkDot {
          0%,60%,100% { transform:translateY(0);  opacity:0.35; }
          30%          { transform:translateY(-5px); opacity:1; }
        }
        .ws-row:hover { background: rgba(255,255,255,0.025) !important; }
        .ws-scan-btn:hover:not(:disabled) {
          background: #25c0a8 !important;
          box-shadow: 0 0 24px rgba(45,212,191,0.40) !important;
        }
      `}</style>

      <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>

        {/* ── Left: scrollable main area ───────────────────────────────── */}
        <div className="mob-scan-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '40px 48px' }}>

          {/* Back */}
          <Link href="/terminal" style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            color: 'rgba(255,255,255,0.35)', fontSize: '12px', fontWeight: 500,
            textDecoration: 'none', marginBottom: '24px',
            fontFamily: 'var(--font-inter, Inter, sans-serif)', transition: 'color 0.15s',
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.75)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.35)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </Link>

          {/* Header */}
          <div style={{ marginBottom: '32px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.22)',
              borderRadius: '99px', padding: '4px 12px', marginBottom: '16px',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
              color: '#2DD4BF', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
            }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.80)',
                flexShrink: 0, animation: 'pulse-dot 2s infinite',
              }} />
              WALLET SCANNER
            </div>
            <h1 style={{
              fontSize: '26px', fontWeight: 700, color: '#f8fafc', lineHeight: 1.2,
              margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)',
            }}>
              Wallet Scanner{' '}
              <span style={{ color: '#2DD4BF' }}>Elite</span>
            </h1>
            <p style={{
              fontSize: '13px', color: 'rgba(255,255,255,0.38)', margin: '8px 0 0',
              fontFamily: 'var(--font-inter, Inter, sans-serif)',
            }}>
              Portfolio holdings, PnL, transaction history, and AI personality read.
            </p>
          </div>

          {/* Input */}
          <div style={{ display: 'flex', gap: '10px', maxWidth: '680px', marginBottom: '32px' }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
              disabled={loading}
              placeholder="0x… wallet address"
              spellCheck={false}
              style={{
                flex: 1, padding: '12px 16px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: '11px', color: '#e2e8f0',
                fontSize: '13px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                outline: 'none', transition: 'border-color 0.15s',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'rgba(45,212,191,0.45)')}
              onBlur={e  => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)')}
            />
            <button
              className="ws-scan-btn"
              onClick={handleScan}
              disabled={loading || !input.trim()}
              style={{
                padding: '12px 24px', borderRadius: '11px', border: 'none',
                background: (loading || !input.trim()) ? 'rgba(45,212,191,0.25)' : '#2DD4BF',
                color: (loading || !input.trim()) ? 'rgba(255,255,255,0.35)' : '#04101a',
                fontSize: '12px', fontWeight: 800,
                letterSpacing: '0.10em', textTransform: 'uppercase',
                cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                boxShadow: (!loading && input.trim()) ? '0 0 20px rgba(45,212,191,0.25)' : 'none',
                transition: 'background 0.15s, box-shadow 0.15s, color 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              {loading ? 'Scanning…' : 'Scan'}
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
            return (
            <div style={{ maxWidth: '680px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {/* Hero: portfolio value */}
              <div style={{
                background: 'linear-gradient(135deg, rgba(45,212,191,0.08) 0%, rgba(139,92,246,0.06) 100%)',
                border: '1px solid rgba(45,212,191,0.18)',
                borderRadius: '16px', padding: '24px 28px',
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
                  background: 'linear-gradient(90deg, #2DD4BF, #8b5cf6)',
                }} />
                <div style={{
                  fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                  color: 'rgba(45,212,191,0.70)', textTransform: 'uppercase',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  marginBottom: '10px',
                }}>
                  Portfolio Value
                </div>
                <div style={{
                  fontSize: '42px', fontWeight: 900, color: '#f1f5f9',
                  fontFamily: 'var(--font-inter, Inter, sans-serif)',
                  letterSpacing: '-0.02em', lineHeight: 1,
                  marginBottom: '10px',
                }}>
                  {fmtUSD(result.totalValue)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: '11px', color: 'rgba(255,255,255,0.35)',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  }}>
                    {shortAddr(result.address)}
                  </span>
                  {totalPnlPct !== null && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      padding: '3px 10px', borderRadius: '99px',
                      background: totalPnlPct >= 0 ? 'rgba(45,212,191,0.12)' : 'rgba(239,68,68,0.12)',
                      border: `1px solid ${totalPnlPct >= 0 ? 'rgba(45,212,191,0.30)' : 'rgba(239,68,68,0.30)'}`,
                      fontSize: '11px', fontWeight: 700,
                      color: totalPnlPct >= 0 ? '#2DD4BF' : '#ef4444',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    }}>
                      {totalPnlPct >= 0 ? '▲' : '▼'} {fmtPct(totalPnlPct)} 24h
                    </span>
                  )}
                </div>
              </div>

              {/* Stats row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                {[
                  {
                    label: 'Wallet Age',
                    value: fmtAge(result.walletAgeDays),
                    sub: result.firstTxDate
                      ? `First tx ${new Date(result.firstTxDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
                      : 'First tx unknown',
                    color: '#a78bfa',
                  },
                  {
                    label: 'Transactions',
                    value: result.txCount.toLocaleString(),
                    sub: `${sorted.length} token${sorted.length !== 1 ? 's' : ''} held`,
                    color: '#f59e0b',
                  },
                ].map(card => (
                  <div key={card.label} style={{
                    background: '#080c14',
                    border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: '12px', padding: '16px 18px',
                  }}>
                    <div style={{
                      fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em',
                      color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                      marginBottom: '8px',
                    }}>
                      {card.label}
                    </div>
                    <div style={{
                      fontSize: '26px', fontWeight: 800, color: card.color,
                      fontFamily: 'var(--font-inter, Inter, sans-serif)',
                      marginBottom: '4px', letterSpacing: '-0.01em',
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

              {/* Holdings table */}
              {sorted.length > 0 ? (
                <div style={{
                  background: '#080c14',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '14px', overflow: 'hidden',
                }}>
                  {/* Table header */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 100px 110px 88px',
                    padding: '10px 18px',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em',
                    color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  }}>
                    <span>Token</span>
                    <span style={{ textAlign: 'right' }}>Balance</span>
                    <span style={{ textAlign: 'right' }}>Value (USD)</span>
                    <span style={{ textAlign: 'right' }}>24h</span>
                  </div>

                  {/* Rows — already sorted by value desc */}
                  {sorted.map((h, i) => {
                    const up = (h.change24h ?? 0) >= 0
                    const chainLabel = h.chain
                      ? h.chain.replace(/-mainnet$/, '').replace(/-/, ' ')
                      : null
                    return (
                      <div
                        key={i}
                        className="ws-row"
                        style={{
                          display: 'grid', gridTemplateColumns: '1fr 100px 110px 88px',
                          padding: '11px 18px',
                          borderBottom: i < sorted.length - 1
                            ? '1px solid rgba(255,255,255,0.04)' : 'none',
                          transition: 'background 0.12s',
                        }}
                      >
                        {/* Token */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                          {h.icon ? (
                            <img src={h.icon} alt={h.symbol} width={28} height={28}
                              style={{ borderRadius: '50%', flexShrink: 0 }}
                              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                            />
                          ) : (
                            <div style={{
                              width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
                              background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: '9px', fontWeight: 800, color: '#04101a',
                            }}>
                              {h.symbol.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div style={{
                              fontSize: '13px', fontWeight: 600, color: '#f1f5f9',
                              fontFamily: 'var(--font-inter, Inter, sans-serif)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              marginBottom: '3px',
                            }}>
                              {h.symbol}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                              <span style={{
                                fontSize: '10px', color: 'rgba(255,255,255,0.30)',
                                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                maxWidth: '90px',
                              }}>
                                {h.name}
                              </span>
                              {chainLabel && (
                                <span style={{
                                  fontSize: '9px', fontWeight: 700, letterSpacing: '0.06em',
                                  padding: '1px 6px', borderRadius: '99px',
                                  background: chainLabel === 'base'
                                    ? 'rgba(0,82,255,0.15)'
                                    : chainLabel === 'ethereum'
                                      ? 'rgba(98,126,234,0.15)'
                                      : 'rgba(139,92,246,0.15)',
                                  border: chainLabel === 'base'
                                    ? '1px solid rgba(0,82,255,0.30)'
                                    : chainLabel === 'ethereum'
                                      ? '1px solid rgba(98,126,234,0.30)'
                                      : '1px solid rgba(139,92,246,0.30)',
                                  color: chainLabel === 'base'
                                    ? '#6ea8ff'
                                    : chainLabel === 'ethereum'
                                      ? '#a3b4f7'
                                      : '#c4b5fd',
                                  textTransform: 'uppercase',
                                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                                  flexShrink: 0,
                                }}>
                                  {chainLabel}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Balance */}
                        <div style={{
                          textAlign: 'right', fontSize: '12px', color: 'rgba(255,255,255,0.50)',
                          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          alignSelf: 'center',
                        }}>
                          {fmtBalance(h.balance)}
                        </div>

                        {/* Value */}
                        <div style={{
                          textAlign: 'right', fontSize: '13px', fontWeight: 600, color: '#e2e8f0',
                          fontFamily: 'var(--font-inter, Inter, sans-serif)',
                          alignSelf: 'center',
                        }}>
                          {fmtUSD(h.value)}
                        </div>

                        {/* 24h PnL */}
                        <div style={{
                          textAlign: 'right', fontSize: '12px', fontWeight: 600,
                          color: h.change24h === null ? 'rgba(255,255,255,0.20)'
                            : up ? '#2DD4BF' : '#ef4444',
                          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          alignSelf: 'center',
                        }}>
                          {fmtPct(h.change24h)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{
                  padding: '40px 24px', textAlign: 'center',
                  background: '#080c14', border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '14px', color: 'rgba(255,255,255,0.30)',
                  fontSize: '13px', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                }}>
                  No token holdings found for this wallet.
                </div>
              )}
            </div>
            )
          })()}
        </div>

        {/* ── Right: Clark verdict panel ───────────────────────────────── */}
        <aside className="mob-verdict-panel" style={{
          width: '288px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: '#080c14', overflowY: 'auto',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Accent line */}
          <div style={{
            height: '2px', flexShrink: 0,
            background: 'linear-gradient(90deg,#2DD4BF,#8b5cf6)',
            opacity: (clarkLoading || clarkVerdict) ? 1 : 0.2,
            transition: 'opacity 0.4s',
          }} />

          <div style={{ padding: '24px 20px', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Label */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: clarkLoading ? '#2DD4BF' : clarkVerdict ? '#2DD4BF' : '#1e3a44',
                boxShadow: (clarkLoading || clarkVerdict) ? '0 0 8px rgba(45,212,191,0.80)' : 'none',
                transition: 'background 0.3s, box-shadow 0.3s',
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>
                Clark AI Verdict
              </span>
            </div>

            {/* Idle */}
            {!result && !clarkLoading && !clarkVerdict && !clarkError && (
              <p style={{
                fontSize: '12px', color: 'rgba(255,255,255,0.25)', lineHeight: 1.65,
                fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0,
              }}>
                Scan a wallet and Clark will analyse the portfolio — personality read, risk flags, and a full verdict.
              </p>
            )}

            {/* Loading */}
            {clarkLoading && <ClarkDots />}

            {/* Error */}
            {clarkError && !clarkLoading && (
              <p style={{
                fontSize: '12px', color: '#fca5a5', lineHeight: 1.65,
                fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0,
              }}>
                {clarkError}
              </p>
            )}

            {/* Verdict */}
            {clarkVerdict && !clarkLoading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {clarkVerdict.split('\n').filter(l => l.trim()).map((line, i) => {
                  const isHeading = /^(#{1,3} |[A-Z][A-Z\s]{3,}:|[\d]+\.)/.test(line.trim())
                  return (
                    <p key={i} style={{
                      fontSize: isHeading ? '10px' : '12px',
                      fontWeight: isHeading ? 700 : 400,
                      color: isHeading ? '#2DD4BF' : 'rgba(255,255,255,0.75)',
                      lineHeight: 1.65, margin: 0,
                      letterSpacing: isHeading ? '0.10em' : 'normal',
                      textTransform: isHeading ? 'uppercase' : 'none',
                      fontFamily: isHeading
                        ? 'var(--font-plex-mono, IBM Plex Mono, monospace)'
                        : 'var(--font-inter, Inter, sans-serif)',
                    }}>
                      {line.replace(/^#{1,3} /, '')}
                    </p>
                  )
                })}
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}
