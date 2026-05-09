'use client'

import { useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import Link from 'next/link'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'

// ─── Types ────────────────────────────────────────────────────────────────

type VerdictLabel = 'TRUSTWORTHY' | 'WATCH' | 'AVOID' | 'UNKNOWN' | 'SCAN DEEPER' | 'CAUTION'

interface LinkedWallet {
  address: string
  amountReceived: number | null
  asset: string | null
  txHash: string | null
  firstSeen: string | null
  confidence?: 'high' | 'medium' | 'low'
  reason?: string
  overlapTopHolderRank?: number | null
  overlapTopHolderPercent?: number | null
}

interface MatchedHolder {
  address: string
  supplyPct: number
  isDeployer: boolean
  isLinked: boolean
}

interface PreviousProject {
  contractAddress: string
  name: string | null
  symbol: string | null
  createdAt: string | null
  rugFlag: boolean | null
  rugReason: string | null
}

interface ClarkVerdict {
  label: VerdictLabel
  confidence: 'high' | 'medium' | 'low'
  summary: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

interface DevWalletResult {
  contractAddress: string
  chain: string
  deployerAddress: string | null
  deployerConfidence: 'high' | 'medium' | 'low'
  deployerStatus?: 'confirmed' | 'possible_match' | 'not_confirmed'
  methodUsed: string
  creationTxHash?: string | null
  originReason?: string | null
  linkedWallets: LinkedWallet[]
  holderDataAvailable: boolean
  supplyControlled: number | null
  supplyControlStatus?: 'ok' | 'partial' | 'needs_confirmed_creator' | 'not_in_top_holders'
  previousActivityStatus?: string
  matchedHolderWallets: MatchedHolder[]
  previousActivityAvailable: boolean
  previousProjects: PreviousProject[]
  suspiciousTransfers: boolean
  suspiciousTransferReasons: string[]
  clarkVerdict: ClarkVerdict | null
  warnings: string[]
  tokenStatus?: string
  linkedWalletsStatus?: string
  holderStatus?: string
  liquidityStatus?: string
  lpControlStatus?: string
  _diagnostics?: { modules?: unknown[]; rpcConfigured?: boolean; providerUsed?: string; tokenEvidenceDiag?: unknown; origin_discovery?: unknown }
  verdict?: VerdictLabel
  confidence?: string
  reasons?: string[]
  tokenEvidence?: { name?: string | null; symbol?: string | null; price?: number | null; volume24h?: number | null; liquidity?: number | null; holderCount?: number | null; top1?: number | null; top10?: number | null; top20?: number | null } | null
  fetchedAt: string
}

// ─── Design tokens ───────────────────────────────────────────────────────

const VERDICT_STYLE: Record<VerdictLabel, { color: string; bg: string; border: string }> = {
  TRUSTWORTHY: { color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.25)'  },
  WATCH:       { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)'  },
  'SCAN DEEPER': { color: '#c4b5fd', bg: 'rgba(196,181,253,0.10)', border: 'rgba(196,181,253,0.30)' },
  AVOID:       { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.28)' },
  UNKNOWN:     { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.20)' },
  CAUTION:     { color: '#fb923c', bg: 'rgba(251,146,60,0.10)', border: 'rgba(251,146,60,0.26)' },
}

const CONF_COLOR: Record<string, string> = {
  high: '#2DD4BF', medium: '#fbbf24', low: '#f87171',
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function shortAddr(addr: string, pre = 8, suf = 6): string {
  if (addr.length <= pre + suf + 1) return addr
  return `${addr.slice(0, pre)}…${addr.slice(-suf)}`
}

function fmtAmount(v: number | null, asset: string | null): string {
  if (v === null) return '—'
  const sym = asset ?? 'ETH'
  if (v < 0.0001) return `<0.0001 ${sym}`
  if (v < 1) return `${v.toFixed(4)} ${sym}`
  return `${v.toFixed(3)} ${sym}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return iso }
}

function shortHash(hash: string, pre = 10, suf = 8): string {
  if (hash.length <= pre + suf + 1) return hash
  return `${hash.slice(0, pre)}…${hash.slice(-suf)}`
}

function formatMethod(method: string): string {
  if (method === 'unknown' || !method) return 'Current checks did not confirm creator link'
  if (method === 'contract_creation_lookup') return 'Creation record confirmed'
  if (method === 'alchemy_first_mint_recipient') return 'First mint transfer'
  if (method === 'alchemy_earliest_token_transfer_fallback') return 'Earliest transfer'
  if (method === 'alchemy_first_incoming_external') return 'First incoming transfer'
  return method.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null) return '—'
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function clampSentences(text: string, maxSentences = 3): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
  return sentences.slice(0, maxSentences).join(' ')
}

function linkedWalletTag(wallet: LinkedWallet): string {
  if (wallet.reason === 'token_supply_transfer') return 'Token supply'
  if (wallet.reason === 'eth_funding_transfer') return 'ETH funded'
  const asset = (wallet.asset ?? '').toLowerCase()
  if (asset.includes('eth')) return 'ETH recipient'
  if (asset) return 'Token recipient'
  if (wallet.amountReceived !== null) return 'Funded wallet'
  return 'Transfer'
}

const CONF_BADGE: Record<string, { color: string; bg: string; border: string; label: string }> = {
  high:   { color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.25)',  label: 'HIGH' },
  medium: { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)',  label: 'MED' },
  low:    { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.20)', label: 'LOW' },
}

function extractReadSummary(text: string): string {
  const readMatch = text.match(/Read:\s*([\s\S]*?)(?:\n(?:Key signals|Risks|Next action)\s*:|$)/i)
  const read = (readMatch?.[1] ?? text).replace(/\s+/g, ' ').trim()
  return clampSentences(read, 3)
}

// ─── Sub-components ───────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '28px' }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        fontFamily: 'var(--font-plex-mono)', margin: '0 0 12px',
      }}>
        {title}
      </p>
      {children}
    </div>
  )
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'linear-gradient(180deg, rgba(15,23,42,0.72), rgba(10,14,28,0.78))',
      border: '1px solid rgba(148,163,184,0.16)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.03)',
      borderRadius: '14px',
      padding: '20px',
      ...style,
    }}>
      {children}
    </div>
  )
}

function DataRow({ label, value, valueStyle }: {
  label: string
  value: React.ReactNode
  valueStyle?: React.CSSProperties
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
    }}>
      <span style={{ fontSize: '12px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>
        {label}
      </span>
      <span style={{
        fontSize: '12px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)',
        textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all', ...valueStyle,
      }}>
        {value}
      </span>
    </div>
  )
}

const PROVIDER_LEAK_PATTERN = /\b(goldru(sh|sh)?|alchemy|basescan|covalent|geckoterminal|honeypot|rpc|alchemy|api\s+key|unavailable|failed|disabled|provider)\b/i
const CREATOR_NOT_CONFIRMED_PATTERN = /creator.*not confirmed|no creator.*link|creator link not/i

function WarningBanner({ warnings, deployerStatus }: { warnings: string[]; deployerStatus?: string }) {
  const confirmed = deployerStatus === 'confirmed'
  const safe = warnings.filter(w =>
    !PROVIDER_LEAK_PATTERN.test(w) &&
    !(confirmed && CREATOR_NOT_CONFIRMED_PATTERN.test(w))
  )
  if (safe.length === 0) return null
  return (
    <div style={{
      background: 'linear-gradient(180deg, rgba(251,191,36,0.08), rgba(120,53,15,0.08))',
      border: '1px solid rgba(251,191,36,0.28)',
      boxShadow: '0 8px 24px rgba(251,191,36,0.08)',
      borderRadius: '10px',
      padding: '12px 16px',
      marginBottom: '20px',
    }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, color: '#fbbf24',
        textTransform: 'uppercase', letterSpacing: '0.12em',
        fontFamily: 'var(--font-plex-mono)', margin: '0 0 6px',
      }}>
        CORTEX Evidence Read
      </p>
      {safe.map((w, i) => (
        <p key={i} style={{ fontSize: '11px', color: '#94a3b8', margin: '3px 0', fontFamily: 'var(--font-plex-mono)' }}>
          · {w}
        </p>
      ))}
    </div>
  )
}

// ─── Clark Verdict Card ───────────────────────────────────────────────────

function VerdictCard({ verdict, askClarkHref }: { verdict: ClarkVerdict; askClarkHref: string }) {
  const style = VERDICT_STYLE[verdict.label]
  const shortSummary = extractReadSummary(verdict.summary)
  const topSignals = verdict.keySignals.slice(0, 3)
  const topRisks = verdict.risks.slice(0, 3)
  return (
    <Card style={{
      borderColor: style.border,
      background: style.bg,
      marginBottom: '24px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Top accent bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        height: '2px', background: style.color,
      }} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px', width: '100%', marginBottom: '8px' }}>
          <span style={{
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em',
            borderRadius: '99px', padding: '4px 10px',
            color: style.color, border: `1px solid ${style.border}`,
            background: 'rgba(0,0,0,0.25)', fontFamily: 'var(--font-plex-mono)',
          }}>
            {verdict.label}
          </span>
          <span style={{
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
            borderRadius: '99px', padding: '4px 10px',
            color: CONF_COLOR[verdict.confidence] ?? '#94a3b8',
            border: '1px solid rgba(255,255,255,0.16)',
            background: 'rgba(255,255,255,0.03)', fontFamily: 'var(--font-plex-mono)',
          }}>
            {verdict.confidence} confidence
          </span>
          <Link href={askClarkHref} style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: '6px 10px', borderRadius: '9px', textDecoration: 'none',
            color: '#a78bfa', border: '1px solid rgba(167,139,250,0.35)',
            background: 'rgba(167,139,250,0.10)', fontSize: '10px',
            fontWeight: 700, fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
          }}>
            Ask Clark
          </Link>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <span style={{
              fontSize: '10px', fontWeight: 700, color: '#a78bfa',
              letterSpacing: '0.14em', textTransform: 'uppercase',
              fontFamily: 'var(--font-plex-mono)',
            }}>
              CLARK AI VERDICT
            </span>
          </div>

          {/* Read */}
          <p style={{
            fontSize: '10px', fontWeight: 700, color: '#3a5268',
            textTransform: 'uppercase', letterSpacing: '0.12em',
            fontFamily: 'var(--font-plex-mono)', margin: '0 0 6px',
          }}>
            Read
          </p>
          <p style={{
            fontSize: '13px', color: '#e2e8f0', lineHeight: 1.6, margin: '0 0 16px',
          }}>
            {shortSummary}
          </p>

          {/* Signals + Risks in two cols */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '14px' }}>
            {topSignals.length > 0 && (
              <div>
                <p style={{
                  fontSize: '10px', fontWeight: 700, color: '#3a5268',
                  textTransform: 'uppercase', letterSpacing: '0.12em',
                  fontFamily: 'var(--font-plex-mono)', margin: '0 0 6px',
                }}>
                  Key Signals
                </p>
                {topSignals.map((s, i) => (
                  <p key={i} style={{ fontSize: '11px', color: '#94a3b8', margin: '3px 0' }}>· {s}</p>
                ))}
              </div>
            )}
            {topRisks.length > 0 && (
              <div>
                <p style={{
                  fontSize: '10px', fontWeight: 700, color: '#3a5268',
                  textTransform: 'uppercase', letterSpacing: '0.12em',
                  fontFamily: 'var(--font-plex-mono)', margin: '0 0 6px',
                }}>
                  Risks
                </p>
                {topRisks.map((r, i) => (
                  <p key={i} style={{ fontSize: '11px', color: '#f87171', margin: '3px 0' }}>· {r}</p>
                ))}
              </div>
            )}
          </div>

          {/* Next action */}
          <div style={{
            borderTop: '1px solid rgba(255,255,255,0.08)',
            paddingTop: '12px',
            fontSize: '11px', color: '#64748b',
            fontFamily: 'var(--font-plex-mono)',
          }}>
            Next: {verdict.nextAction}
          </div>
        </div>
      </div>
    </Card>
  )
}

// ─── Supply Bar ───────────────────────────────────────────────────────────

function SupplyBar({ supplyControlled, holderDataAvailable }: {
  supplyControlled: number | null
  holderDataAvailable: boolean
}) {
  if (!holderDataAvailable || supplyControlled === null) {
    return (
      <Card>
        <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
          No deployer link confirmed from current checks.
        </p>
      </Card>
    )
  }

  const pct = Math.min(supplyControlled, 100)
  const barColor = pct > 50 ? '#f87171' : pct > 20 ? '#fbbf24' : '#2DD4BF'

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <span style={{ fontSize: '13px', color: '#e2e8f0', fontWeight: 600 }}>
          {supplyControlled.toFixed(1)}%
        </span>
        <span style={{
          fontSize: '10px', fontWeight: 700, color: barColor,
          fontFamily: 'var(--font-plex-mono)',
          background: barColor === '#2DD4BF' ? 'rgba(45,212,191,0.10)' : barColor === '#fbbf24' ? 'rgba(251,191,36,0.10)' : 'rgba(248,113,113,0.10)',
          padding: '2px 8px', borderRadius: '99px',
        }}>
          {pct > 50 ? 'HIGH RISK' : pct > 20 ? 'ELEVATED' : 'LOW'}
        </span>
      </div>
      <div style={{ height: '6px', borderRadius: '99px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: '99px',
          width: `${pct}%`,
          background: barColor,
          transition: 'width 0.6s ease',
        }} />
      </div>
      <p style={{ fontSize: '11px', color: '#3a5268', margin: '8px 0 0', fontFamily: 'var(--font-plex-mono)' }}>
        Deployer + linked wallets estimated supply control
      </p>
    </Card>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function DevWalletPage() {
  const { plan, loading: planLoading } = usePlanWithLoading()
  const [input,   setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<DevWalletResult | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [isTracking, setIsTracking] = useState(false)
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleScan() {
    const q = input.trim()
    if (!q || loading) return
    if (!/^0x[a-fA-F0-9]{40}$/.test(q)) {
      setError('Enter a valid contract address (0x followed by 40 hex characters)')
      return
    }
    setLoading(true)
    setError(null)
    setResult(null)
    setShowAllActivity(false)
    setIsTracking(false)
    setCopied(false)
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      const res  = await fetch('/api/dev-wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ contractAddress: q }),
      })
      const json = await res.json() as DevWalletResult & { error?: string }
      if (!res.ok || json.error) {
        setError((json.error ?? 'Scan failed — try again').replace('Upgrade required for dev wallet scan.', 'Dev Wallet Detector is a Pro feature.'))
      } else {
        setResult(json)
      }
    } catch {
      setError('Network error — check your connection')
    } finally {
      setLoading(false)
    }
  }

  const askClarkHref = useMemo(() => {
    if (!result) return '/terminal/clark-ai'
    const prompt = [
      '[mode: dev-wallet]',
      `Dev wallet follow-up for ${result.contractAddress}`,
      `Likely deployer: ${result.deployerAddress ?? 'unknown'}`,
      `Confidence: ${result.deployerConfidence}`,
      `Linked wallets: ${result.linkedWallets.length}`,
      `Suspicious reasons: ${result.suspiciousTransferReasons.join('; ') || 'none'}`,
      `Holder data available: ${result.holderDataAvailable}`,
      `Verdict: ${result.clarkVerdict?.label ?? 'UNKNOWN'}`,
    ].join('\n')
    return `/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}`
  }, [result])

  if (planLoading) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '80vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>
        Loading plan access…
      </div>
    )
  }
  if (!canAccessFeature(plan, 'dev-wallet')) return <LockedPanel feature="dev-wallet" />

  return (
    <>
      <style>{`
        @keyframes devDot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.75); }
          40%            { opacity: 1;    transform: scale(1);    }
        }
        @media (max-width: 768px) {
          .devwallet-main { padding: 20px 14px 120px !important; }
          .devwallet-input-row { flex-direction: column; max-width: 100% !important; }
          .devwallet-input-row button { width: 100%; }
          .devwallet-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; max-width: 100% !important; }
          .devwallet-results { max-width: 100% !important; }
          .devwallet-linked-row { grid-template-columns: 1fr !important; gap: 8px !important; }
        }
        @media (max-width: 520px) {
          .devwallet-summary-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          minHeight: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '40px 48px 120px',
          color: '#e2e8f0',
          WebkitOverflowScrolling: 'touch',
        }}
        className="mob-scan-main devwallet-main"
      >
        <div style={{
          maxWidth: '1120px',
          position: 'relative',
        }}>
          <div style={{
            position: 'absolute',
            top: '-40px',
            right: '12%',
            width: '240px',
            height: '240px',
            pointerEvents: 'none',
            background: 'radial-gradient(circle, rgba(45,212,191,0.10), rgba(45,212,191,0))',
            filter: 'blur(2px)',
          }} />
        {/* Header */}
        <div style={{ marginBottom: '28px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.30)',
            borderRadius: '99px', padding: '3px 10px', marginBottom: '14px',
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em',
            color: '#a78bfa', fontFamily: 'var(--font-plex-mono)',
            boxShadow: '0 0 16px rgba(139,92,246,0.18)',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: '#8b5cf6', boxShadow: '0 0 8px rgba(139,92,246,0.80)',
            }} />
            ELITE
          </div>
          <h1 style={{ fontSize: '30px', fontWeight: 700, color: '#f8fafc', margin: '0 0 6px', letterSpacing: '-0.02em' }}>
            Dev Wallet Detector
          </h1>
          <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
            Identify the likely deployer, linked wallets, and supply concentration for any Base token
          </p>
        </div>

        {/* Input */}
        <div className="devwallet-input-row" style={{ display: 'flex', gap: '10px', maxWidth: '760px', marginBottom: '28px' }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
            disabled={loading}
            placeholder="0x… token contract address on Base"
            style={{
              flex: 1, background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '12px', padding: '14px 16px',
              color: '#e2e8f0', fontSize: '13px', outline: 'none',
              fontFamily: 'var(--font-plex-mono)',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
            onFocus={e => {
              e.currentTarget.style.borderColor = 'rgba(139,92,246,0.55)'
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(139,92,246,0.15)'
            }}
            onBlur={e  => {
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          />
          <button
            onClick={handleScan}
            disabled={loading || !input.trim()}
            style={{
              padding: '14px 24px', borderRadius: '12px',
              background: loading || !input.trim()
                ? 'rgba(139,92,246,0.15)'
                : 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 55%, #4f46e5 100%)',
              border: '1px solid rgba(139,92,246,0.40)',
              color: loading || !input.trim() ? '#64748b' : '#fff',
              fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em',
              cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-plex-mono)',
              transition: 'background 0.15s, transform 0.1s',
              whiteSpace: 'nowrap',
              boxShadow: loading || !input.trim() ? 'none' : '0 8px 18px rgba(99,102,241,0.30)',
            }}
          >
            {loading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    width: '5px', height: '5px', borderRadius: '50%', background: '#a78bfa',
                    animation: 'devDot 1.2s ease-in-out infinite',
                    animationDelay: `${i * 0.18}s`,
                  }} />
                ))}
              </span>
            ) : 'SCAN'}
          </button>
        </div>

        {/* Report Summary */}
        {result && (
          <div className="devwallet-summary-grid" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4,minmax(0,1fr))',
            gap: '10px',
            maxWidth: '860px',
            marginBottom: '18px',
          }}>
            {[
              { k: 'Likely Deployer', v: result.deployerAddress ? 'Found' : 'Not confirmed', c: result.deployerAddress ? '#2DD4BF' : '#94a3b8' },
              { k: 'Linked Wallets', v: String(result.linkedWallets.length), c: result.linkedWallets.length >= 5 ? '#f87171' : '#a78bfa' },
              { k: 'Suspicious Patterns', v: String(result.suspiciousTransferReasons.length), c: result.suspiciousTransfers ? '#f87171' : '#2DD4BF' },
              { k: 'Confidence', v: result.deployerConfidence, c: result.deployerConfidence === 'high' ? '#2DD4BF' : result.deployerConfidence === 'medium' ? '#fbbf24' : '#f87171' },
            ].map((item, i) => (
              <Card key={i} style={{ padding: '12px 14px', borderColor: 'rgba(255,255,255,0.10)', minHeight: '76px' }}>
                <p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: item.c,
                    boxShadow: `0 0 10px ${item.c}66`,
                  }} />
                  {item.k}
                </p>
                <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: item.c, fontFamily: 'var(--font-plex-mono)' }}>{item.v}</p>
              </Card>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            padding: '12px 16px', borderRadius: '10px',
            background: 'rgba(248,113,113,0.08)',
            border: '1px solid rgba(248,113,113,0.20)',
            color: '#f87171', fontSize: '13px',
            fontFamily: 'var(--font-plex-mono)',
            marginBottom: '24px',
          }}>
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !result && !error && (
          <div style={{
            textAlign: 'center', padding: '60px 20px',
            color: '#3a5268', fontFamily: 'var(--font-plex-mono)',
          }}>
            <div style={{ fontSize: '32px', opacity: 0.3, marginBottom: '12px' }}>⬡</div>
            <p style={{ fontSize: '13px', margin: 0 }}>
              Enter a Base token contract to analyse the deployer wallet
            </p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="devwallet-results" style={{ maxWidth: '860px' }}>
            {/* Warnings */}
            {result.tokenEvidence && (
              <Card style={{ marginBottom: '16px' }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', margin: '0 0 8px', fontFamily: 'var(--font-plex-mono)' }}>
                  {result.tokenEvidence.name ?? 'Unknown'}{result.tokenEvidence.symbol ? ` (${result.tokenEvidence.symbol})` : ''}
                </p>
                <p style={{ fontSize: 11, color: '#94a3b8', margin: '0 0 4px', fontFamily: 'var(--font-plex-mono)' }}>
                  Holder concentration:
                  {' '}Top 1 {result.tokenEvidence.top1 != null ? `${result.tokenEvidence.top1.toFixed(2)}%` : '—'}
                  {' '}· Top 10 {result.tokenEvidence.top10 != null ? `${result.tokenEvidence.top10.toFixed(2)}%` : '—'}
                  {' '}· Top 20 {result.tokenEvidence.top20 != null ? `${result.tokenEvidence.top20.toFixed(2)}%` : '—'}
                </p>
                <p style={{ fontSize: 11, color: '#94a3b8', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>
                  Liquidity / volume: {fmtUsd(result.tokenEvidence.liquidity)} liquidity · {fmtUsd(result.tokenEvidence.volume24h)} 24h volume
                </p>
              </Card>
            )}
            <WarningBanner warnings={result.warnings} deployerStatus={result.deployerStatus} />

            {/* Clark Verdict */}
            {result.clarkVerdict && (
              <VerdictCard verdict={result.clarkVerdict} askClarkHref={askClarkHref} />
            )}
            {!result.clarkVerdict && (
              <Card style={{ marginBottom: '24px', borderColor: 'rgba(148,163,184,0.15)' }}>
                <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                  AI analysis requires deeper evidence. Review signals below and use Ask Clark for follow-up.
                </p>
              </Card>
            )}

            {/* Deployer */}
            <Section title={
              result.deployerStatus === 'confirmed' ? 'Creator Wallet'
              : result.deployerStatus === 'possible_match' ? 'Likely Origin Wallet'
              : 'Creator / Origin Wallet'
            }>
              <Card>
                <DataRow
                  label="Address"
                  value={
                    result.deployerAddress
                      ? <div style={{ textAlign: 'right' }}>
                          <span style={{ fontFamily: 'var(--font-plex-mono)', color: '#c4b5fd', display: 'block' }}>
                            {shortAddr(result.deployerAddress)}
                          </span>
                          <span style={{ fontFamily: 'var(--font-plex-mono)', color: '#64748b', fontSize: '10px' }}>
                            {result.deployerAddress}
                          </span>
                        </div>
                      : <span style={{ color: '#3a5268' }}>No creator link confirmed</span>
                  }
                />
                <DataRow
                  label="Confidence"
                  value={
                    result.deployerStatus === 'confirmed'
                      ? <span style={{ color: '#2DD4BF' }}>Creator confirmed</span>
                      : result.deployerStatus === 'possible_match'
                        ? <span style={{ color: '#fbbf24' }}>Likely origin wallet</span>
                        : <span style={{ color: '#64748b' }}>Creator link not confirmed from current checks</span>
                  }
                />
                <DataRow
                  label="Detection Method"
                  value={formatMethod(result.methodUsed)}
                />
                <DataRow label="Chain" value="Base" />
                <DataRow label="Scanned At" value={fmtDate(result.fetchedAt)} />

                {result.deployerAddress && (
                  <div style={{ marginTop: '14px', display: 'flex', gap: '8px' }}>
                    <button
                      onClick={async () => {
                        await navigator.clipboard.writeText(result.deployerAddress ?? '')
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1400)
                      }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '6px 12px', borderRadius: '8px',
                        fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                        color: copied ? '#2DD4BF' : '#94a3b8', background: 'rgba(148,163,184,0.10)',
                        border: '1px solid rgba(148,163,184,0.25)', fontFamily: 'var(--font-plex-mono)',
                      }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <a
                      href={`https://basescan.org/address/${result.deployerAddress}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '6px 12px', borderRadius: '8px', textDecoration: 'none',
                        fontSize: '11px', fontWeight: 600,
                        color: '#a78bfa', background: 'rgba(139,92,246,0.08)',
                        border: '1px solid rgba(139,92,246,0.20)',
                        fontFamily: 'var(--font-plex-mono)',
                      }}
                    >
                      ↗ Open Explorer
                    </a>
                    <button
                      onClick={() => setIsTracking(v => !v)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '6px 12px', borderRadius: '8px',
                        fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                        color: isTracking ? '#2DD4BF' : '#fbbf24',
                        background: isTracking ? 'rgba(45,212,191,0.10)' : 'rgba(251,191,36,0.10)',
                        border: `1px solid ${isTracking ? 'rgba(45,212,191,0.25)' : 'rgba(251,191,36,0.25)'}`,
                        fontFamily: 'var(--font-plex-mono)',
                      }}
                    >
                      {isTracking ? 'Tracking' : 'Track Deployer'}
                    </button>
                  </div>
                )}
              </Card>
            </Section>

            {/* Supply Concentration */}
            <Section title="Supply Concentration">
              {result.supplyControlStatus === 'needs_confirmed_creator' ? (
                <Card>
                  <p style={{ fontSize: '12px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    Creator-linked supply control cannot be checked — no confirmed creator address.
                  </p>
                </Card>
              ) : result.supplyControlStatus === 'not_in_top_holders' ? (
                <Card>
                  <p style={{ fontSize: '12px', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    ✓ Creator wallet is not in the top-holder set — no concentrated supply control detected.
                  </p>
                </Card>
              ) : (
                <SupplyBar
                  supplyControlled={result.supplyControlled}
                  holderDataAvailable={result.holderDataAvailable}
                />
              )}
              {result.matchedHolderWallets.length > 0 && (
                <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {result.matchedHolderWallets.map((h, i) => (
                    <div key={i} className="devwallet-linked-row" style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 12px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: '8px',
                      fontSize: '11px', fontFamily: 'var(--font-plex-mono)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: '#64748b' }}>{shortAddr(h.address)}</span>
                        {h.isDeployer && (
                          <span style={{
                            padding: '1px 6px', borderRadius: '99px', fontSize: '9px',
                            color: '#a78bfa', background: 'rgba(139,92,246,0.12)',
                            border: '1px solid rgba(139,92,246,0.25)',
                          }}>DEPLOYER</span>
                        )}
                        {h.isLinked && !h.isDeployer && (
                          <span style={{
                            padding: '1px 6px', borderRadius: '99px', fontSize: '9px',
                            color: '#fbbf24', background: 'rgba(251,191,36,0.10)',
                            border: '1px solid rgba(251,191,36,0.20)',
                          }}>LINKED</span>
                        )}
                      </div>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                        {h.supplyPct.toFixed(2)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Linked Wallets */}
            <Section title={`Linked Wallets (${result.linkedWallets.length})`}>
              {result.linkedWallets.length === 0 ? (
                <Card>
                  <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    {result.linkedWalletsStatus === 'none_found'
                      ? 'No outgoing transfers found from the creator wallet in the checked window.'
                      : result.linkedWalletsStatus === 'skipped'
                        ? 'Linked wallet check skipped — no creator address identified.'
                        : 'No signal in checked window.'}
                  </p>
                </Card>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {result.linkedWallets.map((w, i) => {
                    const confBadge = w.confidence ? CONF_BADGE[w.confidence] : null
                    return (
                    <div key={i} style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto auto',
                      gap: '16px', alignItems: 'center',
                      padding: '12px 16px',
                      background: w.confidence === 'high'
                        ? 'rgba(45,212,191,0.03)'
                        : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${w.confidence === 'high' ? 'rgba(45,212,191,0.14)' : 'rgba(255,255,255,0.07)'}`,
                      borderRadius: '10px',
                      fontSize: '11px', fontFamily: 'var(--font-plex-mono)',
                    }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
                        <span style={{ color: '#c4b5fd' }}>{shortAddr(w.address)}</span>
                        <span style={{
                          color: '#64748b', fontSize: '10px',
                          border: '1px solid rgba(255,255,255,0.10)', borderRadius: '99px', padding: '1px 6px',
                        }}>
                          {linkedWalletTag(w)}
                        </span>
                        {confBadge && (
                          <span style={{
                            fontSize: '9px', fontWeight: 700,
                            color: confBadge.color, background: confBadge.bg,
                            border: `1px solid ${confBadge.border}`, borderRadius: '99px', padding: '1px 6px',
                          }}>
                            {confBadge.label}
                          </span>
                        )}
                        {w.overlapTopHolderRank != null && (
                          <span style={{
                            fontSize: '9px', color: '#a78bfa', background: 'rgba(139,92,246,0.10)',
                            border: '1px solid rgba(139,92,246,0.25)', borderRadius: '99px', padding: '1px 6px',
                          }}>
                            Top holder #{w.overlapTopHolderRank}
                            {w.overlapTopHolderPercent != null ? ` · ${parseFloat(w.overlapTopHolderPercent.toFixed(2))}%` : ''}
                          </span>
                        )}
                        {w.firstSeen && (
                          <span style={{ color: '#3a5268' }}>
                            {fmtDate(w.firstSeen)}
                          </span>
                        )}
                      </div>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                        {fmtAmount(w.amountReceived, w.asset)}
                      </span>
                      <span style={{ color: '#64748b', fontSize: '10px' }}>
                        {w.txHash ? shortHash(w.txHash) : '—'}
                      </span>
                      {w.txHash && (
                        <a
                          href={`https://basescan.org/tx/${w.txHash}`}
                          target="_blank" rel="noopener noreferrer"
                          style={{ color: '#3a5268', textDecoration: 'none', fontSize: '10px' }}
                          title="View tx on Basescan"
                        >
                          ↗ Explorer
                        </a>
                      )}
                    </div>
                    )
                  })}
                </div>
              )}
            </Section>

            {/* Suspicious Transfers */}
            <Section title="Transfer Analysis">
              {result.suspiciousTransfers ? (
                <Card style={{ borderColor: 'rgba(248,113,113,0.20)', background: 'rgba(248,113,113,0.05)' }}>
                  <p style={{
                    fontSize: '11px', fontWeight: 700, color: '#f87171',
                    textTransform: 'uppercase', letterSpacing: '0.12em',
                    fontFamily: 'var(--font-plex-mono)', margin: '0 0 8px',
                  }}>
                    ⚠ Suspicious Patterns Detected
                  </p>
                  {result.suspiciousTransferReasons.map((r, i) => (
                    <p key={i} style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0', fontFamily: 'var(--font-plex-mono)' }}>
                      · {r}
                    </p>
                  ))}
                </Card>
              ) : (
                <Card>
                  <p style={{ fontSize: '12px', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    ✓ No suspicious transfer pattern detected from available data.
                  </p>
                </Card>
              )}
            </Section>

            {/* Previous Projects */}
            <Section title="Previous Activity / Projects">
              {!result.previousActivityAvailable && result.previousActivityStatus !== 'limited_check' ? (
                <Card>
                  <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    {result.previousActivityStatus === 'skipped'
                      ? 'Previous activity requires a confirmed creator address.'
                      : 'Previous activity data not available from current checks.'}
                  </p>
                </Card>
              ) : result.previousProjects.length === 0 ? (
                <Card>
                  <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    {result.previousActivityStatus === 'none_found'
                      ? 'No previous contract deployments found for this wallet.'
                      : result.previousActivityStatus === 'limited_check'
                        ? 'No previous activity detected — history check used token transfer data only.'
                        : 'No previous activity detected from available transfer history.'}
                  </p>
                </Card>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(showAllActivity ? result.previousProjects : result.previousProjects.slice(0, 6)).map((p, i) => (
                    <Card key={i} style={{
                      borderColor: p.rugFlag ? 'rgba(248,113,113,0.25)' : 'rgba(255,255,255,0.08)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <p style={{ fontSize: '12px', color: '#c4b5fd', fontFamily: 'var(--font-plex-mono)', margin: '0 0 4px' }}>
                            {p.name && p.symbol ? `${p.name} (${p.symbol})` : shortAddr(p.contractAddress)}
                            <span style={{
                              marginLeft: '8px', fontSize: '9px', color: '#64748b',
                              border: '1px solid rgba(255,255,255,0.10)', borderRadius: '99px', padding: '1px 6px',
                            }}>
                              {result.previousActivityStatus === 'ok' ? 'Deployed contract' : p.symbol ? 'Token interaction' : 'Previous activity'}
                            </span>
                          </p>
                          <p style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                            {p.contractAddress}
                          </p>
                          {!p.name && !p.symbol && (
                            <p style={{ fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', margin: '6px 0 0' }}>
                              Metadata pending in current checks
                            </p>
                          )}
                          {p.rugReason && (
                            <p style={{ fontSize: '11px', color: '#f87171', margin: '6px 0 0' }}>· {p.rugReason}</p>
                          )}
                        </div>
                        <span style={{
                          padding: '3px 10px', borderRadius: '99px',
                          fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em',
                          fontFamily: 'var(--font-plex-mono)',
                          color: p.rugFlag === true ? '#f87171' : p.rugFlag === false ? '#2DD4BF' : '#94a3b8',
                          background: p.rugFlag === true ? 'rgba(248,113,113,0.10)' : p.rugFlag === false ? 'rgba(45,212,191,0.08)' : 'rgba(148,163,184,0.08)',
                          border: `1px solid ${p.rugFlag === true ? 'rgba(248,113,113,0.25)' : p.rugFlag === false ? 'rgba(45,212,191,0.20)' : 'rgba(148,163,184,0.20)'}`,
                        }}>
                          {p.rugFlag === true ? 'Flagged' : p.rugFlag === false ? 'Checked' : 'No signal in checked window'}
                        </span>
                      </div>
                    </Card>
                  ))}
                  {result.previousProjects.length > 6 && (
                    <button
                      onClick={() => setShowAllActivity(v => !v)}
                      style={{
                        marginTop: '4px',
                        alignSelf: 'flex-start',
                        padding: '6px 10px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        color: '#a78bfa',
                        background: 'rgba(167,139,250,0.08)',
                        border: '1px solid rgba(167,139,250,0.24)',
                        fontSize: '11px',
                        fontFamily: 'var(--font-plex-mono)',
                      }}
                    >
                      {showAllActivity ? 'Show less' : `Show more (${result.previousProjects.length - 6})`}
                    </button>
                  )}
                </div>
              )}
            </Section>
          </div>
        )}
        </div>
      </div>
    </>
  )
}
