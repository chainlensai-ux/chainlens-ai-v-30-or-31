'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabaseClient'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────

type VerdictLabel = 'TRUSTWORTHY' | 'WATCH' | 'AVOID' | 'UNKNOWN' | 'SCAN DEEPER' | 'CAUTION'
type DevControlRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN'
type DevMapSection = 'dev-map' | 'supply' | 'history' | 'watch'

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
  name?: string | null
  symbol?: string | null
  deployerAddress: string | null
  deployerConfidence: 'high' | 'medium' | 'low'
  deployerStatus?: 'confirmed' | 'possible_match' | 'not_confirmed'
  methodUsed: string
  creationTxHash?: string | null
  originReason?: string | null
  linkedWallets: LinkedWallet[]
  holderDistribution?: { top1?: number | null; top10?: number | null; top20?: number | null; holderCount?: number | null; topHolders?: Array<{ address?: string; percent?: number | null }> } | null
  holderDistributionStatus?: string | null
  holderPercentAvailable?: boolean
  holderPercentSource?: string | null
  topHolders?: Array<{ address?: string; percent?: number | null }>
  top1?: number | null
  top10?: number | null
  top20?: number | null
  holderCount?: number | null
  creatorInTopHolders?: boolean
  linkedWalletSupply?: number | null
  devClusterSupply?: number | null
  liquidity?: number | null
  volume24h?: number | null
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
  liquidityStatus?: string
  lpControlStatus?: string
  _diagnostics?: { modules?: unknown[]; rpcConfigured?: boolean; providerUsed?: string; tokenEvidenceDiag?: unknown; origin_discovery?: unknown }
  verdict?: VerdictLabel
  confidence?: string
  reasons?: string[]
  fetchedAt: string
}

// ─── Design tokens ───────────────────────────────────────────────────────

const VERDICT_STYLE: Record<VerdictLabel, { color: string; bg: string; border: string }> = {
  TRUSTWORTHY:   { color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.25)'  },
  WATCH:         { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)'  },
  'SCAN DEEPER': { color: '#c4b5fd', bg: 'rgba(196,181,253,0.10)', border: 'rgba(196,181,253,0.30)' },
  AVOID:         { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.28)' },
  UNKNOWN:       { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.20)' },
  CAUTION:       { color: '#fb923c', bg: 'rgba(251,146,60,0.10)',  border: 'rgba(251,146,60,0.26)'  },
}

const CONF_COLOR: Record<string, string> = {
  high: '#2DD4BF', medium: '#fbbf24', low: '#f87171',
}

const CONF_BADGE: Record<string, { color: string; bg: string; border: string; label: string }> = {
  high:   { color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.25)',  label: 'HIGH' },
  medium: { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)',  label: 'MED' },
  low:    { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.20)', label: 'LOW' },
}

// ─── Dev Control Scoring ──────────────────────────────────────────────────

type DevControlScore = {
  score: number
  risk: DevControlRisk
  confidence: 'High' | 'Medium' | 'Low'
  summary: string
  riskColor: string
  riskBg: string
  riskBorder: string
}

function calculateDevControl(result: DevWalletResult): DevControlScore {
  const holderUsable = result.holderDistributionStatus === 'ok' || result.holderDistributionStatus === 'partial'
  const hasAnything = result.deployerAddress || result.linkedWallets.length > 0 || holderUsable
  if (!hasAnything) {
    return {
      score: 0, risk: 'UNKNOWN', confidence: 'Low',
      summary: 'Insufficient data — dev control risk cannot be assessed from current checks.',
      riskColor: '#94a3b8', riskBg: 'rgba(148,163,184,0.08)', riskBorder: 'rgba(148,163,184,0.20)',
    }
  }

  let pts = 50

  // Deployer detection
  if (!result.deployerAddress) pts -= 10

  // Suspicious transfers
  if (result.suspiciousTransfers) pts -= 18
  else if (result.deployerAddress) pts += 10

  // Supply control
  if (result.supplyControlStatus === 'not_in_top_holders') {
    pts += 15
  } else if (result.devClusterSupply != null) {
    if      (result.devClusterSupply > 50) pts -= 25
    else if (result.devClusterSupply > 20) pts -= 15
    else if (result.devClusterSupply > 10) pts -= 8
    else if (result.devClusterSupply <= 5) pts += 8
  }

  // Linked wallets count — more wallets = higher potential cluster
  const lw = result.linkedWallets.length
  if      (lw === 0)  pts += 5
  else if (lw <= 2)   pts -= 5
  else if (lw <= 4)   pts -= 12
  else                pts -= 20

  // Previous rug flags
  const rugCount = result.previousProjects.filter(p => p.rugFlag === true).length
  if      (rugCount >= 2)                  pts -= 30
  else if (rugCount === 1)                 pts -= 18
  else if (result.previousActivityAvailable) pts += 5

  // Token holder concentration from evidence
  const top10 = result.top10 ?? result.holderDistribution?.top10
  if (top10 != null && top10 > 60) pts -= 10

  const score = Math.min(100, Math.max(0, Math.round(pts)))

  // Risk level with overrides
  let risk: DevControlRisk
  if (!result.deployerAddress && lw === 0) {
    risk = 'UNKNOWN'
  } else if (rugCount >= 2 || (result.suspiciousTransfers && rugCount >= 1)) {
    risk = 'CRITICAL'
  } else if (score >= 72) {
    risk = 'LOW'
  } else if (score >= 52) {
    risk = 'MEDIUM'
  } else if (score >= 30) {
    risk = 'HIGH'
  } else {
    risk = 'CRITICAL'
  }

  const usableHoldersForConf =
    result.holderDistributionStatus === 'ok' ||
    result.holderDistributionStatus === 'partial'

  const confidence: 'High' | 'Medium' | 'Low' =
    result.deployerAddress && usableHoldersForConf ? 'High' :
    result.deployerAddress || usableHoldersForConf ? 'Medium' : 'Low'

  const summary =
    risk === 'CRITICAL' ? 'Critical dev control risk — multiple serious signals confirmed.' :
    risk === 'HIGH'     ? 'Elevated dev control risk — key checks show concerning patterns.' :
    risk === 'MEDIUM'   ? 'Moderate dev control risk — some signals warrant monitoring.' :
    risk === 'LOW'      ? 'Low dev control risk — no major control signals in available data.' :
    'Insufficient data — dev control risk cannot be assessed from current checks.'

  const riskColor  = risk === 'LOW' ? '#34d399' : risk === 'MEDIUM' ? '#fbbf24' : risk === 'HIGH' ? '#f87171' : risk === 'CRITICAL' ? '#ef4444' : '#94a3b8'
  const riskBg     = risk === 'LOW' ? 'rgba(52,211,153,0.08)' : risk === 'MEDIUM' ? 'rgba(251,191,36,0.08)' : risk === 'HIGH' ? 'rgba(248,113,113,0.08)' : risk === 'CRITICAL' ? 'rgba(239,68,68,0.10)' : 'rgba(148,163,184,0.06)'
  const riskBorder = risk === 'LOW' ? 'rgba(52,211,153,0.28)' : risk === 'MEDIUM' ? 'rgba(251,191,36,0.28)' : risk === 'HIGH' ? 'rgba(248,113,113,0.28)' : risk === 'CRITICAL' ? 'rgba(239,68,68,0.32)' : 'rgba(148,163,184,0.20)'

  return { score, risk, confidence, summary, riskColor, riskBg, riskBorder }
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
  if (method === 'unknown' || !method) return 'Origin not confirmed from current checks'
  if (method === 'contract_creation_lookup') return 'Creation record confirmed'
  if (method === 'alchemy_first_mint_recipient') return 'First mint transfer'
  if (method === 'alchemy_earliest_token_transfer_fallback') return 'Earliest token transfer'
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
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean).slice(0, maxSentences).join(' ')
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

function extractReadSummary(text: string): string {
  const readMatch = text.match(/Read:\s*([\s\S]*?)(?:\n(?:Key signals|Risks|Next action)\s*:|$)/i)
  const read = (readMatch?.[1] ?? text).replace(/\s+/g, ' ').trim()
  return clampSentences(read, 3)
}

const PROVIDER_LEAK_PATTERN = /\b(goldru(sh|sh)?|alchemy|basescan|covalent|geckoterminal|honeypot|rpc|api\s+key|unavailable|failed|disabled|provider)\b/i
const CREATOR_NOT_CONFIRMED_PATTERN = /creator.*not confirmed|no creator.*link|creator link not/i

// ─── Sub-components ───────────────────────────────────────────────────────

function GlassCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'linear-gradient(160deg,rgba(8,16,32,.97),rgba(4,8,18,.95))',
      border: '1px solid rgba(148,163,184,0.14)',
      boxShadow: '0 8px 28px rgba(0,0,0,0.20)',
      borderRadius: '14px',
      padding: '18px 20px',
      ...style,
    }}>
      {children}
    </div>
  )
}

function DataRow({ label, value, valueStyle }: { label: string; value: React.ReactNode; valueStyle?: React.CSSProperties }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 0', borderBottom:'1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ fontSize:'11px', color:'#64748b', fontFamily:'var(--font-plex-mono)' }}>{label}</span>
      <span style={{ fontSize:'11px', color:'#e2e8f0', fontFamily:'var(--font-plex-mono)', textAlign:'right', maxWidth:'60%', wordBreak:'break-all', ...valueStyle }}>{value}</span>
    </div>
  )
}

function StatusDot({ ok, partial, color }: { ok: boolean; partial?: boolean; color: string }) {
  return <span style={{ width:'6px', height:'6px', borderRadius:'50%', background: ok ? color : partial ? color : '#475569', flexShrink:0, boxShadow: ok || partial ? `0 0 5px ${color}` : 'none', display:'inline-block' }} />
}

function WarningBanner({ warnings, deployerStatus }: { warnings: string[]; deployerStatus?: string }) {
  const confirmed = deployerStatus === 'confirmed'
  const safe = warnings.filter(w =>
    !PROVIDER_LEAK_PATTERN.test(w) &&
    !(confirmed && CREATOR_NOT_CONFIRMED_PATTERN.test(w))
  )
  if (safe.length === 0) return null
  return (
    <div style={{ background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.22)', borderRadius:'10px', padding:'12px 16px', marginBottom:'16px' }}>
      <p style={{ fontSize:'9px', fontWeight:700, color:'#fbbf24', textTransform:'uppercase', letterSpacing:'0.12em', fontFamily:'var(--font-plex-mono)', margin:'0 0 6px' }}>
        CORTEX Evidence Read
      </p>
      {safe.map((w, i) => (
        <p key={i} style={{ fontSize:'11px', color:'#94a3b8', margin:'3px 0', fontFamily:'var(--font-plex-mono)' }}>· {w}</p>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function DevWalletPage() {
  const [input,          setInput]          = useState('')
  const [loading,        setLoading]        = useState(false)
  const [result,         setResult]         = useState<DevWalletResult | null>(null)
  const [error,          setError]          = useState<string | null>(null)
  const [cooldownSecs,   setCooldownSecs]   = useState<number>(0)
  const cooldownTimer    = useRef<ReturnType<typeof setInterval> | null>(null)
  const [isTracking,     setIsTracking]     = useState(false)
  const [showAllProj,  setShowAllProj]  = useState(false)
  const [copied,       setCopied]       = useState(false)
  const [activeTab,    setActiveTab]    = useState<DevMapSection>('dev-map')
  const [chain,        setChain]        = useState<'base' | 'eth'>('base')
  const chainLabel = chain === 'eth' ? 'Ethereum' : 'Base'
  const chainBadge = chain === 'eth' ? 'ETH' : 'BASE'
  const explorerBase = chain === 'eth' ? 'https://etherscan.io' : 'https://basescan.org'

  // Cooldown countdown — auto-clears when it hits 0
  useEffect(() => {
    if (cooldownSecs <= 0) return
    if (cooldownTimer.current) clearInterval(cooldownTimer.current)
    cooldownTimer.current = setInterval(() => {
      setCooldownSecs(s => {
        if (s <= 1) {
          clearInterval(cooldownTimer.current!)
          cooldownTimer.current = null
          setError(null)
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => { if (cooldownTimer.current) clearInterval(cooldownTimer.current) }
  }, [cooldownSecs])

  async function handleScan() {
    const q = input.trim()
    if (!q || loading || cooldownSecs > 0) return
    if (!/^0x[a-fA-F0-9]{40}$/.test(q)) {
      setError('Enter a valid contract address (0x followed by 40 hex characters)')
      return
    }
    setLoading(true)
    setError(null)
    setShowAllProj(false)
    setIsTracking(false)
    setCopied(false)
    setActiveTab('dev-map')
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      const res = await fetch('/api/dev-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'include',
        body: JSON.stringify({ contractAddress: q, chain }),
      })
      const json = await res.json() as DevWalletResult & { error?: string; rateLimited?: boolean; retryAfterSeconds?: number }
      if (res.status === 429 && json.rateLimited) {
        const secs = json.retryAfterSeconds ?? 25
        setCooldownSecs(secs)
        setError(`Cooldown active — try again in ${secs}s`)
        // Do NOT wipe last successful result on rate limit
      } else if (!res.ok || json.error) {
        setError((json.error ?? 'Scan failed — try again').replace('Upgrade required for dev wallet scan.', 'Full CORTEX dev-wallet analysis is included in Pro and Elite.'))
        setResult(null)
      } else {
        setResult(json)
        setError(null)
        setCooldownSecs(0)
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
      `CORTEX Dev Control follow-up for ${result.contractAddress} on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}`,
      `Likely deployer: ${result.deployerAddress ?? 'unknown'}`,
      `Confidence: ${result.deployerConfidence}`,
      `Linked wallets: ${result.linkedWallets.length}`,
      `Suspicious reasons: ${result.suspiciousTransferReasons.join('; ') || 'none'}`,
      `Holder data available: ${result.holderDistributionStatus === 'ok' || result.holderDistributionStatus === 'partial'}`,
      `Verdict: ${result.clarkVerdict?.label ?? 'UNKNOWN'}`,
    ].join('\n')
    return `/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}`
  }, [result])


  return (
    <>
      <style>{`
        @keyframes devDot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.75); }
          40%            { opacity: 1;    transform: scale(1);    }
        }
        @media (max-width: 768px) {
          .devmap-main { padding: 20px 14px 120px !important; }
          .devmap-input-row { flex-direction: column; max-width: 100% !important; }
          .devmap-input-row button { width: 100%; }
          .devmap-hero-grid { grid-template-columns: repeat(2,minmax(0,1fr)) !important; }
          .devmap-flow { flex-direction: column !important; gap: 6px !important; }
          .devmap-flow-arrow { transform: rotate(90deg) !important; }
        }
        @media (max-width: 520px) {
          .devmap-hero-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div
        className="mob-scan-main devmap-main"
        style={{ flex:1, minWidth:0, height:'100%', minHeight:'100%', overflowY:'auto', overflowX:'hidden', padding:'40px 48px 120px', color:'#e2e8f0', WebkitOverflowScrolling:'touch' }}
      >
        <div style={{ maxWidth:'960px', position:'relative' }}>
          {/* Ambient glow */}
          <div style={{ position:'absolute', top:'-40px', right:'10%', width:'220px', height:'220px', pointerEvents:'none', background:'radial-gradient(circle,rgba(139,92,246,0.10),rgba(139,92,246,0))', filter:'blur(2px)' }} />

          {/* Header */}
          <div style={{ marginBottom:'28px' }}>
            <div style={{ display:'inline-flex', alignItems:'center', gap:'8px', background:'rgba(139,92,246,0.12)', border:'1px solid rgba(139,92,246,0.30)', borderRadius:'99px', padding:'3px 10px', marginBottom:'14px', fontSize:'9px', fontWeight:700, letterSpacing:'0.14em', color:'#a78bfa', fontFamily:'var(--font-plex-mono)', boxShadow:'0 0 16px rgba(139,92,246,0.18)' }}>
              <span style={{ width:'6px', height:'6px', borderRadius:'50%', background:'#8b5cf6', boxShadow:'0 0 8px rgba(139,92,246,0.80)' }} />
              ELITE
            </div>
            <h1 style={{ fontSize:'28px', fontWeight:800, color:'#f8fafc', margin:'0 0 6px', letterSpacing:'-0.02em' }}>
              CORTEX Dev Control Map
            </h1>
            <p style={{ fontSize:'13px', color:'#64748b', margin:0 }}>
              {`Find deployer and linked wallets for ${chainLabel} tokens.`}
            </p>
          </div>

          {/* Input */}
          <div className="devmap-input-row" style={{ display:'flex', gap:'10px', maxWidth:'760px', marginBottom:'28px' }}>
            <select
              value={chain}
              onChange={e => setChain((e.target.value === 'eth' ? 'eth' : 'base'))}
              disabled={loading}
              style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.10)', borderRadius:'12px', padding:'0 12px', color:'#e2e8f0', fontSize:'14px', fontFamily:'var(--font-plex-mono)' }}
            >
              <option value="base">Base</option>
              <option value="eth">Ethereum</option>
            </select>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
              disabled={loading}
              placeholder={chain === 'eth' ? 'Paste Ethereum token contract' : 'Paste Base token contract'}
              style={{ flex:1, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.10)', borderRadius:'12px', padding:'14px 16px', color:'#e2e8f0', fontSize:'16px', outline:'none', fontFamily:'var(--font-plex-mono)', transition:'border-color 0.15s, box-shadow 0.15s' }}
              onFocus={e => { e.currentTarget.style.borderColor='rgba(139,92,246,0.55)'; e.currentTarget.style.boxShadow='0 0 0 3px rgba(139,92,246,0.15)' }}
              onBlur={e  => { e.currentTarget.style.borderColor='rgba(255,255,255,0.10)'; e.currentTarget.style.boxShadow='none' }}
            />
            <button
              onClick={handleScan}
              disabled={loading || !input.trim() || cooldownSecs > 0}
              style={{ padding:'14px 24px', borderRadius:'12px', background: loading || !input.trim() || cooldownSecs > 0 ? 'rgba(139,92,246,0.15)' : 'linear-gradient(135deg,#8b5cf6 0%,#7c3aed 55%,#4f46e5 100%)', border:'1px solid rgba(139,92,246,0.40)', color: loading || !input.trim() || cooldownSecs > 0 ? '#64748b' : '#fff', fontSize:'12px', fontWeight:700, letterSpacing:'0.08em', cursor: loading || !input.trim() || cooldownSecs > 0 ? 'not-allowed' : 'pointer', fontFamily:'var(--font-plex-mono)', whiteSpace:'nowrap', boxShadow: loading || !input.trim() || cooldownSecs > 0 ? 'none' : '0 8px 18px rgba(99,102,241,0.30)' }}
            >
              {loading ? (
                <span style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                  {[0,1,2].map(i => (
                    <span key={i} style={{ width:'5px', height:'5px', borderRadius:'50%', background:'#a78bfa', animation:'devDot 1.2s ease-in-out infinite', animationDelay:`${i*0.18}s` }} />
                  ))}
                </span>
              ) : cooldownSecs > 0 ? `WAIT ${cooldownSecs}s` : 'SCAN'}
            </button>
          </div>

          {/* Error */}
          {error && (
            <div style={{ padding:'12px 16px', borderRadius:'10px', background: cooldownSecs > 0 ? 'rgba(251,191,36,0.08)' : 'rgba(248,113,113,0.08)', border:`1px solid ${cooldownSecs > 0 ? 'rgba(251,191,36,0.25)' : 'rgba(248,113,113,0.20)'}`, color: cooldownSecs > 0 ? '#fbbf24' : '#f87171', fontSize:'13px', fontFamily:'var(--font-plex-mono)', marginBottom:'24px' }}>
              {cooldownSecs > 0 ? `Cooldown active — try again in ${cooldownSecs}s` : error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !result && !error && (
            <div style={{ textAlign:'center', padding:'60px 20px', color:'#3a5268', fontFamily:'var(--font-plex-mono)' }}>
              <div style={{ fontSize:'32px', opacity:0.3, marginBottom:'12px' }}>⬡</div>
              <p style={{ fontSize:'13px', margin:0 }}>{`Enter a ${chainLabel} token contract to map deployer wallet and dev control signals`}</p>
            </div>
          )}

          {/* Results */}
          {result && (() => {
            const dc = calculateDevControl(result)
            const rugCount = result.previousProjects.filter(p => p.rugFlag === true).length
            const resolvedTokenName = result.name || 'Unknown'
            const resolvedTokenSymbol = result.symbol || '?'
            const tokenTitle = resolvedTokenName !== 'Unknown' ? resolvedTokenName : shortAddr(result.contractAddress, 8, 6)
            const hasTokenTitleFallback = resolvedTokenName === 'Unknown' && resolvedTokenSymbol === '?'

            return (
              <div>
                {/* Token identity strip */}
                <div style={{ marginBottom:'18px' }}>
                  <h2 style={{ fontSize:'19px', fontWeight:700, color:'#f8fafc', margin:'0 0 3px' }}>
                    {tokenTitle}
                    {resolvedTokenSymbol && <span style={{ marginLeft:'10px', fontSize:'13px', color:'#a78bfa', fontFamily:'var(--font-plex-mono)' }}>{resolvedTokenSymbol}</span>}
                  </h2>
                  <p style={{ fontSize:'11px', color:'#3a5268', fontFamily:'var(--font-plex-mono)', margin:0 }}>
                    {shortAddr(result.contractAddress, 10, 8)} · {result.chain === 'eth' ? 'ETH' : 'BASE'}
                    {result.liquidity != null && <span style={{ marginLeft:'12px', color:'#475569' }}>Liq {fmtUsd(result.liquidity)}</span>}
                    {result.volume24h != null && <span style={{ marginLeft:'12px', color:'#475569' }}>Vol 24h {fmtUsd(result.volume24h)}</span>}
                    {result.holderCount != null && <span style={{ marginLeft:'12px', color:'#475569' }}>{result.holderCount.toLocaleString()} holders</span>}
                  </p>
                  {hasTokenTitleFallback && (
                    <p style={{ fontSize:'10px', color:'#64748b', fontFamily:'var(--font-plex-mono)', margin:'4px 0 0' }}>
                      Name unavailable from Token Scanner + metadata checks.
                    </p>
                  )}
                </div>

                {/* ── CORTEX Dev Control Hero ──────────────────────────────── */}
                <div style={{ marginBottom:'18px', background:'linear-gradient(160deg,rgba(8,16,32,.97),rgba(4,8,18,.95))', border:`1px solid ${dc.riskColor}28`, borderRadius:'18px', padding:'22px 24px', boxShadow:`0 0 44px ${dc.riskColor}0c` }}>
                  <div style={{ fontSize:'9px', letterSpacing:'.18em', color:'#3a5268', fontFamily:'var(--font-plex-mono)', marginBottom:'10px' }}>CORTEX DEV CONTROL READ</div>
                  <div style={{ display:'flex', alignItems:'flex-start', gap:'20px', flexWrap:'wrap', marginBottom:'16px' }}>
                    <div style={{ flexShrink:0 }}>
                      <div style={{ display:'flex', alignItems:'baseline', gap:'3px' }}>
                        <span style={{ fontSize:'48px', fontWeight:800, color:dc.riskColor, fontFamily:'var(--font-plex-mono)', lineHeight:1 }}>{dc.score}</span>
                        <span style={{ fontSize:'14px', color:`${dc.riskColor}50`, fontFamily:'var(--font-plex-mono)' }}>/100</span>
                      </div>
                    </div>
                    <div style={{ flex:1, minWidth:'140px', paddingTop:'4px' }}>
                      <div style={{ display:'flex', gap:'7px', flexWrap:'wrap', marginBottom:'12px' }}>
                        <span style={{ padding:'5px 16px', borderRadius:'999px', fontSize:'11px', fontWeight:800, letterSpacing:'0.10em', color:dc.riskColor, background:dc.riskBg, border:`1px solid ${dc.riskBorder}`, fontFamily:'var(--font-plex-mono)' }}>
                          {dc.risk === 'LOW' ? 'LOW RISK' : dc.risk === 'MEDIUM' ? 'MEDIUM RISK' : dc.risk === 'HIGH' ? 'HIGH RISK' : dc.risk === 'CRITICAL' ? 'CRITICAL' : 'UNKNOWN'}
                        </span>
                        <span style={{ padding:'5px 10px', borderRadius:'999px', fontSize:'9px', fontWeight:700, letterSpacing:'0.10em', color: dc.confidence === 'High' ? '#34d399' : dc.confidence === 'Medium' ? '#fbbf24' : '#94a3b8', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.12)', fontFamily:'var(--font-plex-mono)' }}>
                          {dc.confidence.toUpperCase()} CONFIDENCE
                        </span>
                      </div>
                      <div style={{ height:'5px', borderRadius:'999px', background:'rgba(255,255,255,0.06)', overflow:'hidden', marginBottom:'10px' }}>
                        <div style={{ height:'100%', width:`${dc.score}%`, borderRadius:'999px', background:`linear-gradient(90deg,${dc.riskColor},${dc.riskColor}80)`, transition:'width 0.7s ease' }} />
                      </div>
                      <p style={{ margin:0, fontSize:'11px', color:'#64748b', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{dc.summary}</p>
                    </div>
                  </div>
                  {/* 4 status chips */}
                  <div className="devmap-hero-grid" style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))', gap:'8px' }}>
                    {[
                      {
                        label: 'Deployer',
                        ok: !!result.deployerAddress,
                        partial: result.deployerStatus === 'possible_match',
                        value: result.deployerAddress ? (result.deployerStatus === 'confirmed' ? 'Confirmed' : 'Likely found') : 'Not confirmed',
                        color: result.deployerAddress ? '#34d399' : '#f87171',
                      },
                      {
                        label: 'Linked Wallets',
                        ok: result.linkedWallets.length === 0,
                        partial: result.linkedWallets.length > 0 && result.linkedWallets.length < 4,
                        value: result.linkedWallets.length === 0 ? 'None found' : `${result.linkedWallets.length} detected`,
                        color: result.linkedWallets.length === 0 ? '#34d399' : result.linkedWallets.length <= 3 ? '#fbbf24' : '#f87171',
                      },
                      {
                        label: 'Supply Control',
                        ok: result.supplyControlStatus === 'not_in_top_holders',
                        partial: result.supplyControlStatus === 'partial',
                        value: result.supplyControlStatus === 'not_in_top_holders' ? 'Not in top holders' : result.devClusterSupply != null ? `${result.devClusterSupply.toFixed(1)}% ctrl` : 'Unverified',
                        color: result.supplyControlStatus === 'not_in_top_holders' ? '#34d399' : result.devClusterSupply != null && result.devClusterSupply > 20 ? '#f87171' : '#fbbf24',
                      },
                      {
                        label: 'Patterns',
                        ok: !result.suspiciousTransfers,
                        partial: false,
                        value: result.suspiciousTransfers ? `${result.suspiciousTransferReasons.length} flag${result.suspiciousTransferReasons.length !== 1 ? 's' : ''}` : 'Clear',
                        color: result.suspiciousTransfers ? '#f87171' : '#34d399',
                      },
                    ].map(({ label, ok, partial, value, color }) => (
                      <div key={label} style={{ padding:'9px 11px', borderRadius:'10px', background:`${color}08`, border:`1px solid ${color}20`, display:'flex', alignItems:'center', gap:'8px' }}>
                        <StatusDot ok={ok} partial={partial} color={color} />
                        <div>
                          <div style={{ fontSize:'9px', letterSpacing:'.12em', color, fontFamily:'var(--font-plex-mono)', fontWeight:700 }}>{label}</div>
                          <div style={{ fontSize:'9px', color:'#3a5268', fontFamily:'var(--font-plex-mono)' }}>{value}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Warning banner */}
                <WarningBanner warnings={result.warnings} deployerStatus={result.deployerStatus} />

                {/* CORTEX Dev Control Command Bar */}
                <div style={{ display:'flex', gap:'3px', marginBottom:'20px', overflowX:'auto', paddingBottom:'6px', borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
                  {([
                    { id: 'dev-map'  as DevMapSection, label: 'Dev Map',        dot: '#a78bfa' },
                    { id: 'supply'   as DevMapSection, label: 'Supply Control', dot: '#34d399' },
                    { id: 'history'  as DevMapSection, label: 'History',        dot: '#67e8f9' },
                    { id: 'watch'    as DevMapSection, label: 'Watch Plan',     dot: '#fbbf24' },
                  ]).map(tab => {
                    const active = activeTab === tab.id
                    return (
                      <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ display:'inline-flex', alignItems:'center', gap:'6px', padding:'6px 13px', borderRadius:'8px', cursor:'pointer', whiteSpace:'nowrap', flexShrink:0, fontFamily:'var(--font-plex-mono)', fontSize:'10px', fontWeight: active ? 800 : 600, letterSpacing:'0.11em', background: active ? `linear-gradient(135deg,${tab.dot}16,rgba(139,92,246,0.10))` : 'transparent', border: active ? `1px solid ${tab.dot}40` : '1px solid transparent', color: active ? tab.dot : '#3a5268', boxShadow: active ? `0 0 14px ${tab.dot}14` : 'none' }}>
                        <span style={{ width:'5px', height:'5px', borderRadius:'50%', flexShrink:0, background: active ? tab.dot : '#1e3a44', boxShadow: active ? `0 0 6px ${tab.dot}` : 'none' }} />
                        {tab.label}
                      </button>
                    )
                  })}
                </div>

                {/* ── DEV MAP ─────────────────────────────────────────────── */}
                {activeTab === 'dev-map' && (() => {
                  const deployerLabel =
                    result.deployerStatus === 'confirmed'     ? 'Creator Wallet (Confirmed)' :
                    result.deployerStatus === 'possible_match'? 'Likely Origin Wallet'        :
                    'Origin Wallet'

                  return (
                    <>
                      {/* Visual flow */}
                      <GlassCard style={{ marginBottom:'14px' }}>
                        <p style={{ margin:'0 0 14px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#a78bfa', fontFamily:'var(--font-plex-mono)' }}>DEV CONTROL MAP</p>
                        <div className="devmap-flow" style={{ display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap' }}>
                          {/* Contract node */}
                          <div style={{ flex:'0 0 auto', padding:'10px 14px', borderRadius:'10px', background:'rgba(139,92,246,0.08)', border:'1px solid rgba(139,92,246,0.22)', minWidth:'120px' }}>
                            <div style={{ fontSize:'8px', color:'#a78bfa', fontFamily:'var(--font-plex-mono)', letterSpacing:'.12em', marginBottom:'3px' }}>TOKEN CONTRACT</div>
                            <div style={{ fontSize:'10px', color:'#c4b5fd', fontFamily:'var(--font-plex-mono)', wordBreak:'break-all' }}>{shortAddr(result.contractAddress, 6, 4)}</div>
                          </div>
                          <div className="devmap-flow-arrow" style={{ color:'#3a5268', fontSize:'14px', flexShrink:0 }}>→</div>
                          {/* Deployer node */}
                          <div style={{ flex:'0 0 auto', padding:'10px 14px', borderRadius:'10px', background: result.deployerAddress ? 'rgba(52,211,153,0.06)' : 'rgba(148,163,184,0.05)', border: result.deployerAddress ? '1px solid rgba(52,211,153,0.22)' : '1px solid rgba(148,163,184,0.16)', minWidth:'150px' }}>
                            <div style={{ fontSize:'8px', color: result.deployerAddress ? '#34d399' : '#3a5268', fontFamily:'var(--font-plex-mono)', letterSpacing:'.12em', marginBottom:'3px' }}>{deployerLabel.toUpperCase()}</div>
                            <div style={{ fontSize:'10px', color: result.deployerAddress ? '#86efac' : '#475569', fontFamily:'var(--font-plex-mono)', wordBreak:'break-all' }}>
                              {result.deployerAddress ? shortAddr(result.deployerAddress, 6, 4) : 'Not confirmed'}
                            </div>
                            {result.deployerStatus === 'confirmed' && <div style={{ fontSize:'8px', color:'#2DD4BF', marginTop:'3px', fontFamily:'var(--font-plex-mono)' }}>Creation record</div>}
                          </div>
                          {result.linkedWallets.length > 0 && <>
                            <div className="devmap-flow-arrow" style={{ color:'#3a5268', fontSize:'14px', flexShrink:0 }}>→</div>
                            <div style={{ flex:'0 0 auto', padding:'10px 14px', borderRadius:'10px', background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.22)', minWidth:'140px' }}>
                              <div style={{ fontSize:'8px', color:'#fbbf24', fontFamily:'var(--font-plex-mono)', letterSpacing:'.12em', marginBottom:'3px' }}>LINKED WALLETS</div>
                              <div style={{ fontSize:'13px', fontWeight:700, color:'#fde68a', fontFamily:'var(--font-plex-mono)' }}>{result.linkedWallets.length}</div>
                              <div style={{ fontSize:'8px', color:'#92400e', fontFamily:'var(--font-plex-mono)', marginTop:'2px' }}>
                                {result.linkedWallets.filter(w => w.overlapTopHolderRank != null).length > 0
                                  ? `${result.linkedWallets.filter(w => w.overlapTopHolderRank != null).length} in top holders`
                                  : 'No top-holder overlap'}
                              </div>
                            </div>
                          </>}
                          {result.matchedHolderWallets.length > 0 && <>
                            <div className="devmap-flow-arrow" style={{ color:'#3a5268', fontSize:'14px', flexShrink:0 }}>→</div>
                            <div style={{ flex:'0 0 auto', padding:'10px 14px', borderRadius:'10px', background:'rgba(167,139,250,0.06)', border:'1px solid rgba(167,139,250,0.22)', minWidth:'130px' }}>
                              <div style={{ fontSize:'8px', color:'#a78bfa', fontFamily:'var(--font-plex-mono)', letterSpacing:'.12em', marginBottom:'3px' }}>TOP HOLDER MATCH</div>
                              <div style={{ fontSize:'13px', fontWeight:700, color:'#c4b5fd', fontFamily:'var(--font-plex-mono)' }}>{result.matchedHolderWallets.length}</div>
                              <div style={{ fontSize:'8px', color:'#6d28d9', fontFamily:'var(--font-plex-mono)', marginTop:'2px' }}>wallet{result.matchedHolderWallets.length !== 1 ? 's' : ''} matched</div>
                            </div>
                          </>}
                        </div>
                        {result.linkedWallets.length === 0 && (
                          <div style={{ marginTop:'12px', padding:'8px 12px', borderRadius:'8px', background:'rgba(148,163,184,0.04)', border:'1px solid rgba(148,163,184,0.12)' }}>
                            <p style={{ margin:0, fontSize:'10px', color:'#475569', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>
                              No linked-wallet signal confirmed in the checked window. This does not prove no linked wallets exist — it means no relationship was confirmed from available transfer data.
                            </p>
                          </div>
                        )}
                      </GlassCard>

                      {/* Deployer wallet card */}
                      <GlassCard style={{ marginBottom:'14px' }}>
                        <p style={{ margin:'0 0 12px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#a78bfa', fontFamily:'var(--font-plex-mono)' }}>ORIGIN WALLET</p>
                        <DataRow label="Address" value={
                          result.deployerAddress
                            ? <div style={{ textAlign:'right' }}>
                                <span style={{ fontFamily:'var(--font-plex-mono)', color:'#c4b5fd', display:'block' }}>{shortAddr(result.deployerAddress)}</span>
                                <span style={{ fontFamily:'var(--font-plex-mono)', color:'#64748b', fontSize:'10px' }}>{result.deployerAddress}</span>
                              </div>
                            : <span style={{ color:'#3a5268' }}>Not confirmed</span>
                        } />
                        <DataRow label="Status" value={
                          result.deployerStatus === 'confirmed'
                            ? <span style={{ color:'#2DD4BF' }}>Creator confirmed</span>
                            : result.deployerStatus === 'possible_match'
                              ? <span style={{ color:'#fbbf24' }}>Likely origin wallet</span>
                              : <span style={{ color:'#64748b' }}>Not confirmed from current checks</span>
                        } />
                        <DataRow label="Detection" value={formatMethod(result.methodUsed)} />
                        <DataRow label="Chain" value={result.chain === 'eth' ? 'Ethereum' : 'Base'} />
                        <DataRow label="Scanned" value={fmtDate(result.fetchedAt)} />
                        {result.deployerAddress && (
                          <div style={{ marginTop:'14px', display:'flex', gap:'8px', flexWrap:'wrap' }}>
                            <button
                              onClick={async () => { await navigator.clipboard.writeText(result.deployerAddress ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1400) }}
                              style={{ display:'inline-flex', alignItems:'center', gap:'5px', padding:'6px 12px', borderRadius:'8px', fontSize:'11px', fontWeight:600, cursor:'pointer', color: copied ? '#2DD4BF' : '#94a3b8', background:'rgba(148,163,184,0.10)', border:'1px solid rgba(148,163,184,0.25)', fontFamily:'var(--font-plex-mono)' }}
                            >
                              {copied ? 'Copied' : 'Copy'}
                            </button>
                            <a href={`${explorerBase}/address/${result.deployerAddress}`} target="_blank" rel="noopener noreferrer" style={{ display:'inline-flex', alignItems:'center', gap:'5px', padding:'6px 12px', borderRadius:'8px', textDecoration:'none', fontSize:'11px', fontWeight:600, color:'#a78bfa', background:'rgba(139,92,246,0.08)', border:'1px solid rgba(139,92,246,0.20)', fontFamily:'var(--font-plex-mono)' }}>
                              ↗ Explorer
                            </a>
                            <button
                              onClick={() => setIsTracking(v => !v)}
                              style={{ display:'inline-flex', alignItems:'center', gap:'5px', padding:'6px 12px', borderRadius:'8px', fontSize:'11px', fontWeight:600, cursor:'pointer', color: isTracking ? '#2DD4BF' : '#fbbf24', background: isTracking ? 'rgba(45,212,191,0.10)' : 'rgba(251,191,36,0.10)', border:`1px solid ${isTracking ? 'rgba(45,212,191,0.25)' : 'rgba(251,191,36,0.25)'}`, fontFamily:'var(--font-plex-mono)' }}
                            >
                              {isTracking ? 'Tracking' : 'Track Deployer'}
                            </button>
                          </div>
                        )}
                      </GlassCard>

                      {/* Linked wallets grid */}
                      <GlassCard style={{ marginBottom:'14px' }}>
                        <p style={{ margin:'0 0 12px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#fbbf24', fontFamily:'var(--font-plex-mono)' }}>
                          LINKED WALLETS {result.linkedWallets.length > 0 ? `(${result.linkedWallets.length})` : ''}
                        </p>
                        {result.linkedWallets.length === 0 ? (
                          <div>
                            <p style={{ fontSize:'11px', color:'#3a5268', fontFamily:'var(--font-plex-mono)', margin:'0 0 6px' }}>
                              {result.linkedWalletsStatus === 'none_found'
                                ? 'No outgoing transfers found from the origin wallet in the checked window.'
                                : result.linkedWalletsStatus === 'skipped'
                                  ? 'Linked wallet check skipped — no origin address identified.'
                                  : 'No linked-wallet signal in checked window.'}
                            </p>
                            <p style={{ fontSize:'10px', color:'#1e3a44', fontFamily:'var(--font-plex-mono)', margin:0 }}>
                              This does not confirm the absence of linked wallets — it means no transfer relationship was found in available data.
                            </p>
                          </div>
                        ) : (
                          <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
                            {result.linkedWallets.map((w, i) => {
                              const confBadge = w.confidence ? CONF_BADGE[w.confidence] : null
                              return (
                                <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr auto auto auto', gap:'12px', alignItems:'center', padding:'10px 14px', background: w.confidence === 'high' ? 'rgba(45,212,191,0.03)' : 'rgba(255,255,255,0.02)', border:`1px solid ${w.confidence === 'high' ? 'rgba(45,212,191,0.14)' : 'rgba(255,255,255,0.07)'}`, borderRadius:'10px', fontSize:'11px', fontFamily:'var(--font-plex-mono)' }}>
                                  <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:'6px' }}>
                                    <span style={{ color:'#c4b5fd' }}>{shortAddr(w.address)}</span>
                                    <span style={{ color:'#64748b', fontSize:'9px', border:'1px solid rgba(255,255,255,0.10)', borderRadius:'99px', padding:'1px 6px' }}>{linkedWalletTag(w)}</span>
                                    {confBadge && <span style={{ fontSize:'9px', fontWeight:700, color:confBadge.color, background:confBadge.bg, border:`1px solid ${confBadge.border}`, borderRadius:'99px', padding:'1px 6px' }}>{confBadge.label}</span>}
                                    {w.overlapTopHolderRank != null && (
                                      <span style={{ fontSize:'9px', color:'#a78bfa', background:'rgba(139,92,246,0.10)', border:'1px solid rgba(139,92,246,0.25)', borderRadius:'99px', padding:'1px 6px' }}>
                                        Top holder #{w.overlapTopHolderRank}{w.overlapTopHolderPercent != null ? ` · ${parseFloat(w.overlapTopHolderPercent.toFixed(2))}%` : ''}
                                      </span>
                                    )}
                                    {w.firstSeen && <span style={{ color:'#3a5268' }}>{fmtDate(w.firstSeen)}</span>}
                                  </div>
                                  <span style={{ color:'#e2e8f0', fontWeight:600 }}>{fmtAmount(w.amountReceived, w.asset)}</span>
                                  <span style={{ color:'#64748b', fontSize:'10px' }}>{w.txHash ? shortHash(w.txHash) : '—'}</span>
                                  {w.txHash
                                    ? <a href={`${explorerBase}/tx/${w.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color:'#3a5268', textDecoration:'none', fontSize:'10px' }}>↗</a>
                                    : <span />
                                  }
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </GlassCard>

                      {/* Clark Verdict */}
                      {result.clarkVerdict ? (() => {
                        const cv = result.clarkVerdict
                        const vs = VERDICT_STYLE[cv.label]
                        const shortSummary = extractReadSummary(cv.summary)
                        return (
                          <GlassCard style={{ borderColor: vs.border, background: vs.bg, position:'relative', overflow:'hidden' }}>
                            <div style={{ position:'absolute', top:0, left:0, right:0, height:'2px', background:vs.color }} />
                            <div style={{ display:'flex', gap:'8px', alignItems:'center', marginBottom:'12px', flexWrap:'wrap' }}>
                              <span style={{ fontSize:'9px', fontWeight:700, letterSpacing:'0.14em', color:'#a78bfa', textTransform:'uppercase', fontFamily:'var(--font-plex-mono)' }}>CORTEX DEV CONTROL READ</span>
                              <span style={{ padding:'3px 10px', borderRadius:'99px', fontSize:'10px', fontWeight:700, color:vs.color, border:`1px solid ${vs.border}`, background:'rgba(0,0,0,0.22)', fontFamily:'var(--font-plex-mono)' }}>{cv.label}</span>
                              <span style={{ padding:'3px 9px', borderRadius:'99px', fontSize:'9px', color: CONF_COLOR[cv.confidence] ?? '#94a3b8', border:'1px solid rgba(255,255,255,0.14)', background:'rgba(255,255,255,0.03)', fontFamily:'var(--font-plex-mono)' }}>{cv.confidence} confidence</span>
                              <Link href={askClarkHref} style={{ marginLeft:'auto', display:'inline-flex', alignItems:'center', padding:'5px 10px', borderRadius:'8px', textDecoration:'none', color:'#a78bfa', border:'1px solid rgba(167,139,250,0.35)', background:'rgba(167,139,250,0.10)', fontSize:'10px', fontWeight:700, fontFamily:'var(--font-plex-mono)', whiteSpace:'nowrap' }}>
                                Ask Clark
                              </Link>
                            </div>
                            <p style={{ fontSize:'12px', color:'#e2e8f0', lineHeight:1.6, margin:'0 0 12px' }}>{shortSummary}</p>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'14px', marginBottom:'12px' }}>
                              {cv.keySignals.length > 0 && (
                                <div>
                                  <p style={{ fontSize:'9px', fontWeight:700, color:'#3a5268', textTransform:'uppercase', letterSpacing:'0.12em', fontFamily:'var(--font-plex-mono)', margin:'0 0 5px' }}>Key Signals</p>
                                  {cv.keySignals.slice(0, 3).map((s, i) => <p key={i} style={{ fontSize:'11px', color:'#94a3b8', margin:'3px 0' }}>· {s}</p>)}
                                </div>
                              )}
                              {cv.risks.length > 0 && (
                                <div>
                                  <p style={{ fontSize:'9px', fontWeight:700, color:'#3a5268', textTransform:'uppercase', letterSpacing:'0.12em', fontFamily:'var(--font-plex-mono)', margin:'0 0 5px' }}>Risks</p>
                                  {cv.risks.slice(0, 3).map((r, i) => <p key={i} style={{ fontSize:'11px', color:'#f87171', margin:'3px 0' }}>· {r}</p>)}
                                </div>
                              )}
                            </div>
                            <div style={{ borderTop:'1px solid rgba(255,255,255,0.08)', paddingTop:'10px', fontSize:'11px', color:'#64748b', fontFamily:'var(--font-plex-mono)' }}>
                              Next: {cv.nextAction}
                            </div>
                          </GlassCard>
                        )
                      })() : (
                        <GlassCard>
                          <p style={{ fontSize:'11px', color:'#3a5268', fontFamily:'var(--font-plex-mono)', margin:0 }}>
                            Full CORTEX dev-wallet analysis is included in Pro and Elite.{' '}
                            <a href="/pricing" style={{ color:'#a78bfa', textDecoration:'none' }}>Upgrade</a> to unlock Clark verdict and full dev-control intelligence.
                          </p>
                        </GlassCard>
                      )}
                    </>
                  )
                })()}

                {/* ── SUPPLY CONTROL ──────────────────────────────────────── */}
                {activeTab === 'supply' && (() => {
                  const usableHolders =
                    result.holderDistributionStatus === 'ok' ||
                    result.holderDistributionStatus === 'partial'

                  // All supply variables computed from scanner holderDistribution fields when usable.
                  // When not usable, every field stays null and the UI renders "Open check".
                  let top1: number | null = null
                  let top10: number | null = null
                  let top20: number | null = null
                  let topHolders: Array<{ address?: string; percent?: number | null }> = []
                  let linkedSupply: number | null = null
                  let devClusterSupply: number | null = null
                  let creatorInTopHolders: boolean = false

                  if (usableHolders) {
                    top1 = result.holderDistribution?.top1 ?? null
                    top10 = result.holderDistribution?.top10 ?? null
                    top20 = result.holderDistribution?.top20 ?? null
                    topHolders = result.holderDistribution?.topHolders ?? []
                    const linkedAddrs = new Set(result.linkedWallets.map(w => w.address.toLowerCase()))
                    const linkedTopHolders = topHolders.filter(h => h.address && linkedAddrs.has(h.address.toLowerCase()))
                    linkedSupply = linkedTopHolders.length > 0
                      ? linkedTopHolders.reduce((s, h) => s + (h.percent ?? 0), 0)
                      : (result.linkedWalletSupply ?? null)
                    devClusterSupply = result.devClusterSupply ?? null
                    creatorInTopHolders = result.deployerAddress
                      ? (topHolders.some(h => h.address?.toLowerCase() === result.deployerAddress?.toLowerCase()) ||
                         result.matchedHolderWallets.some(h => h.isDeployer))
                      : false
                  }

                  const openCheck = <span style={{ color:'#94a3b8' }}>Open check — holder data unavailable after scan.</span>
                  const isEstimated = result.holderPercentSource === 'calculated'
                  const partialLabel = isEstimated
                    ? 'Partial estimate — derived from raw balances.'
                    : 'Partial — holder rows found, supply % unavailable.'
                  const supplyBarPct = devClusterSupply != null ? Math.min(devClusterSupply, 100) : null
                  const supplyBarColor = supplyBarPct != null ? (supplyBarPct > 50 ? '#f87171' : supplyBarPct > 20 ? '#fbbf24' : '#34d399') : '#3a5268'

                  const topHolderNote: string | null =
                    !usableHolders && result.deployerAddress
                      ? 'Origin wallet was likely found, but holder distribution could not confirm supply control.'
                      : result.supplyControlStatus === 'not_in_top_holders'
                      ? 'Creator wallet is not in the top-holder set. Supply concentration remains an open risk check since linked wallets are not fully verified.'
                      : result.supplyControlStatus === 'needs_confirmed_creator'
                        ? 'Creator-linked supply control cannot be confirmed — no verified creator address available.'
                        : devClusterSupply != null && devClusterSupply > 20
                          ? `Developer-linked supply detected at ${devClusterSupply.toFixed(1)}% — monitor for exit or concentration risk.`
                          : result.matchedHolderWallets.length > 0
                            ? `${result.matchedHolderWallets.length} creator/linked wallet${result.matchedHolderWallets.length !== 1 ? 's' : ''} found in top holders.`
                            : null

                  return (
                    <>
                      <GlassCard style={{ marginBottom:'14px' }}>
                        <p style={{ margin:'0 0 12px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#34d399', fontFamily:'var(--font-plex-mono)' }}>SUPPLY CONTROL SURFACE</p>
                        <DataRow label="Creator in top holders" value={
                          !usableHolders
                            ? openCheck
                            : !result.deployerAddress
                            ? <span style={{ color:'#94a3b8' }}>Open check — creator not confirmed from current checks.</span>
                            : creatorInTopHolders
                              ? <span style={{ color:'#f87171' }}>Confirmed — creator appears in top holders.</span>
                              : <span style={{ color:'#34d399' }}>Not detected</span>
                        } />
                        <DataRow label="Top 1 concentration"  value={!usableHolders ? openCheck : top1  != null ? <>{top1.toFixed(2)}%{isEstimated && <span style={{fontSize:'9px',color:'#fbbf24',marginLeft:'6px'}}>est</span>}</> : partialLabel} valueStyle={{ color: top1 != null && top1 > 15 ? '#f87171' : '#e2e8f0' }} />
                        <DataRow label="Top 10 concentration" value={!usableHolders ? openCheck : top10 != null ? <>{top10.toFixed(2)}%{isEstimated && <span style={{fontSize:'9px',color:'#fbbf24',marginLeft:'6px'}}>est</span>}</> : partialLabel} valueStyle={{ color: top10 != null && top10 > 50 ? '#f87171' : top10 != null && top10 > 30 ? '#fbbf24' : '#e2e8f0' }} />
                        <DataRow label="Top 20 concentration" value={!usableHolders ? openCheck : top20 != null ? <>{top20.toFixed(2)}%{isEstimated && <span style={{fontSize:'9px',color:'#fbbf24',marginLeft:'6px'}}>est</span>}</> : partialLabel} valueStyle={{ color: top20 != null && top20 > 70 ? '#f87171' : '#e2e8f0' }} />
                        <DataRow label="Linked-wallet supply" value={!usableHolders ? openCheck : linkedSupply != null && linkedSupply > 0 ? `${linkedSupply.toFixed(1)}%` : 'Needs holder confirmation.'} valueStyle={{ color: linkedSupply != null && linkedSupply > 20 ? '#f87171' : '#e2e8f0' }} />
                        <DataRow label="Dev cluster supply"   value={!usableHolders ? openCheck : devClusterSupply != null ? `${devClusterSupply.toFixed(1)}%` : 'Needs holder confirmation.'} />

                        {supplyBarPct != null && (
                          <div style={{ marginTop:'14px' }}>
                            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'6px' }}>
                              <span style={{ fontSize:'11px', color:'#64748b', fontFamily:'var(--font-plex-mono)' }}>Deployer + linked wallet supply</span>
                              <span style={{ fontSize:'11px', fontWeight:700, color:supplyBarColor, fontFamily:'var(--font-plex-mono)' }}>{supplyBarPct.toFixed(1)}%</span>
                            </div>
                            <div style={{ height:'6px', borderRadius:'99px', background:'rgba(255,255,255,0.06)', overflow:'hidden' }}>
                              <div style={{ height:'100%', borderRadius:'99px', width:`${supplyBarPct}%`, background:supplyBarColor, transition:'width 0.6s ease' }} />
                            </div>
                          </div>
                        )}

                        {topHolderNote && (
                          <div style={{ marginTop:'14px', padding:'10px 12px', borderRadius:'8px', background:'rgba(148,163,184,0.05)', border:'1px solid rgba(148,163,184,0.14)' }}>
                            <p style={{ margin:0, fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>{topHolderNote}</p>
                          </div>
                        )}
                      </GlassCard>

                      {/* Matched holder wallets */}
                      {result.matchedHolderWallets.length > 0 && (
                        <GlassCard style={{ marginBottom:'14px' }}>
                          <p style={{ margin:'0 0 12px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#a78bfa', fontFamily:'var(--font-plex-mono)' }}>MATCHED HOLDER WALLETS</p>
                          <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
                            {result.matchedHolderWallets.map((h, i) => (
                              <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 12px', background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:'8px', fontSize:'11px', fontFamily:'var(--font-plex-mono)' }}>
                                <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                                  <span style={{ color:'#64748b' }}>{shortAddr(h.address)}</span>
                                  {h.isDeployer && <span style={{ padding:'1px 6px', borderRadius:'99px', fontSize:'9px', color:'#a78bfa', background:'rgba(139,92,246,0.12)', border:'1px solid rgba(139,92,246,0.25)' }}>DEPLOYER</span>}
                                  {h.isLinked && !h.isDeployer && <span style={{ padding:'1px 6px', borderRadius:'99px', fontSize:'9px', color:'#fbbf24', background:'rgba(251,191,36,0.10)', border:'1px solid rgba(251,191,36,0.20)' }}>LINKED</span>}
                                </div>
                                <span style={{ color: h.supplyPct > 20 ? '#f87171' : '#e2e8f0', fontWeight:600 }}>{h.supplyPct.toFixed(2)}%</span>
                              </div>
                            ))}
                          </div>
                        </GlassCard>
                      )}

                      {/* Transfer analysis */}
                      <GlassCard>
                        <p style={{ margin:'0 0 12px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color: result.suspiciousTransfers ? '#f87171' : '#34d399', fontFamily:'var(--font-plex-mono)' }}>TRANSFER ANALYSIS</p>
                        {result.suspiciousTransfers ? (
                          <>
                            <div style={{ display:'flex', gap:'8px', alignItems:'center', marginBottom:'10px' }}>
                              <span style={{ width:'7px', height:'7px', borderRadius:'50%', background:'#f87171', boxShadow:'0 0 6px #f87171', flexShrink:0 }} />
                              <span style={{ fontSize:'11px', fontWeight:700, color:'#f87171', fontFamily:'var(--font-plex-mono)', letterSpacing:'0.08em' }}>Suspicious patterns detected</span>
                            </div>
                            {result.suspiciousTransferReasons.map((r, i) => (
                              <p key={i} style={{ fontSize:'11px', color:'#fca5a5', margin:'4px 0', fontFamily:'var(--font-plex-mono)' }}>· {r}</p>
                            ))}
                          </>
                        ) : (
                          <div style={{ display:'flex', gap:'8px', alignItems:'center' }}>
                            <span style={{ width:'7px', height:'7px', borderRadius:'50%', background:'#34d399', boxShadow:'0 0 6px #34d399', flexShrink:0 }} />
                            <span style={{ fontSize:'11px', color:'#34d399', fontFamily:'var(--font-plex-mono)' }}>No suspicious transfer pattern detected from available data.</span>
                          </div>
                        )}
                      </GlassCard>
                    </>
                  )
                })()}

                {/* ── HISTORY ──────────────────────────────────────────────── */}
                {activeTab === 'history' && (() => {
                  // Investigation timeline signals
                  type TimelineItem = { label: string; status: 'confirmed' | 'not_found' | 'flagged' | 'partial' | 'unknown' }
                  const timeline: TimelineItem[] = [
                    {
                      label: 'Origin wallet detected',
                      status: result.deployerAddress ? (result.deployerStatus === 'confirmed' ? 'confirmed' : 'partial') : 'not_found',
                    },
                    {
                      label: 'Linked wallets confirmed',
                      status: result.linkedWallets.length > 0 ? 'partial' : result.linkedWalletsStatus === 'none_found' ? 'not_found' : result.linkedWalletsStatus === 'skipped' ? 'unknown' : 'not_found',
                    },
                    {
                      label: 'Suspicious transfer pattern',
                      status: result.suspiciousTransfers ? 'flagged' : result.deployerAddress ? 'not_found' : 'unknown',
                    },
                    {
                      label: 'Creator top-holder overlap',
                      status: result.matchedHolderWallets.some(h => h.isDeployer) ? 'flagged' : result.supplyControlStatus === 'not_in_top_holders' ? 'not_found' : result.supplyControlStatus === 'needs_confirmed_creator' ? 'unknown' : 'not_found',
                    },
                    {
                      label: 'Prior deployments confirmed',
                      status: rugCount > 0 ? 'flagged' : result.previousProjects.length > 0 ? 'partial' : result.previousActivityStatus === 'none_found' ? 'not_found' : result.previousActivityStatus === 'skipped' ? 'unknown' : 'not_found',
                    },
                  ]

                  const statusIcon = (s: TimelineItem['status']) =>
                    s === 'confirmed' ? '✓' : s === 'not_found' ? '○' : s === 'flagged' ? '⚠' : s === 'partial' ? '◐' : '–'
                  const statusColor = (s: TimelineItem['status']) =>
                    s === 'confirmed' ? '#34d399' : s === 'not_found' ? '#3a5268' : s === 'flagged' ? '#f87171' : s === 'partial' ? '#fbbf24' : '#475569'
                  const statusLabel = (s: TimelineItem['status']) =>
                    s === 'confirmed' ? 'Confirmed' : s === 'not_found' ? 'Not found' : s === 'flagged' ? 'Flagged' : s === 'partial' ? 'Partial' : 'No signal'

                  return (
                    <>
                      <GlassCard style={{ marginBottom:'14px' }}>
                        <p style={{ margin:'0 0 14px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#67e8f9', fontFamily:'var(--font-plex-mono)' }}>INVESTIGATION TIMELINE</p>
                        <div style={{ display:'flex', flexDirection:'column', gap:'0' }}>
                          {timeline.map((item, i) => {
                            const ic = statusColor(item.status)
                            return (
                              <div key={i} style={{ display:'flex', gap:'14px', alignItems:'flex-start', paddingBottom: i < timeline.length - 1 ? '14px' : '0', position:'relative' }}>
                                {i < timeline.length - 1 && (
                                  <div style={{ position:'absolute', left:'8px', top:'20px', bottom:'0', width:'1px', background:'rgba(255,255,255,0.06)' }} />
                                )}
                                <div style={{ flexShrink:0, width:'18px', height:'18px', borderRadius:'50%', border:`1px solid ${ic}40`, background:`${ic}12`, display:'flex', alignItems:'center', justifyContent:'center', marginTop:'1px' }}>
                                  <span style={{ fontSize:'9px', color:ic }}>{statusIcon(item.status)}</span>
                                </div>
                                <div style={{ flex:1 }}>
                                  <div style={{ display:'flex', gap:'8px', alignItems:'center', flexWrap:'wrap' }}>
                                    <span style={{ fontSize:'11px', color:'#cbd5e1', fontFamily:'var(--font-plex-mono)' }}>{item.label}</span>
                                    <span style={{ fontSize:'9px', fontWeight:700, color:ic, background:`${ic}10`, border:`1px solid ${ic}30`, borderRadius:'99px', padding:'1px 7px', fontFamily:'var(--font-plex-mono)' }}>{statusLabel(item.status)}</span>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </GlassCard>

                      {/* Previous projects / Launch history */}
                      <GlassCard>
                        <p style={{ margin:'0 0 14px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#67e8f9', fontFamily:'var(--font-plex-mono)' }}>LAUNCH HISTORY</p>
                        {!result.previousActivityAvailable && result.previousActivityStatus !== 'limited_check' ? (
                          <div>
                            <p style={{ fontSize:'11px', color:'#3a5268', fontFamily:'var(--font-plex-mono)', margin:'0 0 4px' }}>
                              {result.previousActivityStatus === 'skipped'
                                ? 'Previous activity check requires a confirmed creator address.'
                                : 'No prior deployment data available from current checks.'}
                            </p>
                            <p style={{ fontSize:'10px', color:'#1e3a44', fontFamily:'var(--font-plex-mono)', margin:0 }}>
                              This does not confirm a clean history — it means no prior activity was found in the checked window.
                            </p>
                          </div>
                        ) : result.previousProjects.length === 0 ? (
                          <div>
                            <p style={{ fontSize:'11px', color:'#3a5268', fontFamily:'var(--font-plex-mono)', margin:'0 0 4px' }}>
                              {result.previousActivityStatus === 'none_found'
                                ? 'No previous contract deployments found for this wallet in the checked window.'
                                : result.previousActivityStatus === 'limited_check'
                                  ? 'No prior activity detected — history check used token transfer data only.'
                                  : 'No prior activity detected from available transfer history.'}
                            </p>
                            <p style={{ fontSize:'10px', color:'#1e3a44', fontFamily:'var(--font-plex-mono)', margin:0 }}>
                              This does not confirm a clean history — it means no prior activity was found in the available data window.
                            </p>
                          </div>
                        ) : (
                          <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
                            {(showAllProj ? result.previousProjects : result.previousProjects.slice(0, 6)).map((p, i) => (
                              <div key={i} style={{ padding:'12px 14px', borderRadius:'10px', background:'rgba(255,255,255,0.02)', border:`1px solid ${p.rugFlag === true ? 'rgba(248,113,113,0.22)' : 'rgba(255,255,255,0.07)'}` }}>
                                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'12px' }}>
                                  <div style={{ flex:1 }}>
                                    <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'3px', flexWrap:'wrap' }}>
                                      <span style={{ fontSize:'11px', color:'#c4b5fd', fontFamily:'var(--font-plex-mono)' }}>
                                        {p.name && p.symbol ? `${p.name} (${p.symbol})` : shortAddr(p.contractAddress)}
                                      </span>
                                      <span style={{ fontSize:'9px', color:'#64748b', border:'1px solid rgba(255,255,255,0.10)', borderRadius:'99px', padding:'1px 6px', fontFamily:'var(--font-plex-mono)' }}>
                                        {result.previousActivityStatus === 'ok' ? 'Deployed contract' : p.symbol ? 'Token interaction' : 'Prior activity'}
                                      </span>
                                    </div>
                                    <p style={{ fontSize:'9px', color:'#3a5268', fontFamily:'var(--font-plex-mono)', margin:'0 0 2px' }}>
                                      {p.contractAddress}
                                    </p>
                                    {!p.name && !p.symbol && (
                                      <p style={{ fontSize:'9px', color:'#1e3a44', fontFamily:'var(--font-plex-mono)', margin:'4px 0 0' }}>
                                        Token metadata not available in checked data.
                                      </p>
                                    )}
                                    {p.rugReason && <p style={{ fontSize:'11px', color:'#f87171', margin:'5px 0 0', fontFamily:'var(--font-plex-mono)' }}>· {p.rugReason}</p>}
                                  </div>
                                  <span style={{ padding:'3px 10px', borderRadius:'99px', fontSize:'9px', fontWeight:700, letterSpacing:'0.10em', fontFamily:'var(--font-plex-mono)', flexShrink:0, color: p.rugFlag === true ? '#f87171' : p.rugFlag === false ? '#2DD4BF' : '#94a3b8', background: p.rugFlag === true ? 'rgba(248,113,113,0.10)' : p.rugFlag === false ? 'rgba(45,212,191,0.08)' : 'rgba(148,163,184,0.08)', border: `1px solid ${p.rugFlag === true ? 'rgba(248,113,113,0.25)' : p.rugFlag === false ? 'rgba(45,212,191,0.20)' : 'rgba(148,163,184,0.20)'}` }}>
                                    {p.rugFlag === true ? 'Flagged' : p.rugFlag === false ? 'Checked' : 'No signal'}
                                  </span>
                                </div>
                              </div>
                            ))}
                            {result.previousProjects.length > 6 && (
                              <button onClick={() => setShowAllProj(v => !v)} style={{ alignSelf:'flex-start', padding:'6px 10px', borderRadius:'8px', cursor:'pointer', color:'#a78bfa', background:'rgba(167,139,250,0.08)', border:'1px solid rgba(167,139,250,0.24)', fontSize:'11px', fontFamily:'var(--font-plex-mono)' }}>
                                {showAllProj ? 'Show less' : `Show more (${result.previousProjects.length - 6})`}
                              </button>
                            )}
                          </div>
                        )}
                      </GlassCard>
                    </>
                  )
                })()}

                {/* ── WATCH PLAN ───────────────────────────────────────────── */}
                {activeTab === 'watch' && (
                  <>
                    <GlassCard style={{ marginBottom:'14px' }}>
                      <p style={{ margin:'0 0 14px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#fbbf24', fontFamily:'var(--font-plex-mono)' }}>WHAT WOULD MAKE THIS RISKY?</p>
                      <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
                        {[
                          { trigger:'Deployer wallet receives token allocation', icon:'⚠' },
                          { trigger:'Deployer sends to fresh/unfunded wallets', icon:'⚠' },
                          { trigger:'Linked wallet enters or climbs the top-holder list', icon:'⚠' },
                          { trigger:'LP control changes — lock removed or pool withdrawn', icon:'⚠' },
                          { trigger:'New contract appears from same origin wallet', icon:'⚠' },
                          { trigger:'Top-holder concentration increases after launch', icon:'⚠' },
                          { trigger:'Multiple linked wallets sell in coordinated pattern', icon:'⚠' },
                        ].map((t, i) => (
                          <div key={i} style={{ display:'flex', gap:'10px', alignItems:'flex-start', padding:'9px 12px', borderRadius:'9px', background:'rgba(251,191,36,0.04)', border:'1px solid rgba(251,191,36,0.12)' }}>
                            <span style={{ color:'#fbbf24', fontSize:'12px', flexShrink:0, lineHeight:'16px' }}>{t.icon}</span>
                            <p style={{ margin:0, fontSize:'11px', color:'#fde68a', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{t.trigger}</p>
                          </div>
                        ))}
                      </div>
                    </GlassCard>

                    <GlassCard style={{ marginBottom:'14px' }}>
                      <p style={{ margin:'0 0 14px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#67e8f9', fontFamily:'var(--font-plex-mono)' }}>RESCAN TRIGGERS</p>
                      <p style={{ margin:'0 0 10px', fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.6 }}>
                        Rescan after any of the following occur:
                      </p>
                      {[
                        'Major volume spike or liquidity change',
                        'Top-holder movement — new wallets entering or exiting',
                        'Deployer wallet shows new on-chain activity',
                        'Price action inconsistent with volume (pump with no organic buy pressure)',
                        'New linked wallets appear in token transfer history',
                      ].map((r, i) => (
                        <div key={i} style={{ display:'flex', gap:'8px', alignItems:'flex-start', marginBottom:'6px' }}>
                          <span style={{ color:'#67e8f9', fontSize:'10px', flexShrink:0, lineHeight:'16px' }}>→</span>
                          <p style={{ margin:0, fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{r}</p>
                        </div>
                      ))}
                    </GlassCard>

                    <GlassCard>
                      <p style={{ margin:'0 0 10px', fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#fbbf24', fontFamily:'var(--font-plex-mono)' }}>WHAT TO MONITOR</p>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:'8px' }}>
                        {[
                          { label:'Deployer wallet',       note:'Watch for new transfers or token receipts' },
                          { label:'Linked wallet movement', note:'Monitor for sudden entries into top holders' },
                          { label:'Supply concentration',  note:'Check if top holders shift after volume' },
                          { label:'LP control',            note:'Verify lock remains in place' },
                          { label:'Origin cluster',        note:'Check for new contract deployments' },
                          { label:'Holder count trend',    note:'Rising holders + stable supply = healthier signal' },
                        ].map((m, i) => (
                          <div key={i} style={{ padding:'10px 12px', borderRadius:'10px', background:'rgba(251,191,36,0.04)', border:'1px solid rgba(251,191,36,0.12)' }}>
                            <div style={{ fontSize:'10px', fontWeight:700, color:'#fde68a', fontFamily:'var(--font-plex-mono)', marginBottom:'4px' }}>{m.label}</div>
                            <div style={{ fontSize:'10px', color:'#64748b', fontFamily:'var(--font-plex-mono)', lineHeight:1.45 }}>{m.note}</div>
                          </div>
                        ))}
                      </div>
                    </GlassCard>
                  </>
                )}

              </div>
            )
          })()}
        </div>
      </div>
    </>
  )
}
