'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────

type Pool = {
  name?: string
  address?: string
  price?: number | null
  liquidity?: number | null
  volume24h?: number | null
  priceChange24h?: number | null
}

type ScanResult = {
  name?: string
  symbol?: string
  contract?: string
  chain?: string
  price?: number | null
  liquidity?: number | null
  volume24h?: number | null
  priceChange24h?: number | null
  pools?: Pool[]
  goplus?: Record<string, Record<string, unknown>> | null
  honeypot?: {
    isHoneypot: boolean | null
    buyTax: number | null
    sellTax: number | null
    transferTax: number | null
    simulationSuccess: boolean
  } | null
  noActivePools?: boolean
}

// ─── Formatters ───────────────────────────────────────────────────────────

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  if (v < 0.000001) return `$${v.toExponential(2)}`
  if (v < 0.001)    return `$${v.toFixed(8)}`
  if (v < 1)        return `$${v.toFixed(6)}`
  return `$${v.toFixed(4)}`
}

function fmtLarge(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function pctColor(v: number | null | undefined): string {
  if (v == null) return '#94a3b8'
  return v >= 0 ? '#2DD4BF' : '#f87171'
}

function shorten(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ─── StatCard ─────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '12px',
      padding: '16px 20px',
    }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        marginBottom: '10px', fontFamily: 'var(--font-plex-mono)',
      }}>
        {label}
      </p>
      <p style={{
        fontSize: '20px', fontWeight: 700,
        color: accent ?? '#e2e8f0',
        fontFamily: 'var(--font-plex-mono)',
        margin: 0,
      }}>
        {value}
      </p>
    </div>
  )
}

// ─── Contract Security ───────────────────────────────────────────────

type PillStyle = { color: string; bg: string; border: string }

function pillSafe():   PillStyle { return { color: '#34d399', bg: 'rgba(52,211,153,0.09)',   border: 'rgba(52,211,153,0.22)'   } }
function pillDanger(): PillStyle { return { color: '#f87171', bg: 'rgba(248,113,113,0.09)', border: 'rgba(248,113,113,0.25)' } }
function pillAmber():  PillStyle { return { color: '#fbbf24', bg: 'rgba(251,191,36,0.09)',  border: 'rgba(251,191,36,0.25)'  } }
function pillMuted():  PillStyle { return { color: '#3a5268', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.07)' } }

function RiskPill({ label, value }: { label: string; value: PillStyle & { label: string } }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '5px 11px', borderRadius: '99px',
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em',
      fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
      color: value.color, background: value.bg, border: `1px solid ${value.border}`,
    }}>
      <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 500 }}>{label}:</span>
      {value.label}
    </span>
  )
}

type HoneypotData = {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  transferTax: number | null
  simulationSuccess: boolean
} | null

function taxPct(n: number): PillStyle {
  if (n === 0)    return pillSafe()
  if (n <= 5)     return pillAmber()
  return pillDanger()
}

function ContractRiskSection({ gp, hp }: { gp: Record<string, unknown> | null; hp: HoneypotData }) {
  const hasAnyData = gp || (hp && hp.simulationSuccess)
  if (!hasAnyData) return (
    <div style={{ marginTop: '28px' }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        marginBottom: '12px', fontFamily: 'var(--font-plex-mono)',
      }}>
        Security Simulation
      </p>
      <div style={{
        padding: '14px 18px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '10px',
        fontSize: '11px', color: '#3a5268',
        fontFamily: 'var(--font-plex-mono)',
      }}>
        No security simulation data surfaced — status is unverified.
      </div>
    </div>
  )

  // Build honeypot.is pills
  const hpPills: { label: string; displayLabel: string; style: PillStyle }[] = []
  if (hp && hp.simulationSuccess) {
    hpPills.push({
      label: 'Honeypot',
      displayLabel: hp.isHoneypot ? 'YES' : 'NO',
      style: hp.isHoneypot ? pillDanger() : pillSafe(),
    })
    if (hp.buyTax !== null) hpPills.push({
      label: 'Buy Tax',
      displayLabel: `${hp.buyTax.toFixed(1)}%`,
      style: taxPct(hp.buyTax),
    })
    if (hp.sellTax !== null) hpPills.push({
      label: 'Sell Tax',
      displayLabel: `${hp.sellTax.toFixed(1)}%`,
      style: taxPct(hp.sellTax),
    })
    if (hp.transferTax !== null && hp.transferTax > 0) hpPills.push({
      label: 'Transfer Tax',
      displayLabel: `${hp.transferTax.toFixed(1)}%`,
      style: taxPct(hp.transferTax),
    })
  }

  function flagPill(key: string, label: string, dangerOn = '1'): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label, displayLabel: 'N/A', style: pillMuted() }
    const raw = gp[key]
    if (raw == null) return { label, displayLabel: 'N/A', style: pillMuted() }
    const v = String(raw)
    const isDanger = v === dangerOn
    return {
      label,
      displayLabel: v === '1' ? 'YES' : v === '0' ? 'NO' : v,
      style: isDanger ? pillDanger() : pillSafe(),
    }
  }

  function taxPill(key: string, label: string): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label, displayLabel: 'N/A', style: pillMuted() }
    const raw = gp[key]
    if (raw == null) return { label, displayLabel: 'N/A', style: pillMuted() }
    const n = parseFloat(String(raw))
    if (isNaN(n)) return { label, displayLabel: 'N/A', style: pillMuted() }
    const pct = (n * 100).toFixed(1)
    return {
      label,
      displayLabel: `${pct}%`,
      style: n > 0.1 ? (n > 0.05 ? pillDanger() : pillAmber()) : pillSafe(),
    }
  }

  function ownerPill(): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label: 'Owner', displayLabel: 'N/A', style: pillMuted() }
    const addr = String(gp['owner_address'] ?? '')
    const renounced = !addr || addr === '0x0000000000000000000000000000000000000000'
    return {
      label: 'Owner',
      displayLabel: renounced ? 'RENOUNCED' : 'HELD',
      style: renounced ? pillSafe() : pillAmber(),
    }
  }

  const gpPills = gp ? [
    flagPill('is_honeypot',            'Honeypot'),
    flagPill('is_mintable',            'Mint Function'),
    flagPill('can_take_back_ownership','Ownership Revert'),
    flagPill('is_proxy',               'Proxy Contract', '__never__'),
    flagPill('is_blacklisted',         'Blacklist'),
    flagPill('is_whitelisted',         'Whitelist',      '__never__'),
    taxPill('buy_tax',  'Buy Tax'),
    taxPill('sell_tax', 'Sell Tax'),
    ownerPill(),
  ] : []

  return (
    <div style={{ marginTop: '28px' }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        marginBottom: '12px', fontFamily: 'var(--font-plex-mono)',
      }}>
        Security Simulation
        {hp?.simulationSuccess && <span style={{ color: '#1e3a44', marginLeft: '6px' }}>· Honeypot.is</span>}
        
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
        {[...hpPills, ...gpPills].map(p => (
          <RiskPill key={p.label} label={p.label} value={{ ...p.style, label: p.displayLabel }} />
        ))}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function TerminalTokenScanner() {
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<ScanResult | null>(null)
  const [error, setError]       = useState<string | null>(null)

  const [clarkVerdict, setClarkVerdict] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkError, setClarkError]     = useState<string | null>(null)

  // Auto-scan when opened from Base Radar with ?contract= param
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params   = new URLSearchParams(window.location.search)
    const contract = params.get('contract')
    if (contract && /^0x[a-fA-F0-9]{40}$/.test(contract)) {
      handleScan(contract)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleScan(override?: string) {
    const q = (override ?? input).trim()
    if (!q || loading) return
    if (!/^0x[a-fA-F0-9]{40}$/.test(q)) {
      setError('Please enter a valid contract address (0x…)')
      return
    }
    setLoading(true)
    setClarkLoading(true)
    setError(null)
    setResult(null)
    setClarkVerdict(null)
    setClarkError(null)
    try {
      const res  = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract: q }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        setError(json.error ?? 'Token not found on Base.')
        setClarkLoading(false)
      } else {
        const pairs: Array<Record<string, unknown>> = Array.isArray(json.pairs) ? json.pairs : []
        const mainPool = pairs[0] ?? null
        const attr = (p: Record<string, unknown> | null) => ((p?.attributes as Record<string, unknown> | undefined) ?? {})
        const num = (v: unknown) => { const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN; return Number.isFinite(n) && n !== 0 ? n : null }
        const mapped: ScanResult = {
          name:           json.name,
          symbol:         json.symbol,
          contract:       json.contract,
          chain:          json.chain ?? 'base',
          noActivePools:  json.noActivePools ?? false,
          price:          mainPool ? num(attr(mainPool).base_token_price_usd) : null,
          liquidity:      mainPool ? num(attr(mainPool).reserve_in_usd) : null,
          volume24h:      mainPool ? num((attr(mainPool).volume_usd as Record<string, unknown> | undefined)?.h24) : null,
          priceChange24h: mainPool ? num((attr(mainPool).price_change_percentage as Record<string, unknown> | undefined)?.h24) : null,
          pools: pairs.map((p: Record<string, unknown>) => ({
            name:           (attr(p).name as string | undefined),
            address:        (attr(p).address as string | undefined),
            price:          num(attr(p).base_token_price_usd),
            liquidity:      num(attr(p).reserve_in_usd),
            volume24h:      num((attr(p).volume_usd as Record<string, unknown> | undefined)?.h24),
            priceChange24h: num((attr(p).price_change_percentage as Record<string, unknown> | undefined)?.h24),
          })),
          goplus:   json.goplus   ?? null,
          honeypot: json.honeypot ?? null,
        }
        setResult(mapped)
        if (json.aiSummary) {
          setClarkVerdict(json.aiSummary)
        } else {
          setClarkError('No AI verdict returned.')
        }
        setClarkLoading(false)
      }
    } catch {
      setError('Network error — check your connection.')
      setClarkLoading(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes clarkDot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.75); }
          40%            { opacity: 1;    transform: scale(1);    }
        }
        @media (max-width: 768px) {
          .token-main { padding: 20px 14px 120px !important; }
          .token-input-row { flex-direction: column; max-width: 100% !important; }
          .token-input-row button { width: 100%; }
        }
      `}</style>

      <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>

        {/* ── Left: scrollable scan area ──────────────────────────── */}
        <div className="mob-scan-main token-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '40px 48px 120px' }}>

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

          {/* Header */}
          <div style={{ marginBottom: '32px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.25)',
              borderRadius: '99px', padding: '4px 12px', marginBottom: '16px',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
              color: '#a78bfa', fontFamily: 'var(--font-plex-mono)',
            }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: '#8b5cf6', boxShadow: '0 0 8px rgba(139,92,246,0.80)',
                flexShrink: 0,
              }} />
              TOKEN SCANNER
            </div>
            <h1 style={{ fontSize: '28px', fontWeight: 800, color: '#f8fafc', lineHeight: 1.2, margin: 0 }}>Token Scanner <span style={{ color: '#2DD4BF' }}>Elite</span></h1><p style={{margin:'8px 0 0',color:'#94a3b8',fontSize:'13px'}}>Scan Base tokens for liquidity, contract risk, taxes, pool depth, and Clark AI verdicts.</p><p style={{margin:'6px 0 0',color:'#64748b',fontSize:'11px',fontFamily:'var(--font-plex-mono)'}}>Paste a Base contract or token symbol.</p>
          </div>

          {/* Input row */}
          <div className="token-input-row" style={{ display: 'flex', gap: '10px', maxWidth: '680px', marginBottom: '28px' }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
              disabled={loading}
              placeholder="Paste Base contract or token symbol"
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
              onClick={() => handleScan()}
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

          {/* Results */}
          {result && (
            <div style={{ maxWidth: '820px' }}>

              {/* Token identity */}
              <div style={{ marginBottom: '24px' }}>
                <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc', margin: '0 0 4px' }}>
                  {result.name ?? 'Unknown'}
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
                    {` · ${String(result.chain ?? 'Base').toUpperCase()}`}
                  </p>
                )}
              </div>

              {/* Stat cards — or no-pools message */}
              {result.noActivePools ? (
                <div style={{
                  padding: '14px 18px', marginBottom: '28px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '10px',
                  fontSize: '12px', color: '#3a5268',
                  fontFamily: 'var(--font-plex-mono)',
                }}>
                  No active Base pools found for this contract.
                </div>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                  gap: '10px', marginBottom: '28px',
                }}>
                  <StatCard label="Price"      value={fmtPrice(result.price)}         accent="#2DD4BF" />
                  <StatCard label="Liquidity"  value={fmtLarge(result.liquidity)} />
                  <StatCard label="Volume 24h" value={fmtLarge(result.volume24h)} />
                  <StatCard
                    label="24h Change"
                    value={fmtPct(result.priceChange24h)}
                    accent={pctColor(result.priceChange24h)}
                  />
                </div>
              )}

              {/* Security Simulation */}
              <ContractRiskSection
                gp={result.goplus && result.contract
                  ? (result.goplus[result.contract.toLowerCase()] ?? null)
                  : null}
                hp={result.honeypot ?? null}
              />

              {/* Pools */}
              {result.pools && result.pools.length > 0 && (
                <>
                  <p style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                    color: '#3a5268', textTransform: 'uppercase',
                    marginBottom: '10px', fontFamily: 'var(--font-plex-mono)',
                  }}>
                    Liquidity & Pools · {result.pools.length}
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {[...result.pools].sort((a,b)=>(b.liquidity??0)-(a.liquidity??0)).slice(0,8).map((pool, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr repeat(4, auto)',
                          alignItems: 'center', gap: '20px',
                          padding: '12px 18px',
                          background: 'rgba(255,255,255,0.025)',
                          border: '1px solid rgba(255,255,255,0.06)',
                          borderRadius: '10px',
                          fontSize: '12px', fontFamily: 'var(--font-plex-mono)',
                        }}
                      >
                        <span style={{
                          color: '#94a3b8', overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {pool.name ?? shorten(pool.address ?? '')}
                        </span>
                        <span style={{ color: '#2DD4BF', whiteSpace: 'nowrap' }}>
                          {fmtPrice(pool.price)}
                        </span>
                        <span style={{ color: '#4a6272', whiteSpace: 'nowrap' }}>
                          Liq {fmtLarge(pool.liquidity)}
                        </span>
                        <span style={{ color: '#4a6272', whiteSpace: 'nowrap' }}>
                          Vol {fmtLarge(pool.volume24h)}
                        </span>
                        <span style={{ color: pctColor(pool.priceChange24h), whiteSpace: 'nowrap' }}>
                          {fmtPct(pool.priceChange24h)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Right: Clark verdict panel (288px) ─────────────────── */}
        <aside className="mob-verdict-panel" style={{
          width: '288px',
          flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: '#080c14',
          overflowY: 'auto',
          padding: '28px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}>
          {/* Label */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: clarkLoading ? '#2DD4BF' : clarkVerdict ? '#2DD4BF' : '#1e3a44',
              boxShadow: (clarkLoading || clarkVerdict) ? '0 0 8px rgba(45,212,191,0.8)' : 'none',
              flexShrink: 0,
              transition: 'all 0.3s',
            }} />
            <p style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
              color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)',
              textTransform: 'uppercase', margin: 0,
            }}>
              Clark Verdict
            </p>
          </div>

          {/* Idle */}
          {!clarkLoading && !clarkVerdict && !clarkError && (
            <p style={{
              fontSize: '11px', color: '#1e3a44',
              fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6,
            }}>
              Scan a Base token to generate a structured Clark verdict.
            </p>
          )}

          {/* Loading dots */}
          {clarkLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 0' }}>
              {[0, 1, 2].map(i => (
                <span key={i} style={{
                  width: '5px', height: '5px', borderRadius: '50%',
                  background: '#2DD4BF', display: 'inline-block',
                  animation: `clarkDot 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          )}

          {/* Error */}
          {clarkError && (
            <p style={{
              fontSize: '12px', color: '#fca5a5',
              fontFamily: 'var(--font-plex-mono)', margin: 0, lineHeight: 1.6,
            }}>
              {clarkError}
            </p>
          )}

          {/* Verdict */}
          {clarkVerdict && (() => { const t=clarkVerdict.toLowerCase(); const v=t.includes('avoid')?'AVOID':t.includes('watch')?'WATCH':t.includes('deeper')?'SCAN DEEPER':'UNKNOWN'; const confidence=t.includes('high')?'High':t.includes('low')?'Low':'Medium'; const key = result?.priceChange24h!=null?`24H change ${fmtPct(result.priceChange24h)}`:'Momentum unverified'; const risk = result?.honeypot?.isHoneypot ? 'Honeypot flagged by simulation' : 'No explicit honeypot flag'; return <div style={{display:'grid',gap:'10px'}}><div style={{padding:'10px',border:'1px solid rgba(125,211,252,.2)',borderRadius:'10px',background:'rgba(10,20,32,.6)'}}><div style={{fontSize:'10px',letterSpacing:'.13em',color:'#94a3b8'}}>VERDICT</div><div style={{fontSize:'24px',fontWeight:800,color:v==='AVOID'?'#f87171':v==='WATCH'?'#fbbf24':'#67e8f9'}}>{v}</div><div style={{fontSize:'11px',color:'#94a3b8'}}>Confidence: {confidence}</div></div><div style={{fontSize:'12px',color:'#cbd5e1',lineHeight:1.7}}>Clark read: {result?.symbol ?? 'Token'} needs context from liquidity, taxes, and activity before conviction. Treat this as directional intelligence, not certainty.</div><div style={{fontSize:'11px',color:'#94a3b8'}}>• Key Signal: {key}</div><div style={{fontSize:'11px',color:'#94a3b8'}}>• Risk: {risk}</div><div style={{fontSize:'11px',color:'#94a3b8'}}>• Missing Checks: Holder concentration and LP control may be incomplete.</div><div style={{fontSize:'11px',color:'#67e8f9'}}>Next Action: Validate pool depth and contract controls.</div></div> })()}
        </aside>

      </div>
    </>
  )
}
