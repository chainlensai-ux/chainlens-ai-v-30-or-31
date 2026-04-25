'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────

type RiskLevel = 'DANGER' | 'CAUTION' | 'SAFE'

interface HoneypotResult {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  simulationSuccess: boolean
}

interface RadarToken {
  name: string
  symbol: string
  contract: string
  ageMinutes: number
  liquidityUsd: number
  volume24h: number
  riskLevel: RiskLevel
  honeypot: HoneypotResult | null
  clarkVerdict: string | null
}

interface RadarStats {
  totalNewTokens: number
  averageLiquidity: number
  mostCommonRisk: RiskLevel
  dangerCount: number
  cautionCount: number
  safeCount: number
}

interface RadarData {
  tokens: RadarToken[]
  stats: RadarStats
  fetchedAt: string
}

// ─── Formatters ───────────────────────────────────────────────────────────

function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ─── Risk helpers ─────────────────────────────────────────────────────────

const RISK_COLOR: Record<RiskLevel, string> = {
  DANGER:  '#f87171',
  CAUTION: '#fbbf24',
  SAFE:    '#2DD4BF',
}

const RISK_BG: Record<RiskLevel, string> = {
  DANGER:  'rgba(248,113,113,0.12)',
  CAUTION: 'rgba(251,191,36,0.12)',
  SAFE:    'rgba(45,212,191,0.10)',
}

const RISK_BORDER: Record<RiskLevel, string> = {
  DANGER:  'rgba(248,113,113,0.30)',
  CAUTION: 'rgba(251,191,36,0.28)',
  SAFE:    'rgba(45,212,191,0.25)',
}

// ─── Token Card ───────────────────────────────────────────────────────────

function TokenCard({ token, index, onClick }: {
  token: RadarToken
  index: number
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const riskColor  = RISK_COLOR[token.riskLevel]
  const riskBg     = RISK_BG[token.riskLevel]
  const riskBorder = RISK_BORDER[token.riskLevel]

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background:    hovered ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)',
        border:        `1px solid ${hovered ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)'}`,
        borderRadius:  '14px',
        padding:       '18px 20px',
        cursor:        'pointer',
        transition:    'background 0.15s, border-color 0.15s',
        animation:     `radarSlideIn 0.35s ease both`,
        animationDelay: `${index * 60}ms`,
        position:      'relative',
        overflow:      'hidden',
      }}
    >
      {/* Risk accent bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        height: '2px',
        background: riskColor,
        opacity: 0.6,
      }} />

      {/* Top row: name + age + risk */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span style={{
            fontSize: '15px', fontWeight: 700, color: '#f1f5f9',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {token.name}
          </span>
          <span style={{
            fontSize: '11px', fontWeight: 600, color: '#64748b',
            fontFamily: 'var(--font-plex-mono)',
          }}>
            {token.symbol}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
          {/* Age pill */}
          <span style={{
            padding: '3px 9px', borderRadius: '99px',
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
            color: '#94a3b8', background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.08)',
            fontFamily: 'var(--font-plex-mono)',
          }}>
            {fmtAge(token.ageMinutes)}
          </span>

          {/* Risk pill */}
          <span style={{
            padding: '3px 10px', borderRadius: '99px',
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em',
            color: riskColor, background: riskBg,
            border: `1px solid ${riskBorder}`,
            fontFamily: 'var(--font-plex-mono)',
          }}>
            {token.riskLevel}
          </span>
        </div>
      </div>

      {/* Contract address */}
      <div style={{
        fontSize: '11px', color: '#3a5268',
        fontFamily: 'var(--font-plex-mono)',
        marginBottom: '12px',
      }}>
        {shortAddr(token.contract)}
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: '20px', marginBottom: token.honeypot || token.clarkVerdict ? '12px' : '0' }}>
        <div>
          <p style={{
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#3a5268',
            textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 3px',
          }}>Liquidity</p>
          <p style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>
            {fmtUSD(token.liquidityUsd)}
          </p>
        </div>
        <div>
          <p style={{
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#3a5268',
            textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 3px',
          }}>Vol 24h</p>
          <p style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>
            {fmtUSD(token.volume24h)}
          </p>
        </div>

        {/* Honeypot tax pills */}
        {token.honeypot?.simulationSuccess && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '5px' }}>
            {token.honeypot.buyTax !== null && (
              <span style={{
                padding: '3px 8px', borderRadius: '99px', fontSize: '9px', fontWeight: 700,
                fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em',
                color: (token.honeypot.buyTax ?? 0) > 5 ? '#fbbf24' : '#2DD4BF',
                background: (token.honeypot.buyTax ?? 0) > 5 ? 'rgba(251,191,36,0.10)' : 'rgba(45,212,191,0.08)',
                border: `1px solid ${(token.honeypot.buyTax ?? 0) > 5 ? 'rgba(251,191,36,0.25)' : 'rgba(45,212,191,0.20)'}`,
              }}>
                BUY {token.honeypot.buyTax.toFixed(1)}%
              </span>
            )}
            {token.honeypot.sellTax !== null && (
              <span style={{
                padding: '3px 8px', borderRadius: '99px', fontSize: '9px', fontWeight: 700,
                fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em',
                color: (token.honeypot.sellTax ?? 0) > 5 ? '#fbbf24' : '#2DD4BF',
                background: (token.honeypot.sellTax ?? 0) > 5 ? 'rgba(251,191,36,0.10)' : 'rgba(45,212,191,0.08)',
                border: `1px solid ${(token.honeypot.sellTax ?? 0) > 5 ? 'rgba(251,191,36,0.25)' : 'rgba(45,212,191,0.20)'}`,
              }}>
                SELL {token.honeypot.sellTax.toFixed(1)}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* Clark verdict */}
      {token.clarkVerdict && (
        <p style={{
          fontSize: '11px', fontStyle: 'italic', color: '#64748b',
          margin: 0, lineHeight: 1.5,
          borderTop: '1px solid rgba(255,255,255,0.05)',
          paddingTop: '10px',
        }}>
          "{token.clarkVerdict}"
        </p>
      )}
    </div>
  )
}

// ─── Stats Panel ──────────────────────────────────────────────────────────

function StatsPanel({ stats, fetchedAt, loading }: {
  stats: RadarStats | null
  fetchedAt: string | null
  loading: boolean
}) {
  const riskColor = stats ? RISK_COLOR[stats.mostCommonRisk] : '#94a3b8'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

      <div style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '14px',
        padding: '20px',
      }}>
        <p style={{
          fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268',
          textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)',
          margin: '0 0 16px',
        }}>
          Radar Stats
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <Stat label="New Tokens (24h)" value={stats ? String(stats.totalNewTokens) : '—'} loading={loading} />
          <Stat label="Avg Liquidity"    value={stats ? fmtUSD(stats.averageLiquidity) : '—'} loading={loading} />
          <div>
            <p style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', color: '#3a5268',
              textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 6px',
            }}>
              Most Common Risk
            </p>
            <span style={{
              display: 'inline-block',
              padding: '4px 12px', borderRadius: '99px',
              fontSize: '11px', fontWeight: 700, letterSpacing: '0.10em',
              color: riskColor,
              background: stats ? RISK_BG[stats.mostCommonRisk] : 'transparent',
              border: `1px solid ${stats ? RISK_BORDER[stats.mostCommonRisk] : 'transparent'}`,
              fontFamily: 'var(--font-plex-mono)',
            }}>
              {stats?.mostCommonRisk ?? '—'}
            </span>
          </div>
        </div>
      </div>

      {/* Risk breakdown */}
      <div style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '14px',
        padding: '20px',
      }}>
        <p style={{
          fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268',
          textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)',
          margin: '0 0 14px',
        }}>
          Risk Breakdown
        </p>

        {(['SAFE', 'CAUTION', 'DANGER'] as RiskLevel[]).map(level => {
          const count = stats
            ? (level === 'SAFE' ? stats.safeCount : level === 'CAUTION' ? stats.cautionCount : stats.dangerCount)
            : 0
          const total = stats ? stats.safeCount + stats.cautionCount + stats.dangerCount : 1
          const pct   = total > 0 ? Math.round((count / total) * 100) : 0
          return (
            <div key={level} style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                <span style={{
                  fontSize: '10px', fontWeight: 700, color: RISK_COLOR[level],
                  fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.10em',
                }}>
                  {level}
                </span>
                <span style={{
                  fontSize: '10px', fontWeight: 600, color: '#64748b',
                  fontFamily: 'var(--font-plex-mono)',
                }}>
                  {stats ? count : '—'}
                </span>
              </div>
              <div style={{
                height: '4px', borderRadius: '99px',
                background: 'rgba(255,255,255,0.06)',
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: '99px',
                  background: RISK_COLOR[level],
                  width: `${pct}%`,
                  opacity: 0.7,
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* Last updated */}
      {fetchedAt && (
        <p style={{
          fontSize: '10px', color: '#3a5268', textAlign: 'center',
          fontFamily: 'var(--font-plex-mono)',
          margin: 0,
        }}>
          Updated {new Date(fetchedAt).toLocaleTimeString()}
        </p>
      )}

      <div style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '14px',
        padding: '16px 20px',
      }}>
        <p style={{
          fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268',
          textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)',
          margin: '0 0 10px',
        }}>
          Data Sources
        </p>
        {['GeckoTerminal (pools)', 'Honeypot.is (security)', 'Clark AI (verdicts)'].map(src => (
          <div key={src} style={{
            display: 'flex', alignItems: 'center', gap: '7px',
            fontSize: '11px', color: '#64748b',
            marginBottom: '6px',
            fontFamily: 'var(--font-plex-mono)',
          }}>
            <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', flexShrink: 0 }} />
            {src}
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', color: '#3a5268',
        textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 5px',
      }}>
        {label}
      </p>
      <p style={{
        fontSize: '18px', fontWeight: 700, color: loading ? '#3a5268' : '#e2e8f0',
        fontFamily: 'var(--font-plex-mono)', margin: 0,
        transition: 'color 0.3s',
      }}>
        {value}
      </p>
    </div>
  )
}

// ─── Empty state ─────────────────────────────────────────────────────────

function EmptyFeed() {
  return (
    <div style={{
      textAlign: 'center', padding: '60px 20px',
      color: '#3a5268', fontFamily: 'var(--font-plex-mono)',
    }}>
      <div style={{ fontSize: '32px', marginBottom: '16px', opacity: 0.4 }}>◈</div>
      <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px' }}>
        No new tokens detected in the last 2 hours
      </p>
      <p style={{ fontSize: '11px', margin: 0 }}>
        Radar scans for Base tokens with &gt;$1K liquidity — check back soon
      </p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function BaseRadarPage() {
  const router = useRouter()
  const [data,      setData]      = useState<RadarData | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [countdown, setCountdown] = useState(60)
  const [refreshKey, setRefreshKey] = useState(0)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch('/api/radar', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || json.error) {
        setError(json.error ?? 'Radar unavailable')
      } else {
        setData(json as RadarData)
      }
    } catch {
      setError('Network error — check your connection')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => { fetchData() }, [fetchData])

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { setRefreshKey(k => k + 1); return 60 }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (refreshKey > 0) { fetchData(); setCountdown(60) }
  }, [refreshKey, fetchData])

  function handleManualRefresh() {
    setCountdown(60)
    fetchData()
  }

  function openToken(contract: string) {
    router.push(`/terminal/token-scanner?contract=${contract}`)
  }

  const tokens = data?.tokens ?? []
  const stats  = data?.stats  ?? null

  return (
    <>
      <style>{`
        @keyframes radarSlideIn {
          from { opacity: 0; transform: translateY(-14px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes livePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(236,72,153,0.6); }
          50%       { opacity: 0.6; box-shadow: 0 0 0 5px rgba(236,72,153,0); }
        }
        @keyframes radarSpin {
          0%   { transform: rotate(0deg);   }
          100% { transform: rotate(360deg); }
        }
      `}</style>

      <div style={{
        height: '100%', overflowY: 'auto',
        padding: '36px 40px',
        color: '#e2e8f0',
        fontFamily: 'var(--font-inter, Inter, sans-serif)',
      }}>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <h1 style={{
              fontSize: '26px', fontWeight: 700, color: '#f8fafc',
              margin: 0, letterSpacing: '-0.01em',
            }}>
              Base Radar
            </h1>

            {/* LIVE badge */}
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '4px 12px', borderRadius: '99px',
              background: 'rgba(236,72,153,0.12)',
              border: '1px solid rgba(236,72,153,0.30)',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
              color: '#ec4899',
              fontFamily: 'var(--font-plex-mono)',
            }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: '#ec4899',
                animation: 'livePulse 1.8s ease-in-out infinite',
                flexShrink: 0,
              }} />
              LIVE
            </span>
          </div>

          <p style={{ fontSize: '13px', color: '#64748b', margin: '0 0 16px' }}>
            New Base tokens detected in the last 2 hours — honeypot checked, Clark-rated
          </p>

          {/* Countdown + refresh */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{
              fontSize: '11px', color: '#3a5268',
              fontFamily: 'var(--font-plex-mono)',
            }}>
              Refresh in {countdown}s
            </span>
            <button
              onClick={handleManualRefresh}
              disabled={loading}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 14px', borderRadius: '8px',
                background: 'rgba(45,212,191,0.08)',
                border: '1px solid rgba(45,212,191,0.20)',
                color: loading ? '#3a5268' : '#2DD4BF',
                fontSize: '11px', fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono)',
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round"
                style={{ animation: loading ? 'radarSpin 0.8s linear infinite' : 'none' }}
              >
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                <path d="M21 3v5h-5"/>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                <path d="M8 16H3v5"/>
              </svg>
              {loading ? 'Scanning…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* ── Main layout ─────────────────────────────────────────────── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 280px',
          gap: '24px',
          alignItems: 'start',
        }}>

          {/* ── Left: live feed ──────────────────────────────────────── */}
          <div>
            <p style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
              color: '#3a5268', textTransform: 'uppercase',
              fontFamily: 'var(--font-plex-mono)',
              margin: '0 0 14px',
            }}>
              Live Feed {tokens.length > 0 && `— ${tokens.length} token${tokens.length !== 1 ? 's' : ''}`}
            </p>

            {error && (
              <div style={{
                padding: '14px 18px', borderRadius: '12px',
                background: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.20)',
                color: '#f87171', fontSize: '13px',
                marginBottom: '16px',
                fontFamily: 'var(--font-plex-mono)',
              }}>
                {error}
              </div>
            )}

            {loading && tokens.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {[...Array(4)].map((_, i) => (
                  <div key={i} style={{
                    height: '120px', borderRadius: '14px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    animation: 'radarSlideIn 0.3s ease both',
                    animationDelay: `${i * 80}ms`,
                  }} />
                ))}
              </div>
            )}

            {!loading && tokens.length === 0 && !error && <EmptyFeed />}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {tokens.map((token, i) => (
                <TokenCard
                  key={`${token.contract}-${refreshKey}`}
                  token={token}
                  index={i}
                  onClick={() => openToken(token.contract)}
                />
              ))}
            </div>
          </div>

          {/* ── Right: stats panel ───────────────────────────────────── */}
          <div style={{ position: 'sticky', top: '0' }}>
            <p style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
              color: '#3a5268', textTransform: 'uppercase',
              fontFamily: 'var(--font-plex-mono)',
              margin: '0 0 14px',
            }}>
              Radar Stats
            </p>
            <StatsPanel stats={stats} fetchedAt={data?.fetchedAt ?? null} loading={loading} />
          </div>
        </div>
      </div>
    </>
  )
}
