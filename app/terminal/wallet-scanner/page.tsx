'use client'

import { useState } from 'react'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

// ── Types ────────────────────────────────────────────────────────────────────────────

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

type WalletBehavior = {
  status: 'ok' | 'partial' | 'unavailable'
  source: 'activity_layer' | 'unavailable'
  txCount: number | null
  activeDays: number | null
  topTokens: string[]
  topContracts: string[]
  inboundCount: number | null
  outboundCount: number | null
  stablecoinActivity: boolean
  recentActivitySummary: string
  reason: string
}

type ClarkVerdict = {
  verdict: string
  confidence: string
  read: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

type WalletTier = 'Smart Money' | 'Positive Early Read' | 'Average Trader' | 'Losing Wallet' | 'Open Check'
type WalletIntelStatus = 'ok' | 'partial' | 'open_check'
type WalletConfidence = 'high' | 'medium' | 'low' | 'open check'

type WalletRecentTrade = {
  token: string
  entry: number | null
  exit: number | null
  pnl: number | null
  holdTime: string | null
  size: number | null
  status: 'closed' | 'open' | 'unavailable' | string
}

type WalletIntelligence = {
  status: WalletIntelStatus
  confidence: WalletConfidence
  walletScore: number | null
  walletTier: WalletTier
  winRate: number | null
  lossRate: number | null
  pnl: {
    total: number | null
    sevenDay: number | null
    thirtyDay: number | null
    thisMonth: number | null
    realized: number | null
    unrealized: number | null
    biggestWin: number | null
    biggestLoss: number | null
    avgWin: number | null
    avgLoss: number | null
  }
  tradeBehavior?: {
    closedTrades: number
    avgHoldTime: string | null
    reason: string
  }
  personalitySummary: string
  recentTrades: WalletRecentTrade[]
  openChecks: string[]
}

type WalletResult = {
  address: string
  totalValue: number
  holdings: Holding[]
  txCount: number | null
  firstTxDate: string | null
  walletAgeDays: number | null
  providerUsed?: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none' | null
  providerStatus?: 'ok' | 'partial' | 'failed' | null
  holdingsCount?: number | null
  totalUsdAvailable?: boolean
  reason?: string | null
  portfolioSource?: 'portfolio_layer' | 'holdings_layer' | 'fallback_layer' | 'unverified' | 'none'
  behaviorSource?: 'activity_layer' | 'unavailable'
  behaviorChain?: 'base'
  pnlSource?: 'activity_layer' | 'fallback_layer' | 'unavailable'
  pnlCoverageReason?: string
  hiddenDustCount?: number
  unpricedHoldingsCount?: number
  walletBehavior?: WalletBehavior | null
  estimatedPnl?: {
    status: 'ok' | 'partial' | 'unavailable' | 'error'
    confidence: 'high' | 'medium' | 'low' | null
    coveragePercent: number
    source: 'activity_layer' | 'fallback_layer' | 'none'
    totalEstimatedPnlUsd: number | null
    unrealizedPnlUsd: number | null
    realizedPnlUsd: number | null
    method: 'average_cost_estimate'
    tokens: Array<{ symbol: string; contract: string; estimatedUnrealizedPnlUsd: number | null; estimatedRealizedPnlUsd: number | null; coveragePercent: number; confidence: 'high' | 'medium' | 'low' }>
    reason: string
  }
  walletIntelligence?: WalletIntelligence
}

// ── Formatters ───────────────────────────────────────────────────────────────────────────

function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function fmtSignedUSD(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'Open Check'
  return `${v >= 0 ? '+' : '-'}${fmtUSD(Math.abs(v))}`
}

function fmtOpenPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'Open Check'
  return `${v.toFixed(1)}%`
}

function safeNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function deriveWalletTier(winRate: number | null, closedCount = 0): WalletTier {
  if (winRate === null || !Number.isFinite(winRate)) return 'Open Check'
  if (winRate >= 65 && closedCount >= 10) return 'Smart Money'
  if (winRate >= 65 && closedCount >= 3) return 'Positive Early Read'
  if (winRate >= 40) return 'Average Trader'
  return 'Losing Wallet'
}

function deriveTradeBehavior(data: WalletResult): WalletIntelligence['tradeBehavior'] & { winRate: number | null; lossRate: number | null; avgWin: number | null; avgLoss: number | null; biggestWin: number | null; biggestLoss: number | null } {
  const backend = data.walletIntelligence
  const recentClosed = backend?.recentTrades?.filter(t => t.status === 'closed' && safeNum(t.pnl) !== null) ?? []
  const closedTrades = backend?.tradeBehavior?.closedTrades ?? recentClosed.length
  const hasEnoughClosedTrades = closedTrades >= 3
  const winRate = hasEnoughClosedTrades ? safeNum(backend?.winRate) : null
  const lossRate = hasEnoughClosedTrades ? safeNum(backend?.lossRate) : null
  return {
    closedTrades,
    avgHoldTime: backend?.tradeBehavior?.avgHoldTime ?? null,
    reason: hasEnoughClosedTrades ? 'Closed trades reconstructed from indexed entry and exit evidence.' : 'Not enough closed trades',
    winRate,
    lossRate,
    avgWin: hasEnoughClosedTrades ? safeNum(backend?.pnl?.avgWin) : null,
    avgLoss: hasEnoughClosedTrades ? safeNum(backend?.pnl?.avgLoss) : null,
    biggestWin: hasEnoughClosedTrades ? safeNum(backend?.pnl?.biggestWin) : null,
    biggestLoss: hasEnoughClosedTrades ? safeNum(backend?.pnl?.biggestLoss) : null,
  }
}

function derivePnlOverview(data: WalletResult): WalletIntelligence['pnl'] {
  const backend = data.walletIntelligence?.pnl
  const estimated = data.estimatedPnl
  const estimatedUsable = estimated?.status === 'ok' || estimated?.status === 'partial'
  return {
    total: safeNum(backend?.total) ?? (estimatedUsable ? safeNum(estimated?.totalEstimatedPnlUsd) : null),
    sevenDay: safeNum(backend?.sevenDay),
    thirtyDay: safeNum(backend?.thirtyDay),
    thisMonth: safeNum(backend?.thisMonth),
    realized: safeNum(backend?.realized) ?? (estimatedUsable ? safeNum(estimated?.realizedPnlUsd) : null),
    unrealized: safeNum(backend?.unrealized) ?? (estimatedUsable ? safeNum(estimated?.unrealizedPnlUsd) : null),
    biggestWin: safeNum(backend?.biggestWin),
    biggestLoss: safeNum(backend?.biggestLoss),
    avgWin: safeNum(backend?.avgWin),
    avgLoss: safeNum(backend?.avgLoss),
  }
}

function deriveWalletScore(data: WalletResult): { score: number | null; scoreStatus: 'ok' | 'open_check'; confidence: WalletConfidence } {
  const behavior = deriveTradeBehavior(data)
  const winRate = behavior.winRate
  const avgWin = behavior.avgWin
  const avgLoss = behavior.avgLoss
  const thirtyDay = derivePnlOverview(data).thirtyDay
  if (behavior.closedTrades < 3 || winRate === null || avgWin === null || avgLoss === null || thirtyDay === null) {
    return { score: null, scoreStatus: 'open_check', confidence: 'open check' }
  }

  const confidenceBoost = Math.min(20, behavior.closedTrades * 2)
  const payoffRatio = Math.max(0, Math.min(25, avgLoss === 0 ? 25 : (avgWin / Math.abs(avgLoss)) * 12.5))
  const trendScore = thirtyDay > 0 ? 15 : thirtyDay < 0 ? 0 : 7
  const score = Math.max(0, Math.min(100, Math.round(winRate * 0.4 + payoffRatio + trendScore + confidenceBoost)))
  const confidence: WalletConfidence = behavior.closedTrades >= 20 ? 'high' : behavior.closedTrades >= 8 ? 'medium' : 'low'
  return { score, scoreStatus: 'ok', confidence }
}

function buildWalletOpenCheck(data: WalletResult): string[] {
  const checks: string[] = []
  const estimated = data.estimatedPnl
  const hasEstimatedPnl = estimated?.status === 'ok' || estimated?.status === 'partial'
  if (!hasEstimatedPnl) checks.push('PnL remains Open Check until indexed transfer history has enough cost-basis coverage.')
  checks.push('Win rate requires at least 3 safely reconstructed closed trades with entry and exit evidence.')
  checks.push('Recent trade rows require real matched entries, exits, sizes, and price evidence.')
  if (!data.walletBehavior || data.walletBehavior.status === 'unavailable') checks.push('Activity behavior is limited for the currently checked chain window.')
  return Array.from(new Set([...(data.walletIntelligence?.openChecks ?? []), ...checks])).slice(0, 4)
}

function deriveWalletPersonality(data: WalletResult): string {
  if (data.walletIntelligence?.personalitySummary) return data.walletIntelligence.personalitySummary
  const behavior = deriveTradeBehavior(data)
  const pnl = derivePnlOverview(data)
  const holdingCount = data.holdings.length
  const activity = data.walletBehavior
  const sentences: string[] = []
  if (holdingCount > 0) {
    sentences.push(`This wallet currently shows ${holdingCount} visible token holding${holdingCount === 1 ? '' : 's'}, so the scanner can describe portfolio exposure but not trading skill by balance alone.`)
  } else {
    sentences.push('This wallet has no visible priced holdings in the checked window, so classification remains limited.')
  }
  if (pnl.total !== null) {
    sentences.push('Indexed transfer history provides an estimated PnL signal, but it is not treated as a win-rate or smart-money label without reconstructed closed trades.')
  } else {
    sentences.push('PnL remains Open Check because sufficient transaction, swap, balance, and price evidence was not available in the current scan.')
  }
  if (behavior.closedTrades < 3) {
    sentences.push('Not enough closed trades were indexed to classify trading skill.')
  }
  if (activity?.status === 'ok' && (activity.txCount ?? 0) > 0) {
    sentences.push('Recent activity exists on the checked chain, but entries and exits still need to be matched before score, tier, or win rate can be shown.')
  } else {
    sentences.push('Activity evidence is limited, so this read stays conservative and avoids copy-trading claims.')
  }
  return sentences.slice(0, 4).join(' ')
}

function buildWalletIntelligence(data: WalletResult): WalletIntelligence {
  const tradeBehavior = deriveTradeBehavior(data)
  const pnl = derivePnlOverview(data)
  const score = deriveWalletScore(data)
  const walletTier = data.walletIntelligence?.walletTier ?? deriveWalletTier(tradeBehavior.winRate, tradeBehavior.closedTrades)
  return {
    status: score.scoreStatus === 'ok' ? 'ok' : 'open_check',
    confidence: score.confidence,
    walletScore: score.score,
    walletTier,
    winRate: tradeBehavior.winRate,
    lossRate: tradeBehavior.lossRate,
    pnl,
    tradeBehavior,
    personalitySummary: deriveWalletPersonality(data),
    recentTrades: data.walletIntelligence?.recentTrades ?? [],
    openChecks: buildWalletOpenCheck(data),
  }
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

// ── Clark verdict parser ──────────────────────────────────────────────────────────────────────────

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
    'AI verdict not ready in current checks',
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

// ── Loading dots ──────────────────────────────────────────────────────────────────────────────

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

// ── Main page ────────────────────────────────────────────────────────────────────────────

export default function WalletScannerPage() {
  const { plan, loading: planLoading, betaEliteActive } = usePlanWithLoading()
  const [input, setInput]               = useState('')
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [result, setResult]             = useState<WalletResult | null>(null)
  const [showAllHoldings, setShowAllHoldings] = useState(false)
  const clarkLoading = loading

  async function handleScan() {
    const q = input.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    setResult(null)
    setShowAllHoldings(false)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res  = await fetch('/api/wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ address: q }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Scan failed')
      setResult(json)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setLoading(false)
    }
  }

  function dataQualityForWallet(data: WalletResult): string {
    const hasPortfolio = data.holdings.length > 0 || data.totalValue > 0
    return hasPortfolio ? 'Release view' : 'No signal in checked window'
  }


  function getCortexRead(data: WalletResult): { summary: string; bullets: string[]; caveat: string } {
    if (!data || data.holdings.length === 0) {
      return {
        summary: 'Scan a wallet to generate a CORTEX wallet read.',
        bullets: [],
        caveat: '',
      }
    }
    const sorted = [...data.holdings].sort((a, b) => b.value - a.value)
    const total = data.totalValue > 0 ? data.totalValue : sorted.reduce((acc, h) => acc + (Number.isFinite(h.value) ? h.value : 0), 0)
    const top = sorted.slice(0, 3)
    const topShare = total > 0 ? (top.reduce((acc, h) => acc + h.value, 0) / total) * 100 : null
    const concentration = topShare === null ? 'Unverified' : topShare >= 70 ? 'High concentration' : topShare >= 40 ? 'Balanced concentration' : 'Diversified spread'
    const activity = data.walletBehavior?.status === 'ok'
      ? ((data.walletBehavior.txCount ?? 0) > 0 ? 'Activity detected in checked Base window.' : 'No recent Base activity in checked window.')
      : 'Activity signal is limited in current checks.'
    const bullets = [
      total > 0 ? `Portfolio value observed: ${fmtUSD(total)}` : 'Portfolio value: Unverified',
      top.length > 0 ? `Top holdings: ${top.map(h => h.symbol || h.name).filter(Boolean).join(', ')}` : 'Top holdings: Unverified',
      `Concentration read: ${concentration}`,
      activity,
    ]
    return {
      summary: 'CORTEX can read verified holdings, but deeper behavior data is still forming.',
      bullets,
      caveat: data.totalValue <= 0 ? 'Some holdings are unpriced or still being verified.' : '',
    }
  }

  function buildWalletVerdict(data: WalletResult): ClarkVerdict {
    const sorted = [...data.holdings].sort((a, b) => b.value - a.value)
    const total = data.totalValue > 0 ? data.totalValue : sorted.reduce((acc, h) => acc + (Number.isFinite(h.value) ? h.value : 0), 0)
    const largest = sorted[0] ?? null
    const top3 = sorted.slice(0, 3)
    const topShare = total > 0 ? (top3.reduce((acc, h) => acc + h.value, 0) / total) * 100 : null
    const baseTx = data.walletBehavior?.txCount ?? 0
    const hasActivity = data.walletBehavior?.status === 'ok' && baseTx > 0
    const verdict = sorted.length === 0 ? 'INCOMPLETE READ' : hasActivity ? 'ACTIVE WALLET' : 'WATCH'
    return {
      verdict,
      confidence: hasActivity ? 'Medium' : 'Low',
      read: total > 0
        ? 'CORTEX verified visible holdings and estimated portfolio value from live Base data.'
        : 'CORTEX found visible holdings, but value is incomplete or unverified in current checks.',
      keySignals: [
        `Portfolio read: ${total > 0 ? fmtUSD(total) : 'unverified value'} across ${sorted.length} tracked token${sorted.length === 1 ? '' : 's'}.`,
        hasActivity ? 'Activity read: Recent Base activity detected in the checked window.' : 'Activity read: Recent Base activity is limited in the checked window.',
        `Risk / concentration: ${largest ? `${largest.symbol || 'Top asset'} is the largest visible holding${topShare != null ? ` (${topShare.toFixed(1)}% top-3 concentration)` : ''}.` : 'Largest holding remains unverified.'}`,
      ],
      risks: [
        'PnL is not verified from this scan.',
        'Win rate and wallet intent are not verified.',
        'Entries and exits timing are not verified.',
      ],
      nextAction: 'Monitor entries/exits and run token scans on major holdings. No trade call.',
    }
  }

  const clarkVerdict = result ? buildWalletVerdict(result) : null
  const clarkError = !loading && error ? 'Wallet read could not be completed. Check the address and try again.' : null

  if (planLoading) return <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Loading plan access…</div>
  if (!betaEliteActive && !canAccessFeature(plan, 'wallet-scanner')) return <LockedPanel feature="wallet-scanner" />

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
          .wallet-main { padding: 60px 14px 120px !important; }
          .wallet-input-row { flex-direction: column; max-width: 100% !important; }
          .wallet-input-row button { width: 100%; justify-content: center; }
          .ws-stat-grid     { grid-template-columns: repeat(2, 1fr) !important; }
          .ws-behavior-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .wallet-intel-grid, .wallet-score-grid { grid-template-columns: 1fr !important; }
          .wallet-trade-table { overflow-x: auto !important; }
          .ws-val-52        { font-size: 32px !important; letter-spacing: -0.02em !important; }
          .ws-holdings-header { display: none !important; }
          .ws-holdings-row {
            display: flex !important; flex-wrap: wrap !important;
            padding: 12px 14px !important; gap: 6px 0 !important; align-items: center !important;
          }
          .ws-col-token { flex: 0 0 100% !important; padding-bottom: 8px !important; border-bottom: 1px solid rgba(255,255,255,0.04) !important; }
          .ws-col-balance, .ws-col-value, .ws-col-change {
            flex: 1 1 33% !important; text-align: left !important; font-size: 12px !important;
          }
          .ws-col-balance::before { content: "Balance"; display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
          .ws-col-value::before   { content: "Value";   display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
          .ws-col-change::before  { content: "24h";     display: block; font-size: 8px; color: rgba(255,255,255,0.25); font-family: var(--font-plex-mono, monospace); text-transform: uppercase; letter-spacing: 0.10em; margin-bottom: 2px; }
        }
      `}</style>

      <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>

        {/* ── Left: scrollable main area ─────────────────────────────────── */}
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
                  fontSize: '16px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
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

          {/* CORTEX idle placeholder — shown before first scan */}
          {!result && !loading && (
            <div style={{ maxWidth: '720px', marginTop: '8px' }}>
              <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', padding: '18px 22px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '8px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'rgba(45,212,191,0.22)' }} />
                  <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    CORTEX Wallet Read
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                  Scan a wallet to generate a CORTEX wallet read.
                </p>
              </div>
            </div>
          )}

          {/* Results */}
          {result && !loading && (() => {
            const sorted = [...result.holdings].sort((a, b) => b.value - a.value)
            const largest = sorted[0] ?? null
            const quality = dataQualityForWallet(result)
            const b = result.walletBehavior
            const walletIntel = buildWalletIntelligence(result)
            const tierTone = walletIntel.walletTier === 'Smart Money'
              ? { bg: 'rgba(34,197,94,0.13)', border: 'rgba(34,197,94,0.32)', color: '#4ade80' }
              : walletIntel.walletTier === 'Positive Early Read'
                ? { bg: 'rgba(45,212,191,0.10)', border: 'rgba(45,212,191,0.28)', color: '#2DD4BF' }
                : walletIntel.walletTier === 'Average Trader'
                  ? { bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.30)', color: '#fbbf24' }
                  : walletIntel.walletTier === 'Losing Wallet'
                    ? { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.30)', color: '#f87171' }
                    : { bg: 'rgba(56,189,248,0.10)', border: 'rgba(56,189,248,0.25)', color: '#7dd3fc' }
            const hasUsefulActivity = Boolean(
              b?.status === 'ok' &&
              ((b.txCount ?? 0) > 0 || (b.activeDays ?? 0) > 0 || (b.inboundCount ?? 0) > 0 || (b.outboundCount ?? 0) > 0 || (b.topTokens?.length ?? 0) > 0 || (b.topContracts?.length ?? 0) > 0)
            )
            return (
            <div style={{ maxWidth: '100%', width: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}>

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
                  <div className="ws-val-52" style={{
                    fontSize: '52px', fontWeight: 900, color: '#f1f5f9',
                    fontFamily: 'var(--font-inter, Inter, sans-serif)',
                    letterSpacing: '-0.03em', lineHeight: 1,
                    marginBottom: '14px',
                  }}>
                    {result.totalValue > 0 ? fmtUSD(result.totalValue) : result.holdings.length > 0 ? 'Value pending in current checks' : 'No signal in checked window'}
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

              {/* Instant Wallet Score + PnL Intelligence */}
              <div className="wallet-score-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1.05fr) minmax(280px, 1.6fr)', gap: '14px' }}>
                <div style={{
                  background: 'radial-gradient(circle at top right, rgba(45,212,191,0.16), transparent 34%), #080c14',
                  border: `1px solid ${tierTone.border}`,
                  borderRadius: '18px', padding: '22px', position: 'relative', overflow: 'hidden',
                  boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
                }}>
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', borderTop: '2px solid rgba(45,212,191,0.55)' }} />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '18px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      Instant Wallet Score
                    </div>
                    <span style={{ padding: '5px 10px', borderRadius: '999px', background: tierTone.bg, border: `1px solid ${tierTone.border}`, color: tierTone.color, fontSize: '10px', fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      {walletIntel.walletTier}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', marginBottom: '14px' }}>
                    <div style={{ fontSize: '56px', lineHeight: 0.9, fontWeight: 950, letterSpacing: '-0.06em', color: walletIntel.walletScore === null ? '#7dd3fc' : '#f8fafc', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                      {walletIntel.walletScore === null ? 'Open Check' : walletIntel.walletScore}
                    </div>
                    {walletIntel.walletScore !== null && <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>/100</div>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                    {[
                      { label: 'Win Rate', value: fmtOpenPct(walletIntel.winRate), note: walletIntel.winRate === null ? 'Not enough closed trades' : 'Closed trades only' },
                      { label: 'Confidence', value: walletIntel.confidence, note: walletIntel.confidence === 'open check' ? 'Evidence pending' : 'Evidence weighted' },
                    ].map(item => (
                      <div key={item.label} style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.13em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>{item.label}</div>
                        <div style={{ fontSize: '18px', color: '#e2e8f0', fontWeight: 800, textTransform: item.label === 'Confidence' ? 'capitalize' : 'none' }}>{item.value}</div>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', marginTop: '4px' }}>{item.note}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '18px', padding: '22px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                    <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Estimated Position Read</div>
                    <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.25)', background: 'rgba(56,189,248,0.06)', borderRadius: '999px', padding: '2px 7px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>avg cost basis</span>
                  </div>
                  <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' }}>
                    {[
                      { label: 'Total PnL All Time', value: fmtSignedUSD(walletIntel.pnl.total) },
                      { label: '7D PnL', value: fmtSignedUSD(walletIntel.pnl.sevenDay) },
                      { label: '30D PnL', value: fmtSignedUSD(walletIntel.pnl.thirtyDay) },
                      { label: 'This Month PnL', value: fmtSignedUSD(walletIntel.pnl.thisMonth) },
                      { label: 'Realized PnL', value: fmtSignedUSD(walletIntel.pnl.realized) },
                      { label: 'Unrealized PnL', value: fmtSignedUSD(walletIntel.pnl.unrealized) },
                    ].map(card => (
                      <div key={card.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                        <div style={{ fontSize: '18px', fontWeight: 800, color: card.value === 'Open Check' ? '#7dd3fc' : card.value.startsWith('-') ? '#f87171' : '#4ade80', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{card.value}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.32)', lineHeight: 1.5, marginTop: '12px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    Missing periods stay Open Check. Current PnL values only appear when the scan exposes indexed transfer/cost-basis evidence.
                  </div>
                </div>
              </div>

              <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '20px 22px' }}>
                <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '14px' }}>Trade Behavior</div>
                <div className="wallet-intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px' }}>
                  {[
                    { label: 'Win Rate', value: fmtOpenPct(walletIntel.winRate) },
                    { label: 'Loss Rate', value: fmtOpenPct(walletIntel.lossRate) },
                    { label: 'Avg Profit / Win', value: fmtSignedUSD(walletIntel.pnl.avgWin) },
                    { label: 'Avg Loss / Loss', value: fmtSignedUSD(walletIntel.pnl.avgLoss) },
                    { label: 'Biggest Win', value: fmtSignedUSD(walletIntel.pnl.biggestWin) },
                    { label: 'Biggest Loss', value: fmtSignedUSD(walletIntel.pnl.biggestLoss) },
                    { label: 'Avg Hold Time', value: walletIntel.tradeBehavior?.avgHoldTime ?? 'Open Check' },
                    { label: 'Closed Trades', value: walletIntel.tradeBehavior?.closedTrades && walletIntel.tradeBehavior.closedTrades >= 3 ? String(walletIntel.tradeBehavior.closedTrades) : 'Not enough closed trades' },
                  ].map(card => (
                    <div key={card.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px' }}>
                      <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '7px' }}>{card.label}</div>
                      <div style={{ fontSize: '16px', fontWeight: 800, color: String(card.value).includes('Open Check') || String(card.value).includes('Not enough') ? '#7dd3fc' : '#e2e8f0', lineHeight: 1.25 }}>{card.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '20px 22px' }}>
                <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '10px' }}>AI Wallet Personality</div>
                <p style={{ margin: 0, color: '#cbd5e1', fontSize: '13px', lineHeight: 1.75, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{walletIntel.personalitySummary}</p>
                {walletIntel.openChecks.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' }}>
                    {walletIntel.openChecks.map(check => (
                      <span key={check} style={{ fontSize: '10px', color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.18)', background: 'rgba(56,189,248,0.06)', borderRadius: 999, padding: '5px 9px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{check}</span>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', overflow: 'hidden' }}>
                <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                  <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.18em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Recent Trades</div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Closed trades only</div>
                </div>
                {walletIntel.recentTrades.length > 0 ? (
                  <div className="wallet-trade-table">
                    <div style={{ minWidth: '760px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(6, 1fr)', gap: '10px', padding: '10px 22px', fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        {['Token', 'Entry', 'Exit', 'PnL', 'Hold Time', 'Size', 'Status'].map(h => <div key={h}>{h}</div>)}
                      </div>
                      {walletIntel.recentTrades.slice(0, 8).map((trade, idx) => (
                        <div key={`${trade.token}-${idx}`} style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(6, 1fr)', gap: '10px', padding: '12px 22px', fontSize: '12px', color: '#cbd5e1', borderBottom: idx === walletIntel.recentTrades.slice(0, 8).length - 1 ? 'none' : '1px solid rgba(255,255,255,0.045)' }}>
                          <div style={{ fontWeight: 800 }}>{trade.token || 'Open Check'}</div>
                          <div>{trade.entry === null ? 'Open Check' : fmtUSD(trade.entry)}</div>
                          <div>{trade.exit === null ? 'Open Check' : fmtUSD(trade.exit)}</div>
                          <div style={{ color: trade.pnl === null ? '#7dd3fc' : trade.pnl >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUSD(trade.pnl)}</div>
                          <div>{trade.holdTime ?? 'Open Check'}</div>
                          <div>{trade.size === null ? 'Open Check' : fmtUSD(trade.size)}</div>
                          <div>{trade.status || 'Open Check'}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: '20px 22px', color: '#7dd3fc', fontSize: '13px', lineHeight: 1.6, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                    Closed trades could not be reconstructed from indexed data yet.
                  </div>
                )}
              </div>

              <div className="ws-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                {[
                  { label: 'Portfolio Value', value: result.totalValue > 0 ? fmtUSD(result.totalValue) : result.holdings.length > 0 ? 'Value pending in current checks' : 'No signal in checked window', sub: 'Portfolio read active', color: '#2DD4BF' },
                  { label: 'Token Count', value: sorted.length.toLocaleString(), sub: 'Visible token balances', color: '#a78bfa' },
                  { label: 'Largest Holding', value: largest ? largest.symbol : 'No signal in checked window', sub: largest ? fmtUSD(largest.value) : 'No holdings found', color: '#fbbf24' },
                  { label: 'Data Quality', value: quality, sub: quality === 'Release view' ? 'Portfolio read active' : 'No fresh Base activity signal', color: quality === 'Release view' ? '#94a3b8' : '#fbbf24' },
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


              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  'Portfolio read: CORTEX',
                  ...(hasUsefulActivity ? ['Base activity: CORTEX'] : []),
                  'Release view',
                ].map((chip) => (
                  <span key={chip} style={{ fontSize: 11, color: '#94a3b8', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 999, padding: '5px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                    {chip}
                  </span>
                ))}
              </div>


              {/* ── Behavior card ────────────────────────────────────────────────── */}
              {hasUsefulActivity && result.walletBehavior?.status === 'ok' && (
                <div style={{
                  background: '#080c14',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '14px', padding: '18px 22px',
                }}>
                  <div style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                    color: '#2DD4BF', textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    marginBottom: '14px',
                  }}>
                    Base Activity
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 10 }}>Behavior scope: Base only</div>
                                    <div className="ws-behavior-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '12px' }}>
                    {[
                      { label: 'Recent Txs', value: result.walletBehavior.txCount ?? '—' },
                      { label: 'Active Days', value: result.walletBehavior.activeDays ?? '—' },
                      { label: 'Inbound', value: result.walletBehavior.inboundCount ?? '—' },
                      { label: 'Outbound', value: result.walletBehavior.outboundCount ?? '—' },
                    ].map(s => (
                      <div key={s.label}>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.10em' }}>{s.label}</div>
                        <div style={{ fontSize: '20px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{String(s.value)}</div>
                      </div>
                    ))}
                  </div>
                  {result.walletBehavior.topTokens.length > 0 && (
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '6px' }}>
                      <span style={{ color: 'rgba(255,255,255,0.28)' }}>Top tokens: </span>
                      {result.walletBehavior.topTokens.slice(0, 5).join(', ')}
                    </div>
                  )}
                  {result.walletBehavior.stablecoinActivity && (
                    <div style={{ fontSize: '11px', color: '#a78bfa', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      Stablecoin movement detected
                    </div>
                  )}
                  {result.walletBehavior.txCount === 0 && (
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: 8 }}>
                      No recent Base activity found in checked window.
                    </div>
                  )}
                </div>
              )}

              <div style={{
                background: '#080c14',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '14px', padding: '16px 18px'
              }}>
                <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: '#2DD4BF', textTransform: 'uppercase', marginBottom: 10 }}>CORTEX Wallet Read</div>
                {(() => { const read = getCortexRead(result); return (
                  <>
                    <p style={{ fontSize: 13, color: '#cbd5e1', margin: '0 0 8px' }}>{read.summary}</p>
                    {read.bullets.map((bline, idx) => <p key={idx} style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', margin: '0 0 4px' }}>• {bline}</p>)}
                    {read.caveat && <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0' }}>{read.caveat}</p>}
                  </>
                )})()}
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
                    <div className="md:hidden" style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px' }}>
                      {visible.map((h, i) => {
                        const up = (h.change24h ?? 0) >= 0
                        const chainLabel = h.chain ? h.chain.replace(/-mainnet$/, '').replace(/-/g, ' ') : null
                        return (
                          <div key={`m-${i}`} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', background: 'rgba(255,255,255,0.01)', width: '100%', maxWidth: '100%', minWidth: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, minWidth: 0 }}>
                              <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                                {h.icon ? <img src={h.icon} alt={h.symbol} width={30} height={30} style={{ borderRadius: '50%', flexShrink: 0 }} /> : <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#04101a', flexShrink: 0 }}>{h.symbol.slice(0,2).toUpperCase()}</div>}
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.symbol || h.name}</div>
                                  {h.name && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</div>}
                                </div>
                              </div>
                              {chainLabel && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', padding: '2px 6px', borderRadius: 999, background: 'rgba(0,82,255,0.14)', border: '1px solid rgba(0,82,255,0.28)', color: '#6ea8ff', textTransform: 'uppercase', height: 'fit-content', flexShrink: 0 }}>{chainLabel}</span>}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: 10 }}>
                              <div><div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>Balance</div><div style={{ fontSize: 13 }}>{fmtBalance(h.balance)}</div></div>
                              <div><div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>Value</div><div style={{ fontSize: 13 }}>{h.value > 0 ? fmtUSD(h.value) : 'Unverified'}</div></div>
                              <div><div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>24h</div><div style={{ fontSize: 13, color: h.change24h === null ? 'rgba(255,255,255,0.5)' : up ? '#2DD4BF' : '#ef4444' }}>{h.change24h === null ? 'Unverified' : fmtPct(h.change24h)}</div></div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {/* Table header */}
                    <div className="ws-holdings-header" style={{
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
                          className="ws-row ws-holdings-row"
                          style={{
                            display: 'grid', gridTemplateColumns: '1fr 110px 120px 88px',
                            padding: '14px 20px',
                            borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.04)',
                            alignItems: 'center',
                            transition: 'background 0.12s',
                          }}
                        >
                          {/* Token col */}
                          <div className="ws-col-token" style={{ display: 'flex', alignItems: 'center', gap: '11px', minWidth: 0 }}>
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
                          <div className="ws-col-balance" style={{
                            textAlign: 'right', fontSize: '13px', color: 'rgba(255,255,255,0.50)',
                            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                          }}>
                            {fmtBalance(h.balance)}
                          </div>

                          {/* Value */}
                          <div className="ws-col-value" style={{
                            textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#e2e8f0',
                            fontFamily: 'var(--font-inter, Inter, sans-serif)',
                          }}>
                            {fmtUSD(h.value)}
                          </div>

                          {/* 24h */}
                          <div className="ws-col-change" style={{
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
                    ChainLens intelligence checks complete · Try a different wallet or check back later
                  </div>
                </div>
              )}

              {/* ── CORTEX Wallet Read (inline — visible on mobile where sidebar is hidden) ── */}
              <div style={{
                background: '#080c14',
                border: '1px solid rgba(45,212,191,0.18)',
                borderRadius: '16px', overflow: 'hidden',
              }}>
                <div style={{ height: '2px', background: 'linear-gradient(90deg,#2DD4BF,#8b5cf6)', opacity: clarkVerdict ? 1 : 0.25 }} />
                <div style={{ padding: '18px 22px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '16px' }}>
                    <div style={{
                      width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
                      background: (clarkLoading || clarkVerdict) ? '#2DD4BF' : 'rgba(45,212,191,0.22)',
                      boxShadow: (clarkLoading || clarkVerdict) ? '0 0 8px rgba(45,212,191,0.70)' : 'none',
                      animation: clarkLoading ? 'clarkPulse 1.2s ease-in-out infinite' : 'none',
                    }} />
                    <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      CORTEX Wallet Read
                    </span>
                  </div>

                  {clarkLoading && (
                    <div>
                      <ClarkDots />
                      <p style={{ marginTop: '8px', fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                        CORTEX is reading wallet activity…
                      </p>
                    </div>
                  )}

                  {!clarkLoading && clarkError && (
                    <p style={{ margin: 0, fontSize: '12px', color: '#fca5a5', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                      {clarkError}
                    </p>
                  )}

                  {!clarkLoading && !clarkVerdict && (
                    <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                      Scan a wallet to generate a CORTEX wallet read.
                    </p>
                  )}

                  {!clarkLoading && clarkVerdict && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ padding: '3px 10px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(45,212,191,0.12)', border: '1px solid rgba(45,212,191,0.28)', color: '#2DD4BF' }}>
                          {clarkVerdict.verdict}
                        </span>
                        <span style={{ padding: '3px 10px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24' }}>
                          {clarkVerdict.confidence} confidence
                        </span>
                      </div>

                      <p style={{ margin: 0, fontSize: '13px', color: '#f1f5f9', lineHeight: 1.6, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                        {clarkVerdict.read}
                      </p>

                      <div>
                        <p style={{ margin: '0 0 6px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Activity Read</p>
                        {clarkVerdict.keySignals.slice(0, 3).map((line, i) => (
                          <p key={i} style={{ margin: '0 0 4px', fontSize: '12px', color: '#cbd5e1' }}>— {line}</p>
                        ))}
                      </div>

                      <div>
                        <p style={{ margin: '0 0 6px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Missing Checks</p>
                        {clarkVerdict.risks.slice(0, 3).map((line, i) => (
                          <p key={i} style={{ margin: '0 0 4px', fontSize: '12px', color: '#fca5a5' }}>— {line}</p>
                        ))}
                      </div>

                      <div>
                        <p style={{ margin: '0 0 4px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Next action</p>
                        <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>{clarkVerdict.nextAction}</p>
                      </div>

                      <p style={{ margin: 0, fontSize: '10px', color: 'rgba(255,255,255,0.20)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                        Powered by CORTEX — verified on-chain data only
                      </p>
                    </div>
                  )}
                </div>
              </div>

            </div>
            )
          })()}
        </div>

        {/* ── Right: Clark verdict panel ────────────────────────────────────────────── */}
        <aside className="mob-verdict-panel hidden md:flex" style={{
          width: '380px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: '#080c14',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Top gradient accent */}
          <div style={{
            height: '2px', flexShrink: 0,
            background: 'linear-gradient(90deg, #2DD4BF, #8b5cf6)',
            opacity: false ? 1 : 0.18,
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
                background: false ? '#2DD4BF' : 'rgba(45,212,191,0.22)',
                boxShadow: false ? '0 0 8px rgba(45,212,191,0.70)' : 'none',
                animation: 'none',
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
            {clarkLoading && (
              <div>
                <ClarkDots />
                <p style={{ marginTop: '8px', fontSize: '12px', color: '#67e8f9', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                  CORTEX is reading wallet activity…
                </p>
              </div>
            )}
            {!clarkLoading && clarkError && (
              <p style={{ fontSize: '13px', color: '#fca5a5', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0 }}>
                {clarkError}
              </p>
            )}
            {!clarkLoading && !clarkError && !clarkVerdict && (
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.22)', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0 }}>
                Scan a wallet to generate a CORTEX wallet read.
              </p>
            )}
            {!clarkLoading && clarkVerdict && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ padding: '3px 10px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(45,212,191,0.12)', border: '1px solid rgba(45,212,191,0.28)', color: '#2DD4BF' }}>{clarkVerdict.verdict}</span>
                </div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Portfolio Read</p><p style={{ margin: 0, fontSize: '12px', color: '#e2e8f0', lineHeight: 1.6 }}>{clarkVerdict.read}</p></div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Activity Read</p>{clarkVerdict.keySignals.slice(0, 2).map((line, i) => <p key={i} style={{ margin: '0 0 4px', fontSize: '12px', color: '#cbd5e1' }}>— {line}</p>)}</div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Risk / Concentration</p><p style={{ margin: 0, fontSize: '12px', color: '#fcd34d' }}>— {clarkVerdict.keySignals[2]}</p></div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Missing Checks</p>{clarkVerdict.risks.slice(0, 3).map((line, i) => <p key={i} style={{ margin: '0 0 4px', fontSize: '12px', color: '#fca5a5' }}>— {line}</p>)}</div>
                <div><p style={{ margin: '0 0 4px', fontSize: '10px', color: '#64748b', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Next Action</p><p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>{clarkVerdict.nextAction}</p></div>
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
