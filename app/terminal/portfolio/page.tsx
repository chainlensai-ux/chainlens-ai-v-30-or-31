'use client'

import { useState, useEffect } from 'react'

type Holding = {
  symbol: string
  name: string
  chain: string
  price: number
  balance: number
  value: number
  change24h: number
}

const MOCK_HOLDINGS: Holding[] = [
  { symbol: 'ETH',   name: 'Ethereum', chain: 'base', price: 3420.50,   balance: 0.85,    value: 2907.43, change24h:  2.34  },
  { symbol: 'BRETT', name: 'Brett',    chain: 'base', price: 0.1423,    balance: 14250,   value: 2027.78, change24h: -5.21  },
  { symbol: 'USDC',  name: 'USD Coin', chain: 'base', price: 1.00,      balance: 850,     value: 850.00,  change24h:  0.01  },
  { symbol: 'TOSHI', name: 'Toshi',    chain: 'base', price: 0.000891,  balance: 500000,  value: 445.50,  change24h: -2.18  },
  { symbol: 'BASED', name: 'Based',    chain: 'base', price: 0.00341,   balance: 120000,  value: 409.20,  change24h: 12.45  },
]

function fmtPrice(v: number): string {
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (v >= 1)    return `$${v.toFixed(2)}`
  if (v >= 0.001) return `$${v.toFixed(4)}`
  if (v >= 0.000001) return `$${v.toFixed(6)}`
  return `$${v.toExponential(2)}`
}

function fmtUSD(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtBalance(v: number): string {
  if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`
  if (v >= 1000)    return `${(v / 1000).toFixed(2)}K`
  return v.toFixed(v < 1 ? 4 : 2)
}

export default function PortfolioPage() {
  const [walletConnected, setWalletConnected] = useState(false)
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [clarkVerdict, setClarkVerdict] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkError, setClarkError] = useState<string | null>(null)

  const totalValue   = holdings.reduce((s, h) => s + h.value, 0)
  const totalPnL     = holdings.reduce((s, h) => s + h.value * (h.change24h / 100), 0)
  const pnlPositive  = totalPnL >= 0
  const chains       = [...new Set(holdings.map(h => h.chain))]

  async function analyzePortfolio(h: Holding[]) {
    setClarkLoading(true)
    setClarkVerdict(null)
    setClarkError(null)
    try {
      const prompt = `You are Clark, the AI analyst of ChainLens AI. Analyze this Base wallet portfolio and provide exactly four lines with no markdown, no bullet points, no headers — just plain text:

Line 1 — Trader personality type (e.g. "Degen Ape", "Cautious Accumulator", "Yield Farmer", "Meme Chaser")
Line 2 — Risk score: X/100 and one sentence reason
Line 3 — Biggest risk flag in this portfolio
Line 4 — One paragraph verdict on this portfolio

Portfolio:
${h.map(t => `${t.symbol} (${t.name}): $${t.value.toFixed(2)} value, ${t.change24h > 0 ? '+' : ''}${t.change24h.toFixed(2)}% 24h`).join('\n')}
Total portfolio value: ${fmtUSD(h.reduce((s, t) => s + t.value, 0))}`

      const res  = await fetch('/api/clark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'clark-ai', prompt }),
      })
      const json = await res.json()
      if (json.ok) {
        setClarkVerdict(json.data?.analysis ?? json.data?.response ?? 'No verdict returned.')
      } else {
        setClarkError(json.error ?? 'Clark analysis failed.')
      }
    } catch {
      setClarkError('Network error — Clark unavailable.')
    } finally {
      setClarkLoading(false)
    }
  }

  function handleConnect() {
    setWalletConnected(true)
    setHoldings(MOCK_HOLDINGS)
    analyzePortfolio(MOCK_HOLDINGS)
  }

  useEffect(() => {
    if (walletConnected && holdings.length > 0 && !clarkVerdict && !clarkLoading) {
      analyzePortfolio(holdings)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletConnected])

  return (
    <>
      <style>{`
        @keyframes port-dot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.75); }
          40%            { opacity: 1;   transform: scale(1);    }
        }
        .port-dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #2DD4BF; animation: port-dot 1.2s ease-in-out infinite; }
        .port-dot:nth-child(2) { animation-delay: 0.18s; }
        .port-dot:nth-child(3) { animation-delay: 0.36s; }
        @keyframes port-fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .port-row { animation: port-fade-in 0.3s ease-out both; }
        .port-row:hover { background: rgba(255,255,255,0.025) !important; }
        .port-connect-btn {
          background: rgba(45,212,191,0.10);
          border: 1px solid rgba(45,212,191,0.30);
          border-radius: 10px;
          color: #2DD4BF;
          font-size: 13px; font-weight: 700;
          padding: 12px 28px; cursor: pointer;
          font-family: var(--font-inter);
          letter-spacing: 0.04em;
          transition: background 150ms, border-color 150ms, box-shadow 150ms;
        }
        .port-connect-btn:hover {
          background: rgba(45,212,191,0.18);
          border-color: rgba(45,212,191,0.60);
          box-shadow: 0 0 20px rgba(45,212,191,0.25);
        }
      `}</style>

      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#06060a', color: '#e2e8f0', overflow: 'hidden' }}>

        {/* ── Top summary bar ───────────────────────────────────── */}
        <div style={{
          flexShrink: 0,
          background: '#080c14',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          padding: '16px 28px',
          display: 'flex',
          alignItems: 'center',
          gap: '32px',
          flexWrap: 'wrap',
        }}>
          {/* Label */}
          <div style={{ marginRight: '4px' }}>
            <div style={{
              fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em',
              color: '#2DD4BF', textTransform: 'uppercase',
              fontFamily: 'var(--font-plex-mono)', marginBottom: '4px',
            }}>Portfolio</div>
            <div style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-0.02em', color: '#f1f5f9', lineHeight: 1 }}>
              {walletConnected ? fmtUSD(totalValue) : '—'}
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: '1px', height: '36px', background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

          {/* 24h PnL */}
          <div>
            <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: '#3e5c78', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', marginBottom: '4px' }}>
              24h PnL
            </div>
            <div style={{
              fontSize: '16px', fontWeight: 700,
              color: walletConnected ? (pnlPositive ? '#2DD4BF' : '#f43f5e') : '#3e5c78',
              fontFamily: 'var(--font-plex-mono)',
            }}>
              {walletConnected
                ? `${pnlPositive ? '+' : ''}${fmtUSD(totalPnL)}`
                : '—'}
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: '1px', height: '36px', background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

          {/* Token count */}
          <div>
            <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: '#3e5c78', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', marginBottom: '4px' }}>
              Tokens
            </div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9', fontFamily: 'var(--font-plex-mono)' }}>
              {walletConnected ? holdings.length : '—'}
            </div>
          </div>

          {/* Chain pills */}
          {walletConnected && chains.length > 0 && (
            <>
              <div style={{ width: '1px', height: '36px', background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', color: '#3e5c78', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', marginBottom: '6px' }}>
                  Chains
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {chains.map(c => (
                    <span key={c} style={{
                      padding: '2px 10px', borderRadius: '99px',
                      fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
                      background: c === 'base' ? 'rgba(0,82,255,0.15)' : 'rgba(255,255,255,0.06)',
                      border: c === 'base' ? '1px solid rgba(0,82,255,0.35)' : '1px solid rgba(255,255,255,0.10)',
                      color: c === 'base' ? '#5b8fff' : '#94a3b8',
                      fontFamily: 'var(--font-plex-mono)',
                      textTransform: 'uppercase',
                    }}>
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Main content row ──────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>

          {/* ── Holdings table ────────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

            {/* Table header */}
            {walletConnected && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: '2fr 80px 120px 120px 120px 90px',
                padding: '10px 28px',
                borderBottom: '1px solid rgba(255,255,255,0.05)',
                flexShrink: 0,
              }}>
                {['Token', 'Chain', 'Price', 'Balance', 'Value', '24h'].map(col => (
                  <span key={col} style={{
                    fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em',
                    color: '#3e5c78', textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono)',
                  }}>{col}</span>
                ))}
              </div>
            )}

            {/* Rows or empty state */}
            {!walletConnected ? (
              <div style={{
                flex: 1, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: '20px',
                padding: '60px 28px',
              }}>
                {/* Icon */}
                <div style={{
                  width: '56px', height: '56px', borderRadius: '16px',
                  background: 'rgba(45,212,191,0.06)',
                  border: '1px solid rgba(45,212,191,0.18)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2DD4BF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
                    <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
                    <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
                  </svg>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#f1f5f9', marginBottom: '8px' }}>
                    Connect wallet to view portfolio
                  </div>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.30)', maxWidth: '300px', lineHeight: 1.6 }}>
                    Link your wallet to see holdings, PnL, and get a Clark AI portfolio analysis.
                  </div>
                </div>
                <button className="port-connect-btn" onClick={handleConnect}>
                  Connect Wallet
                </button>
              </div>
            ) : (
              <div style={{ flex: 1 }}>
                {holdings.map((h, i) => {
                  const pos = h.change24h >= 0
                  return (
                    <div
                      key={h.symbol}
                      className="port-row"
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 80px 120px 120px 120px 90px',
                        padding: '14px 28px',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        alignItems: 'center',
                        animationDelay: `${i * 0.05}s`,
                        background: 'transparent',
                        transition: 'background 150ms',
                      }}
                    >
                      {/* Token name + symbol */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 700, color: '#f1f5f9', fontFamily: 'var(--font-inter)' }}>
                          {h.symbol}
                        </span>
                        <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-inter)' }}>
                          {h.name}
                        </span>
                      </div>

                      {/* Chain badge */}
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: '99px',
                        fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em',
                        textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)',
                        background: 'rgba(0,82,255,0.12)',
                        border: '1px solid rgba(0,82,255,0.28)',
                        color: '#5b8fff',
                        alignSelf: 'center',
                      }}>
                        {h.chain}
                      </span>

                      {/* Price */}
                      <span style={{ fontSize: '12px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>
                        {fmtPrice(h.price)}
                      </span>

                      {/* Balance */}
                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--font-plex-mono)' }}>
                        {fmtBalance(h.balance)}
                      </span>

                      {/* USD value */}
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#f1f5f9', fontFamily: 'var(--font-plex-mono)' }}>
                        {fmtUSD(h.value)}
                      </span>

                      {/* 24h change */}
                      <span style={{
                        fontSize: '12px', fontWeight: 600, fontFamily: 'var(--font-plex-mono)',
                        color: pos ? '#2DD4BF' : '#f43f5e',
                      }}>
                        {pos ? '+' : ''}{h.change24h.toFixed(2)}%
                      </span>
                    </div>
                  )
                })}

                {/* Total row */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 80px 120px 120px 120px 90px',
                  padding: '14px 28px',
                  borderTop: '1px solid rgba(255,255,255,0.08)',
                  alignItems: 'center',
                  marginTop: '4px',
                }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.10em', color: '#3e5c78', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>
                    Total
                  </span>
                  <span />
                  <span />
                  <span />
                  <span style={{ fontSize: '13px', fontWeight: 800, color: '#f1f5f9', fontFamily: 'var(--font-plex-mono)' }}>
                    {fmtUSD(totalValue)}
                  </span>
                  <span style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', color: pnlPositive ? '#2DD4BF' : '#f43f5e' }}>
                    {pnlPositive ? '+' : ''}{((totalPnL / totalValue) * 100).toFixed(2)}%
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* ── Clark verdict panel ───────────────────────────────── */}
          <aside style={{
            width: '300px',
            flexShrink: 0,
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            background: '#080c14',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}>
            {/* Top accent */}
            <div style={{
              height: '1.5px', flexShrink: 0,
              background: 'linear-gradient(90deg, transparent, #2DD4BF 40%, #8b5cf6 70%, transparent)',
            }} />

            <div style={{ padding: '24px 20px', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {/* Label row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                  background: clarkLoading ? '#2DD4BF' : clarkVerdict ? '#2DD4BF' : '#1e3a44',
                  boxShadow: (clarkLoading || clarkVerdict) ? '0 0 8px rgba(45,212,191,0.80)' : 'none',
                  transition: 'all 0.3s',
                }} />
                <span style={{
                  fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                  color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)',
                  textTransform: 'uppercase',
                }}>
                  Clark Verdict
                </span>
              </div>

              {/* Idle — no wallet */}
              {!walletConnected && !clarkLoading && !clarkVerdict && (
                <p style={{ fontSize: '11px', color: '#1e3a44', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6, margin: 0 }}>
                  Connect your wallet and Clark will analyse your portfolio — personality type, risk score, biggest flag, and a full verdict.
                </p>
              )}

              {/* Loading dots */}
              {clarkLoading && (
                <div>
                  <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-plex-mono)', marginBottom: '10px', lineHeight: 1.5 }}>
                    Clark is analysing your portfolio…
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <span className="port-dot" />
                    <span className="port-dot" />
                    <span className="port-dot" />
                  </div>
                </div>
              )}

              {/* Error */}
              {clarkError && (
                <p style={{ fontSize: '12px', color: '#fca5a5', fontFamily: 'var(--font-plex-mono)', margin: 0, lineHeight: 1.6 }}>
                  {clarkError}
                </p>
              )}

              {/* Verdict */}
              {clarkVerdict && !clarkLoading && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {clarkVerdict.split('\n').filter(l => l.trim()).map((line, i) => {
                    const isFirstLine = i === 0
                    return (
                      <p key={i} style={{
                        fontSize: isFirstLine ? '13px' : '12px',
                        lineHeight: 1.75,
                        color: isFirstLine ? '#f1f5f9' : '#94a3b8',
                        fontFamily: 'var(--font-plex-mono)',
                        margin: 0,
                        fontWeight: isFirstLine ? 700 : 400,
                        paddingBottom: isFirstLine ? '10px' : 0,
                        borderBottom: isFirstLine ? '1px solid rgba(255,255,255,0.06)' : 'none',
                      }}>
                        {line}
                      </p>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{
              flexShrink: 0, padding: '12px 20px',
              borderTop: '1px solid rgba(255,255,255,0.05)',
              display: 'flex', alignItems: 'center', gap: '6px',
            }}>
              <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 5px rgba(45,212,191,0.65)', flexShrink: 0 }} />
              <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.20)', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.10em' }}>
                POWERED BY CORTEX ENGINE
              </span>
            </div>
          </aside>

        </div>
      </div>
    </>
  )
}
