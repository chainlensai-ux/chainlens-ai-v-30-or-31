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
  marketCap?: number | null
  fdv?: number | null
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
  marketCap?: number | null
  fdv?: number | null
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
  holderDistribution?: { top1:number|null; top5:number|null; top10:number|null; top20:number|null; others:number|null; holderCount:number|null; topHolders:Array<{rank:number;address:string;amount:number;percent:number|null}> } | null
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
          marketCap: num(json.market_cap ?? attr(mainPool).market_cap_usd),
          fdv: num(json.fdv ?? attr(mainPool).fdv_usd),
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
          holderDistribution: json.holderDistribution ?? null,
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
          .metric-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;}
        }
        @media (min-width: 1024px){ .metric-grid{grid-template-columns:repeat(5,minmax(0,1fr)) !important;} }
        @media (min-width: 768px) and (max-width: 1023px){ .metric-grid{grid-template-columns:repeat(3,minmax(0,1fr)) !important;} }
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
              {loading ? 'SCANNING…' : 'SCAN TOKEN'}
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
                    {shorten(result.contract)}
                    {` · ${String(result.chain ?? 'Base').toUpperCase()}`}
                    <span style={{marginLeft:'8px',padding:'2px 8px',border:'1px solid rgba(59,130,246,.35)',borderRadius:'999px',color:'#93c5fd'}}>BASE</span>
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
                <div className="metric-grid" style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
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
                  <StatCard
                    label={result.marketCap != null ? 'Market Cap' : result.fdv != null ? 'FDV' : 'Market Cap'}
                    value={result.marketCap != null ? fmtLarge(result.marketCap) : result.fdv != null ? fmtLarge(result.fdv) : 'Unverified'}
                    accent="#a78bfa"
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


              {/* Holder analytics */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px',marginTop:'24px',marginBottom:'20px'}}>
                <div style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(125,211,252,.16)',borderRadius:'12px',padding:'14px'}}>
                  <p style={{fontSize:'10px',fontWeight:700,letterSpacing:'0.14em',color:'#3a5268',marginBottom:'10px',fontFamily:'var(--font-plex-mono)'}}>HOLDER CONCENTRATION</p>
                  {result.holderDistribution ? <div style={{display:'grid',gap:'6px'}}>{[['Top 1',result.holderDistribution.top1],['Top 5',result.holderDistribution.top5],['Top 10',result.holderDistribution.top10],['Top 20',result.holderDistribution.top20],['Others',result.holderDistribution.others]].map(([l,v]) => <div key={String(l)} style={{display:'grid',gridTemplateColumns:'70px 1fr 50px',alignItems:'center',gap:'8px'}}><span style={{fontSize:'11px',color:'#94a3b8'}}>{l}</span><div style={{height:'7px',borderRadius:'999px',background:'rgba(100,116,139,.25)'}}><div style={{height:'100%',width:`${v == null ? 0 : Math.max(0,Math.min(100,Number(v)))}%`,borderRadius:'999px',background:'linear-gradient(90deg,#22d3ee,#a855f7)'}} /></div><span style={{fontSize:'11px',color:'#cbd5e1',textAlign:'right'}}>{v == null ? 'N/A' : `${Number(v).toFixed(1)}%`}</span></div>)}</div> : <div style={{height:'160px',display:'grid',placeItems:'center',border:'1px dashed rgba(148,163,184,.22)',borderRadius:'10px',color:'#64748b',fontSize:'12px',textAlign:'center',padding:'10px'}}><div><div style={{fontWeight:700,color:'#94a3b8'}}>Holder distribution unavailable</div><div>Top-holder percentages were not returned for this token. Clark treats concentration as unverified risk.</div></div></div>}
                </div>
                <div style={{background:'rgba(255,255,255,0.02)',border:'1px solid rgba(125,211,252,.16)',borderRadius:'12px',padding:'14px'}}>
                  <p style={{fontSize:'10px',fontWeight:700,letterSpacing:'0.14em',color:'#3a5268',marginBottom:'10px',fontFamily:'var(--font-plex-mono)'}}>TOP HOLDERS</p>
                  {result.holderDistribution?.topHolders?.length ? <div style={{display:'grid',gap:'4px',maxHeight:'160px',overflowY:'auto'}}>{result.holderDistribution.topHolders.slice(0,20).map((h) => <div key={h.rank+h.address} style={{display:'grid',gridTemplateColumns:'28px 1fr 56px',fontSize:'11px',color:'#cbd5e1',gap:'8px'}}><span style={{color:'#94a3b8'}}>#{h.rank}</span><span>{shorten(h.address)}</span><span style={{textAlign:'right'}}>{h.percent == null ? 'N/A' : `${h.percent.toFixed(2)}%`}</span></div>)}</div> : <div style={{height:'160px',display:'grid',placeItems:'center',border:'1px dashed rgba(148,163,184,.22)',borderRadius:'10px',color:'#64748b',fontSize:'12px',textAlign:'center',padding:'10px'}}><div><div style={{fontWeight:700,color:'#94a3b8'}}>No holder rows returned</div><div>Try a larger token or rerun later. Scan still uses market, liquidity, and security evidence.</div></div></div>}
                </div>
              </div>

              {/* Pools */}
              {result.pools && result.pools.length > 0 && (
                <>
                  <p style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                    color: '#3a5268', textTransform: 'uppercase',
                    marginBottom: '10px', fontFamily: 'var(--font-plex-mono)',
                  }}>
                    Liquidity Liquidity & Liquidity & Pools Pools · {result.pools.length} POOLS
                  </p><div style={{display:'inline-flex',marginBottom:'10px',padding:'3px 9px',borderRadius:'999px',border:'1px solid rgba(125,211,252,.3)',color:'#67e8f9',fontSize:'10px',fontFamily:'var(--font-plex-mono)'}}>{result.pools.length} POOLS</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {[...result.pools].sort((a,b)=>(b.liquidity??0)-(a.liquidity??0)).slice(0,8).map((pool, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1.2fr repeat(6, auto)',
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
                        <span style={{ color: '#64748b', whiteSpace: 'nowrap' }}>APR N/A</span><span style={{ color: pctColor(pool.priceChange24h), whiteSpace: 'nowrap' }}>{fmtPct(pool.priceChange24h)}</span><span style={{whiteSpace:'nowrap',color:(pool.liquidity??0)>200000?'#34d399':(pool.liquidity??0)>50000?'#67e8f9':'#fbbf24'}}>{(pool.liquidity??0)>200000?'Excellent':(pool.liquidity??0)>50000?'Healthy':'Weak'}</span>
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
              Clark AI Verdict
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
          {result && (() => {
            const hp = result.honeypot
            const gp = result.goplus && result.contract ? (result.goplus[result.contract.toLowerCase()] ?? null) as Record<string, unknown> | null : null
            const buyTax = hp?.buyTax ?? (gp?.buy_tax != null ? Number(gp.buy_tax) * 100 : null)
            const sellTax = hp?.sellTax ?? (gp?.sell_tax != null ? Number(gp.sell_tax) * 100 : null)
            const transferTax = hp?.transferTax ?? null
            const simulationFailed = hp ? !hp.simulationSuccess : false
            const hpFlagged = hp?.isHoneypot === true || String(gp?.is_honeypot ?? '') === '1'
            const blacklistRisk = String(gp?.is_blacklisted ?? '') === '1' || String(gp?.is_whitelisted ?? '') === '1'
            const ownerHeld = String(gp?.owner_address ?? '') && String(gp?.owner_address ?? '') !== '0x0000000000000000000000000000000000000000'
            const liq = result.liquidity ?? 0
            const hasMarket = (result.price != null) || (result.volume24h != null) || liq > 0
            const strongRisk = hpFlagged || simulationFailed || (buyTax != null && buyTax >= 15) || (sellTax != null && sellTax >= 15) || (transferTax != null && transferTax >= 15) || blacklistRisk
            const watchReady = (hp?.isHoneypot === false || String(gp?.is_honeypot ?? '') === '0') && !simulationFailed && (buyTax == null || buyTax <= 5) && (sellTax == null || sellTax <= 5) && liq > 50000 && (result.volume24h ?? 0) > 0
            const verdict = !hasMarket && !hp && !gp ? 'UNKNOWN' : strongRisk ? 'AVOID' : watchReady && !ownerHeld ? 'WATCH' : 'SCAN DEEPER'
            const confidence = verdict === 'AVOID' ? 'High' : verdict === 'WATCH' ? 'Medium-High' : verdict === 'SCAN DEEPER' ? 'Medium' : 'Low'
            const holderMissing = !result.holderDistribution || result.holderDistribution.topHolders.length === 0
            const holderRisk = result.holderDistribution?.top1 != null && result.holderDistribution.top1 > 25 ? 'Top holder concentration elevated.' : result.holderDistribution?.top5 != null && result.holderDistribution.top5 > 50 ? 'Top 5 holders control over half supply.' : result.holderDistribution?.top10 != null && result.holderDistribution.top10 > 70 ? 'Heavy holder concentration.' : holderMissing ? 'Holder distribution unverified.' : ''
            const missing = [ownerHeld ? 'Contract ownership renounced' : '', result.marketCap == null && result.fdv == null ? 'Market cap / FDV' : '', 'LP lock/control', holderMissing ? 'Holder concentration' : '', 'Deployer behavior'].filter(Boolean)
            return <div style={{display:'grid',gap:'10px'}}><div style={{padding:'10px',border:'1px solid rgba(125,211,252,.2)',borderRadius:'10px',background:'rgba(10,20,32,.6)'}}><div style={{fontSize:'10px',letterSpacing:'.13em',color:'#94a3b8'}}>VERDICT</div><div style={{fontSize:'24px',fontWeight:800,color:verdict==='AVOID'?'#f87171':verdict==='WATCH'?'#2DD4BF':verdict==='SCAN DEEPER'?'#fbbf24':'#94a3b8'}}>{verdict}</div><div style={{fontSize:'11px',color:'#94a3b8'}}>Confidence: {confidence}</div></div><div style={{fontSize:'12px',color:'#cbd5e1',lineHeight:1.65}}>{result.symbol ?? 'This token'} has {liq > 0 ? `usable liquidity (${fmtLarge(result.liquidity)})` : 'limited liquidity context'} and {result.volume24h != null ? `24h activity (${fmtLarge(result.volume24h)})` : 'unclear 24h activity'}. {ownerHeld ? 'Owner is still held and deeper control checks are required.' : 'Ownership appears renounced, but LP and holder checks are still required.'}</div><div style={{fontSize:'11px',color:'#94a3b8'}}>• Key Signals: Liquidity {fmtLarge(result.liquidity)}, 24H {fmtPct(result.priceChange24h)}, Honeypot {hp?.isHoneypot === false ? 'No' : hp?.isHoneypot === true ? 'Flagged' : 'Unverified'}, Buy/Sell Tax {buyTax != null ? `${buyTax.toFixed(1)}%` : 'N/A'} / {sellTax != null ? `${sellTax.toFixed(1)}%` : 'N/A'}</div><div style={{fontSize:'11px',color:'#94a3b8'}}>• Risks: {strongRisk ? 'High-risk security signal detected.' : [ownerHeld ? 'Owner status held.' : '', holderRisk].filter(Boolean).join(' ') || 'No critical risk flag in current simulation.'}</div><div style={{fontSize:'11px',color:'#94a3b8'}}>• Missing Checks: {missing.join(', ') || 'None major in current read.'}</div><div style={{fontSize:'11px',color:'#67e8f9'}}>Next Action: Run liquidity and dev-wallet checks before treating this as a watchlist lead.</div></div> })()}
          <div style={{marginTop:'auto',paddingTop:'8px',borderTop:'1px solid rgba(148,163,184,.12)',fontSize:'10px',color:'#64748b',lineHeight:1.5,fontFamily:'var(--font-plex-mono)'}}>RPC: hidden<br/>We never render RPC URLs or API keys in the interface. Debug via server logs only.</div>
        </aside>

      </div>
    </>
  )
}
