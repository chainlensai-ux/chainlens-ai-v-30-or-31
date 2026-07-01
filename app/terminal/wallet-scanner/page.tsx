'use client'

// Wallet Scanner — restored Cortex-style UI (from commit 348d917) running on the ChainLens
// 90-Day Intelligence Engine (V2). Layout, styling, header, Deep Scan / Admin Full Recovery /
// Smart Recovery controls, CORTEX Wallet Read panel, and the Wallet Watchlist sidebar are all
// restored. The scan handler and every results-rendering section were rebuilt against the V2
// report shape — none of the old profiler fields (walletPnlRead, publicRealizedPnlUsd,
// walletTradeStatsSummary, etc.) exist anymore, so the old PnL/trade-stats JSX could not be
// restored verbatim; it is replaced here by the equivalent V2 sections (portfolio, holdings,
// timelines, behaviorIntel, recoveryPolicy, windowCoverage, finalSummary).
//
// Admin Full Recovery / Smart Recovery: V2's runWalletScanV2() only accepts scanMode
// 'normal' | 'deep' — there is no equivalent of the old full_recovery/smart_recovery scan modes.
// Both admin-only buttons remain visible (still gated on the same admin email check) and both
// now trigger a V2 deep scan, since that is the closest real capability that exists.
//
// No backend changes: this file only calls scanWalletV2() (POST /api/scan-v2). runWalletScanV2,
// holdingsEngine/pricingEngine/portfolioAssembler, /api/scan, /api/scan-v2, Clark AI, and
// /api/portfolio are untouched.

import { useEffect, useState } from 'react'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'
import { scanWalletV2, type ScanWalletApiResponse } from '@/app/frontend/api/scanWallet'
import {
  BehaviorIntelView,
  BuyTimelineView,
  ChainSelectionView,
  DistributionTimelineView,
  FifoAndPnlView,
  FinalSummaryView,
  HoldingsView,
  RecoveryPolicyView,
  SellTimelineView,
  WindowCoverageView,
} from '@/app/frontend/components'
import type { FinalReport } from '@/src/modules/finalReportAssembler/types'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'

type WalletV2Report = FinalReport & { holdings: TokenHolding[]; portfolio: PortfolioSummary }

type WatchlistWallet = {
  id?: string
  address: string
  label?: string | null
  portfolio_value?: number | null
  chain_mode?: string | null
}

function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

// Replaces the old buildWalletVerdict(result) (which read profiler-only fields) with a small
// V2-sourced equivalent for the CORTEX Wallet Read sidebar — every value here is a direct
// restatement of report.finalSummary / report.behaviorIntel, never a new judgment.
//
// V2-SAFE GUARD: `report` is typed as non-optional, but that is a compile-time contract only —
// a real API response can still be malformed/partial at runtime, so every nested access here is
// defensively guarded rather than assumed present.
function buildCortexReadV2(report: WalletV2Report | null | undefined): {
  verdict: string
  read: string
  keySignals: string[]
  risks: string[]
  nextAction: string
} {
  const b = report?.behaviorIntel
  const s = report?.finalSummary
  const activeChains = Array.isArray(b?.multiChainParticipation?.activeChains) ? b!.multiChainParticipation.activeChains : []
  const totalValueUsd = report?.portfolio?.totalValueUsd ?? null

  return {
    verdict: (b?.rotationStyle?.value ?? 'unknown').toUpperCase(),
    read: s?.walletPersonality ?? 'Insufficient data to classify wallet behavior.',
    keySignals: [
      `Risk posture: ${b?.riskOnOff?.value ?? 'unknown'}`,
      `Chains: ${activeChains.join(', ') || 'none active'}`,
      totalValueUsd != null ? `Portfolio value: ${fmtUSD(totalValueUsd)}` : 'Portfolio value: not available',
    ],
    risks: [
      s?.financialStatus?.headline ?? 'PnL unavailable due to missing evidence.',
      b?.automationSignals?.suspectedBot ? 'Automation signal detected in trade timing.' : 'No automation signal detected.',
      s?.recoverySummary ?? 'No recovery attempted.',
    ],
    nextAction: b?.confidence === 'low' || !b
      ? 'Confidence is low — coverage is thin (dust-heavy chains or a partial window). Treat this read as directional only.'
      : 'Scan additional chains or run a Deep Scan for broader coverage.',
  }
}

export default function WalletScannerPage() {
  const { plan, loading: planLoading, betaEliteActive } = usePlanWithLoading()

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WalletV2Report | null>(null)
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [watchlistStatus, setWatchlistStatus] = useState<'idle' | 'saving' | 'success' | 'exists' | 'error'>('idle')
  const [watchlistMessage, setWatchlistMessage] = useState<string | null>(null)
  const [watchlistWallets, setWatchlistWallets] = useState<WatchlistWallet[]>([])
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  const [watchlistDeleting, setWatchlistDeleting] = useState<string | null>(null)

  const isFullRecoveryAdmin = (signedInEmail ?? '').toLowerCase() === 'chainlensai@gmail.com'

  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setSignedInEmail(data.session?.user?.email ?? null)
      setSessionLoaded(true)
    }).catch(() => {
      if (cancelled) return
      setSignedInEmail(null)
      setSessionLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  async function loadWalletWatchlist() {
    setWatchlistLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistWallets([])
        return
      }
      const res = await fetch('/api/watchlist/wallets', { headers: { Authorization: `Bearer ${token}` } })
      const json = await res.json().catch(() => null)
      if (res.ok) setWatchlistWallets(Array.isArray(json?.wallets) ? json.wallets : [])
    } finally {
      setWatchlistLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadWalletWatchlist()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  async function handleAddWalletToWatchlist() {
    if (!result?.scanMetadata?.walletAddress) return
    setWatchlistStatus('saving')
    setWatchlistMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistStatus('error')
        setWatchlistMessage('Sign in to add wallets to your watchlist.')
        return
      }
      const res = await fetch('/api/watchlist/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          address: result.scanMetadata.walletAddress,
          portfolio_value: result.portfolio?.totalValueUsd ?? null,
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setWatchlistStatus('error')
        setWatchlistMessage(json?.error ?? 'Could not add wallet to watchlist.')
        return
      }
      if (json?.exists) {
        setWatchlistStatus('exists')
        setWatchlistMessage('Already in watchlist')
      } else {
        setWatchlistStatus('success')
        setWatchlistMessage('Added to watchlist')
      }
      await loadWalletWatchlist()
    } catch {
      setWatchlistStatus('error')
      setWatchlistMessage('Could not add wallet to watchlist.')
    }
  }

  async function handleRemoveWalletFromWatchlist(address: string) {
    setWatchlistDeleting(address)
    setWatchlistMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistStatus('error')
        setWatchlistMessage('Sign in to manage your watchlist.')
        return
      }
      const res = await fetch(`/api/watchlist/wallets?address=${encodeURIComponent(address)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setWatchlistStatus('error')
        setWatchlistMessage(json?.error ?? 'Could not remove wallet.')
        return
      }
      setWatchlistWallets((wallets) => wallets.filter((wallet) => wallet.address.toLowerCase() !== address.toLowerCase()))
      setWatchlistStatus('idle')
      setWatchlistMessage('Removed from watchlist')
    } catch {
      setWatchlistStatus('error')
      setWatchlistMessage('Could not remove wallet.')
    } finally {
      setWatchlistDeleting(null)
    }
  }

  // The only pipeline entry point this page calls. mode 'deep' also covers the two admin-only
  // buttons below, since V2 has no equivalent of the old full_recovery/smart_recovery scan modes.
  async function handleScan(mode: 'normal' | 'deep' = 'normal') {
    const address = input.trim()
    if (!address) return

    if (mode === 'deep' && !sessionLoaded) {
      // SESSION-RACE-GUARD: never resolve "not admin" from an unloaded session.
      setError('Verifying your session — try again in a moment.')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response: ScanWalletApiResponse = await scanWalletV2(address, ['base', 'eth'], mode)
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? 'Scan failed')
      }
      setResult(response.data as WalletV2Report)
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('Scan failed', err)
      setError(err instanceof Error ? err.message : 'Scan failed — try again later')
    } finally {
      setLoading(false)
    }
  }

  if (planLoading) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>
        Loading plan access…
      </div>
    )
  }
  if (!betaEliteActive && !canAccessFeature(plan, 'wallet-scanner')) {
    return <LockedPanel feature="wallet-scanner" />
  }

  const cortexRead = result ? buildCortexReadV2(result) : null

  return (
    <>
      <style>{`
        .ws-row:hover { background: rgba(255,255,255,0.030) !important; }
        .ws-scan-btn:hover:not(:disabled) {
          background: linear-gradient(135deg, #2DD4BF, #22c5ae) !important;
          box-shadow: 0 0 28px rgba(45,212,191,0.50), 0 4px 16px rgba(0,0,0,0.30) !important;
          transform: translateY(-1px);
        }
        .ws-scan-btn { transition: background 0.15s, box-shadow 0.18s, color 0.15s, transform 0.12s !important; }
        .ws-card-hover:hover { border-color: rgba(45,212,191,0.25) !important; box-shadow: 0 0 20px rgba(45,212,191,0.06) !important; transition: border-color 0.2s, box-shadow 0.2s; }
        .ws-result-fade { animation: fadeUp 0.3s ease both; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .ws-section-header { font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); }
        .ws-card { background: rgba(6,10,18,0.95); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 18px 20px; margin-bottom: 16px; }
        @media (max-width: 768px) {
          .wallet-main { padding: 52px 16px 100px !important; }
          .wallet-input-row { flex-direction: column; max-width: 100% !important; }
          .wallet-input-row button { width: 100%; justify-content: center; }
        }
      `}</style>

      <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>
        {/* ── Left: scrollable main area ─────────────────────────────────── */}
        <div className="mob-scan-main wallet-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '36px 40px 120px', background: 'radial-gradient(ellipse 80% 35% at 50% 0%, rgba(45,212,191,0.035) 0%, transparent 65%)' }}>

          {/* Header */}
          <div style={{ marginBottom: '36px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '12px' }}>
              <h1 style={{
                fontSize: '32px', fontWeight: 900, lineHeight: 1.05,
                margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)',
                letterSpacing: '-0.03em',
                background: 'linear-gradient(135deg, #f1f5f9 0%, #94a3b8 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}>
                Wallet Scanner
              </h1>
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                padding: '4px 12px', borderRadius: '99px',
                background: 'linear-gradient(135deg, rgba(139,92,246,0.22), rgba(168,85,247,0.14))',
                border: '1px solid rgba(139,92,246,0.45)',
                color: '#c4b5fd',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                textTransform: 'uppercase', flexShrink: 0,
                boxShadow: '0 0 16px rgba(139,92,246,0.15)',
              }}>
                Elite
              </span>
            </div>
            <p style={{ fontSize: '14px', color: 'rgba(148,163,184,0.80)', margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '0.01em' }}>
              Advanced on-chain intelligence · AI-powered wallet analysis · 90-Day Intelligence Engine
            </p>
          </div>

          {/* Input */}
          <div className="wallet-input-row" style={{ display: 'flex', gap: '10px', maxWidth: '700px', marginBottom: '20px' }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleScan() }}
              disabled={loading}
              placeholder="0x… wallet address"
              spellCheck={false}
              style={{
                flex: 1, padding: '14px 16px', background: 'rgba(255,255,255,0.035)',
                border: '1px solid rgba(255,255,255,0.09)', borderRadius: '13px', color: '#e2e8f0',
                fontSize: '15px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                outline: 'none', boxSizing: 'border-box', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.18)',
              }}
            />
            <button
              className="ws-scan-btn"
              onClick={() => void handleScan()}
              disabled={loading || !input.trim()}
              style={{
                padding: '14px 24px', borderRadius: '13px', border: 'none',
                background: (loading || !input.trim()) ? 'rgba(45,212,191,0.20)' : 'linear-gradient(135deg, #2DD4BF, #22c5ae)',
                color: (loading || !input.trim()) ? 'rgba(255,255,255,0.30)' : '#03121e',
                fontSize: '11px', fontWeight: 900, letterSpacing: '0.12em', textTransform: 'uppercase',
                cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              {loading ? 'Scanning…' : 'Scan'}
            </button>
          </div>

          {/* Deep Scan and admin-only recovery controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', flexWrap: 'wrap', marginBottom: '24px' }}>
            <button
              onClick={() => void handleScan('deep')}
              disabled={loading || !input.trim()}
              title="Deep scan via the 90-Day Intelligence Engine — includes holdings, portfolio value, and recovery-policy evaluation."
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 13px', borderRadius: '8px', border: '1px solid rgba(45,212,191,0.45)',
                background: 'rgba(45,212,191,0.08)', color: '#2DD4BF',
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase',
                cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}
            >
              Deep Scan
            </button>
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.04em' }}>
              V2 engine · holdings + portfolio + recovery policy
            </span>
            {isFullRecoveryAdmin && (
              <button
                onClick={() => void handleScan('deep')}
                disabled={loading || !input.trim()}
                title="V2 has no separate full-recovery scan mode — this triggers the same Deep Scan as the button above."
                style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px', padding: '7px 13px', borderRadius: '8px', border: '1px solid rgba(251,191,36,0.55)', background: 'rgba(251,191,36,0.10)', color: '#fbbf24', fontSize: '10px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}
              >
                <span>Admin Full Recovery</span>
                <span style={{ fontSize: '9px', fontWeight: 600, letterSpacing: 0, textTransform: 'none', color: 'rgba(251,191,36,0.78)' }}>Runs a V2 Deep Scan (no separate recovery mode in V2).</span>
              </button>
            )}
            {isFullRecoveryAdmin && (
              <button
                onClick={() => void handleScan('deep')}
                disabled={loading || !input.trim()}
                title="V2 has no separate smart-recovery scan mode — this triggers the same Deep Scan as the button above."
                style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px', padding: '7px 13px', borderRadius: '8px', border: '1px solid rgba(168,85,247,0.55)', background: 'rgba(168,85,247,0.10)', color: '#a855f7', fontSize: '10px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}
              >
                <span>Smart Recovery (Admin)</span>
                <span style={{ fontSize: '9px', fontWeight: 600, letterSpacing: 0, textTransform: 'none', color: 'rgba(168,85,247,0.78)' }}>Runs a V2 Deep Scan (no separate recovery mode in V2).</span>
              </button>
            )}
          </div>

          {/* Loading state */}
          {loading && (
            <div className="ws-card" style={{ color: 'rgba(148,163,184,0.75)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', fontSize: '13px' }}>
              Scanning {input.trim()}…
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div className="ws-card" style={{ borderColor: 'rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.06)', color: '#fca5a5', fontSize: '13px' }}>
              Scan failed — try again later. ({error})
            </div>
          )}

          {/* Idle placeholder */}
          {!loading && !error && !result && (
            <div className="ws-card ws-card-hover" style={{ textAlign: 'center', padding: '48px 24px', color: 'rgba(255,255,255,0.30)' }}>
              <div className="ws-section-header" style={{ color: 'rgba(45,212,191,0.55)', marginBottom: '10px' }}>CORTEX · Wallet Intelligence</div>
              <p style={{ fontSize: '13px', lineHeight: 1.7, margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                Enter a wallet address above to generate a CORTEX wallet read — portfolio value, holdings, and on-chain behavior via the 90-Day Intelligence Engine.
              </p>
            </div>
          )}

          {/* V2 engine results */}
          {!loading && result && (
            <div className="ws-result-fade">
              <div className="ws-card"><FinalSummaryView summary={result.finalSummary} /></div>
              <div className="ws-card"><HoldingsView holdings={result.holdings} portfolio={result.portfolio} /></div>
              <div className="ws-card"><ChainSelectionView data={result.chainSelection} /></div>
              <div className="ws-card"><BuyTimelineView data={result.timelines?.buyTimeline} /></div>
              <div className="ws-card"><SellTimelineView data={result.timelines?.sellTimeline} /></div>
              <div className="ws-card"><DistributionTimelineView data={result.timelines?.distributionTimeline} /></div>
              <div className="ws-card"><RecoveryPolicyView data={result.recoveryPolicy} /></div>
              <div className="ws-card"><FifoAndPnlView data={result.fifoAndPnl} /></div>
              <div className="ws-card"><BehaviorIntelView data={result.behaviorIntel} /></div>
              <div className="ws-card"><WindowCoverageView data={result.windowCoverage} /></div>
            </div>
          )}
        </div>

        {/* ── Right: CORTEX Wallet Read + Watchlist ─────────────────────────── */}
        <aside className="mob-verdict-panel hidden md:flex" style={{
          width: '360px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          background: 'linear-gradient(180deg, #070b14 0%, #060a12 100%)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ height: '2px', flexShrink: 0, background: 'linear-gradient(90deg, transparent 0%, #2DD4BF 40%, #8b5cf6 70%, transparent 100%)', opacity: cortexRead ? 0.85 : 0.15, transition: 'opacity 0.5s' }} />

          <div style={{ padding: '22px 24px 16px', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: result ? '10px' : 0 }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: cortexRead ? '#2DD4BF' : 'rgba(45,212,191,0.20)', boxShadow: cortexRead ? '0 0 10px rgba(45,212,191,0.70)' : 'none' }} />
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                CORTEX · Wallet Read
              </span>
            </div>
            {result?.scanMetadata?.walletAddress && (
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.04em' }}>
                {result.scanMetadata.walletAddress.slice(0, 10)}…{result.scanMetadata.walletAddress.slice(-8)}
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {loading && (
              <p style={{ fontSize: '12px', color: 'rgba(45,212,191,0.60)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>CORTEX reading wallet activity…</p>
            )}
            {!loading && !cortexRead && (
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.18)', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0 }}>
                Scan a wallet to generate a CORTEX wallet read.
              </p>
            )}
            {!loading && cortexRead && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <span style={{ padding: '4px 11px', borderRadius: '99px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.25)', color: '#2DD4BF', alignSelf: 'flex-start' }}>{cortexRead.verdict}</span>
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', padding: '10px 12px' }}>
                  <p style={{ margin: '0 0 5px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Portfolio Read</p>
                  <p style={{ margin: 0, fontSize: '12px', color: '#e2e8f0', lineHeight: 1.65 }}>{cortexRead.read}</p>
                </div>
                <div>
                  <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Key Signals</p>
                  {cortexRead.keySignals.map((line, i) => <p key={i} style={{ margin: '0 0 5px', fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>— {line}</p>)}
                </div>
                <div>
                  <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Risks / Missing Evidence</p>
                  {cortexRead.risks.map((line, i) => <p key={i} style={{ margin: '0 0 5px', fontSize: '12px', color: '#fca5a5', lineHeight: 1.5 }}>— {line}</p>)}
                </div>
                <div>
                  <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#475569', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Next Action</p>
                  <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.6 }}>{cortexRead.nextAction}</p>
                </div>
              </div>
            )}

            <div style={{ marginTop: '4px', background: 'rgba(45,212,191,0.035)', border: '1px solid rgba(45,212,191,0.12)', borderRadius: '14px', padding: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '9px', fontWeight: 800, color: 'rgba(45,212,191,0.70)', letterSpacing: '0.16em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Wallet Watchlist</p>
                  <p style={{ margin: '5px 0 0', fontSize: '11px', color: 'rgba(148,163,184,0.68)', lineHeight: 1.4 }}>Saved wallets stay here until you remove them.</p>
                </div>
                <button
                  type="button"
                  onClick={handleAddWalletToWatchlist}
                  disabled={!result?.scanMetadata?.walletAddress || watchlistStatus === 'saving'}
                  style={{ border: '1px solid rgba(45,212,191,0.30)', background: result?.scanMetadata?.walletAddress ? 'rgba(45,212,191,0.10)' : 'rgba(148,163,184,0.06)', color: result?.scanMetadata?.walletAddress ? '#2DD4BF' : 'rgba(148,163,184,0.35)', borderRadius: '999px', padding: '7px 10px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', cursor: result?.scanMetadata?.walletAddress && watchlistStatus !== 'saving' ? 'pointer' : 'not-allowed' }}
                >
                  {watchlistStatus === 'saving' ? 'Saving…' : 'Save'}
                </button>
              </div>

              {watchlistMessage && (
                <p style={{ margin: '0 0 10px', fontSize: '11px', color: watchlistStatus === 'error' ? '#f87171' : watchlistStatus === 'exists' ? '#7dd3fc' : '#4ade80', lineHeight: 1.4 }}>
                  {watchlistMessage}
                </p>
              )}

              {watchlistLoading ? (
                <p style={{ margin: 0, fontSize: '12px', color: 'rgba(148,163,184,0.55)' }}>Loading saved wallets…</p>
              ) : watchlistWallets.length === 0 ? (
                <p style={{ margin: 0, fontSize: '12px', color: 'rgba(148,163,184,0.45)', lineHeight: 1.55 }}>No saved wallets yet. Scan a wallet, then click Save.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {watchlistWallets.map((wallet) => {
                    const deleting = watchlistDeleting?.toLowerCase() === wallet.address.toLowerCase()
                    return (
                      <div key={wallet.id ?? wallet.address} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '10px', borderRadius: '11px', background: 'rgba(6,10,18,0.72)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <button type="button" onClick={() => setInput(wallet.address)} title="Load wallet address" style={{ minWidth: 0, flex: 1, textAlign: 'left', border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}>
                          <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px', color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}</p>
                          <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'rgba(148,163,184,0.55)' }}>{wallet.portfolio_value ? fmtUSD(wallet.portfolio_value) : 'Value not saved'}{wallet.label ? ` · ${wallet.label}` : ''}</p>
                        </button>
                        <button type="button" aria-label="Remove wallet from watchlist" disabled={deleting} onClick={() => handleRemoveWalletFromWatchlist(wallet.address)} style={{ width: '30px', height: '30px', flexShrink: 0, borderRadius: '9px', border: '1px solid rgba(248,113,113,0.22)', background: 'rgba(248,113,113,0.08)', color: deleting ? 'rgba(248,113,113,0.45)' : '#f87171', cursor: deleting ? 'wait' : 'pointer', fontSize: '14px', lineHeight: 1 }}>
                          🗑
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div style={{ flexShrink: 0, padding: '12px 22px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: '10px', color: 'rgba(255,255,255,0.16)', letterSpacing: '0.06em', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            CORTEX · Verified on-chain analysis only
          </div>
        </aside>
      </div>
    </>
  )
}
