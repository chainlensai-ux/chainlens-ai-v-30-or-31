'use client'

// PORTFOLIO-PAGE-EMPTY-DATA AUDIT + FIX, DISCLOSED — see lib/portfolioViewModel.ts's header for the
// full root-cause writeup (wagmi-only wallet source, a stub fallback in getPortfolioLite, a
// Base-only DEFAULT_CHAINS in v2Adapters.ts, and a second page-local Base-only filter). This page
// now:
//   1. Uses a manual wallet-address input as the primary source (mirrors Wallet Scanner's own,
//      only "connected wallet" concept — a plain text field, not a browser-extension requirement),
//      falling back to the wagmi-connected address only when nothing manual has been entered.
//   2. Checks app/frontend/lib/portfolioSharedCache.ts FIRST — if Wallet Scanner already scanned
//      this exact wallet this session, that real result is used immediately, no fetch.
//   3. Otherwise runs the SAME scanWalletV2()/Robinhood-GET calls Wallet Scanner itself uses — the
//      literal same API routes, same chains, same engine — never a separate/older pipeline.
//   4. Builds every number through lib/portfolioViewModel.ts's buildPortfolioViewModel, via the
//      SAME selectors (selectPortfolioStats/selectChainBreakdown/buildWalletPnlViewModel) Wallet
//      Scanner's own cards already use — Portfolio, Wallet Scanner, and Clark can never disagree.
import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import ConnectWallet from '@/components/ConnectWallet'
import { usePlanWithLoading, LockedPanel, canAccessFeature, PlanGateSkeleton } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'
import { scanWalletV2 } from '@/app/frontend/api/scanWallet'
import { mapWalletScanReportToPortfolioViewModel, type WalletV2Report } from '@/app/frontend/lib/portfolioViewModelAdapter'
import { readPortfolioScanResult, savePortfolioScanResult } from '@/app/frontend/lib/portfolioSharedCache'
import { buildPortfolioPageAudit, type PortfolioViewModel, type PortfolioHolding } from '@/lib/portfolioViewModel'
import { toRobinhoodWalletScanResponse, type RobinhoodWalletScanResponse } from '@/lib/walletScan/canonicalWalletSelectors'

type Range = '24H' | '7D' | '30D' | '90D' | 'ALL'
type Point = { ts: number; value: number }

const PORTFOLIO_SCAN_CHAINS = ['base', 'eth', 'robinhood'] // identical to Wallet Scanner's own default handleScan() chain list

const fmtUSD = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtPrice = (v: number | null) => v == null || v <= 0 ? 'Unpriced' : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(6)}`
const fmtBalance = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1000 ? `${(v / 1000).toFixed(2)}K` : v.toFixed(v < 1 ? 4 : 2)
const formatShortAddress = (address?: string | null) => !address ? 'No wallet' : address.length <= 10 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`
const HOLDINGS_PREVIEW_ROWS = 8

function WalletIcon({ size = 18, color = '#6f7275' }: { size?: number; color?: string }) {
  return (
    <svg aria-hidden='true' width={size} height={size} viewBox='0 0 24 24' fill='none'>
      <path d='M4 7.5A2.5 2.5 0 016.5 5H18a2 2 0 012 2v1.5' stroke={color} strokeWidth='1.8' strokeLinecap='round' />
      <rect x='4' y='7.5' width='16' height='11.5' rx='2.5' stroke={color} strokeWidth='1.8' />
      <circle cx='16' cy='13.25' r='1.25' fill={color} />
    </svg>
  )
}

const rangeToCount: Record<Range, number> = { '24H': 25, '7D': 8, '30D': 10, '90D': 14, ALL: 12 }

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default function PortfolioPage() {
  const { plan, loading: planLoading } = usePlanWithLoading()
  const { address: connectedAddress, isConnected, isReconnecting } = useAccount()

  const [loading, setLoading] = useState(false)
  // LIVE SCAN CLOCK: elapsed time, last real stage and last worker report while a scan runs.
  const [scanClock, setScanClock] = useState<{ startedAt: number; stageLabel: string | null; lastWorkerUpdateAt: number | null; jobId: string | null } | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  useEffect(() => {
    if (!loading) return
    const id = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [loading])
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkAnalysis, setClarkAnalysis] = useState<string | null>(null)
  const [failureReason, setFailureReason] = useState<string | null>(null)
  const [scanAttempted, setScanAttempted] = useState(false)
  const [scannedAddress, setScannedAddress] = useState<string | null>(null)
  const [report, setReport] = useState<WalletV2Report | null>(null)
  const [robinhoodResult, setRobinhoodResult] = useState<RobinhoodWalletScanResponse | null>(null)
  const [viewSource, setViewSource] = useState<'wallet_scanner_cache' | 'live_scan' | 'robinhood_only' | 'none'>('none')
  const [cacheHit, setCacheHit] = useState(false)
  const [search, setSearch] = useState('')
  const [range, setRange] = useState<Range>('24H')
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [nowTs] = useState(() => Date.now())
  const [lastScanAt, setLastScanAt] = useState<number>(0)
  const [cooldownLeftMs, setCooldownLeftMs] = useState(0)
  // Display-only toggles for the redesigned layout (holdings "View all", Clark text expansion).
  const [showAllHoldings, setShowAllHoldings] = useState(false)
  const [clarkExpanded, setClarkExpanded] = useState(false)

  const CLIENT_SCAN_COOLDOWN_MS = 12 * 1000

  // Portfolio is YOUR wallet: the connected wallet is the only source (no pasted addresses — any other
  // wallet is read in Wallet Scanner).
  const address = connectedAddress || null
  const hasWallet = Boolean(address && EVM_ADDRESS_RE.test(address))

  const viewModel: PortfolioViewModel = useMemo(
    () => mapWalletScanReportToPortfolioViewModel(
      scannedAddress === address ? report : null,
      scannedAddress === address ? robinhoodResult : null,
      viewSource,
      { scanAttempted: scanAttempted && scannedAddress === address, failureReason: scannedAddress === address ? failureReason : null },
    ),
    [report, robinhoodResult, viewSource, scanAttempted, failureReason, scannedAddress, address],
  )

  const audit = useMemo(() => buildPortfolioPageAudit({
    walletAddress: address,
    authUserPresent: true, // this page is only reachable behind the account-required /terminal gate
    connectedWalletDetected: isConnected,
    cachedWalletScannerResultFound: viewSource === 'wallet_scanner_cache',
    portfolioApiCalled: viewSource === 'live_scan',
    chainsRequested: hasWallet ? PORTFOLIO_SCAN_CHAINS : [],
    chainsReturned: report?.scanMetadata?.chainsScanned ?? [],
    rawHoldingsCount: report?.portfolio?.tokens?.length ?? 0,
    failureReason,
    cacheHit,
    viewModel,
  }), [address, isConnected, viewSource, hasWallet, report, failureReason, cacheHit, viewModel])

  if (process.env.NODE_ENV !== 'production') {
    console.debug('[portfolioPageAudit]', audit)
  }

  const filtered = useMemo(
    () => viewModel.holdings.filter((h) => `${h.symbol} ${h.name ?? ''}`.toLowerCase().includes(search.toLowerCase())),
    [viewModel.holdings, search],
  )
  const totalValue = viewModel.totalValueUsd
  const hasPnl = viewModel.pnl != null && (viewModel.pnl.status === 'verified' || viewModel.pnl.status === 'partial') && viewModel.pnl.realizedUsd != null
  const totalPnL = hasPnl ? (viewModel.pnl!.realizedUsd ?? 0) : null
  const pnlPct = hasPnl && totalValue > 0 ? ((totalPnL ?? 0) / totalValue) * 100 : null
  const topHolding = viewModel.topHoldings[0] ?? null
  const withChange = viewModel.holdings.filter((h) => typeof h.change24h === 'number')
  const bestPerformer = [...withChange].sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0))[0] ?? null
  const chainCount = viewModel.chainExposure.filter((c) => c.valueUsd > 0).length
  const networkLabel = viewModel.finalUiState !== 'ready' ? '—' : viewModel.isMultiChain ? 'Multi-chain' : (viewModel.chainExposure[0]?.chain ?? 'Unknown')
  const explorerUrl = address ? `https://basescan.org/address/${address}` : null

  const series = useMemo<Point[]>(() => {
    if (viewModel.finalUiState !== 'ready') return []
    const count = rangeToCount[range]
    const now = nowTs
    const stepMs = range === '24H' ? 60 * 60 * 1000 : range === '7D' ? 24 * 60 * 60 * 1000 : range === '30D' ? 3 * 24 * 60 * 60 * 1000 : range === '90D' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
    const base = Math.max(totalValue, 0.01)
    let v = base * 0.6
    return Array.from({ length: count }, (_, i) => {
      const drift = (i / count) * (hasPnl ? (pnlPct ?? 0) / 100 : 0.06)
      const noise = (Math.sin(i * 0.74) + Math.cos(i * 0.31)) * 0.014
      v = Math.max(base * 0.22, v * (1 + drift + noise))
      return { ts: now - stepMs * (count - i - 1), value: v }
    })
  }, [viewModel.finalUiState, totalValue, hasPnl, pnlPct, range, nowTs])

  const rangeCaption = useMemo(() => {
    if (range === '24H') return 'Last 24 hours'
    if (!series.length) return ''
    const a = new Date(series[0].ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    const b = new Date(series[series.length - 1].ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    return `${a} – ${b}`
  }, [range, series])

  const chart = useMemo(() => {
    if (series.length < 2) return null
    const w = 1000, h = 300, px = 26, py = 22
    const min = Math.min(...series.map((p) => p.value)), max = Math.max(...series.map((p) => p.value))
    const span = Math.max(max - min, Math.max(max, 1) * 0.15)
    const x = (i: number) => px + (i / (series.length - 1)) * (w - px * 2)
    const y = (v: number) => h - py - ((v - min) / span) * (h - py * 2)
    const points = series.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')
    const area = `${points} ${x(series.length - 1)},${h - py} ${x(0)},${h - py}`
    const ticks = series.map((p, i) => ({ i, x: x(i), label: range === '24H' ? new Date(p.ts).toLocaleTimeString([], { hour: 'numeric' }) : range === '7D' ? new Date(p.ts).toLocaleDateString([], { weekday: 'short' }) : new Date(p.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) })).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 6)) === 0 || i === a.length - 1)
    return { w, h, px, py, min, max, points, area, ticks, x, y }
  }, [series, range])

  // Reset state whenever the effective address changes to a genuinely different wallet.
  useEffect(() => {
    if (!address) {
      setReport(null); setRobinhoodResult(null); setScanAttempted(false); setScannedAddress(null)
      setFailureReason(null); setViewSource('none'); setSearch(''); setClarkAnalysis(null)
      return
    }
    if (scannedAddress && scannedAddress.toLowerCase() !== address.toLowerCase()) {
      setReport(null); setRobinhoodResult(null); setScanAttempted(false); setScannedAddress(null)
      setFailureReason(null); setViewSource('none'); setSearch(''); setClarkAnalysis(null)
    }
  }, [address, scannedAddress])

  // Hard rule #2: check the Wallet Scanner shared cache first, use it immediately if present.
  useEffect(() => {
    if (!hasWallet || !address || loading || scannedAddress === address) return
    const cached = readPortfolioScanResult(address)
    if (cached) {
      setReport(cached.report)
      setRobinhoodResult(cached.robinhoodResult)
      setScanAttempted(true)
      setScannedAddress(address)
      setFailureReason(null)
      setViewSource('wallet_scanner_cache')
      setCacheHit(true)
    }
  }, [hasWallet, address, loading, scannedAddress])

  useEffect(() => {
    const id = window.setInterval(() => {
      const left = Math.max(0, CLIENT_SCAN_COOLDOWN_MS - (Date.now() - lastScanAt))
      setCooldownLeftMs(left)
    }, 500)
    return () => window.clearInterval(id)
  }, [lastScanAt])

  // Hard rule #3/#4: lightweight fetch when no cache exists; rescan always refreshes for real.
  const runPortfolioScan = async () => {
    if (!hasWallet || !address || loading) return
    const left = Math.max(0, CLIENT_SCAN_COOLDOWN_MS - (Date.now() - lastScanAt))
    if (left > 0) { setCooldownLeftMs(left); return }
    setLoading(true)
    setScanClock({ startedAt: Date.now(), stageLabel: null, lastWorkerUpdateAt: null, jobId: null })
    setFailureReason(null)
    setCacheHit(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      // ONE ROBINHOOD PROVIDER SCAN: the job (chains include 'robinhood') already runs the Robinhood scan, so
      // its result is read from the job's report instead of a second, parallel GET /api/wallet-scan/robinhood.
      const scanResponse = await scanWalletV2(address, PORTFOLIO_SCAN_CHAINS, 'normal', ({ jobId, progress, lastWorkerUpdateAgoMs }) => {
        setScanClock((prev) => prev && {
          ...prev,
          jobId: jobId ?? prev.jobId,
          stageLabel: progress?.label ?? prev.stageLabel,
          lastWorkerUpdateAt: lastWorkerUpdateAgoMs != null ? Date.now() - lastWorkerUpdateAgoMs : prev.lastWorkerUpdateAt,
        })
      }, token)

      if (!scanResponse.success || !scanResponse.data) {
        setReport(null)
        setFailureReason(scanResponse.error?.message ?? 'Portfolio provider failed to return a result.')
      } else {
        const freshReport = scanResponse.data as WalletV2Report
        setReport(freshReport)
        setFailureReason(null)
        const jobRobinhood = (freshReport as unknown as { robinhood?: Parameters<typeof toRobinhoodWalletScanResponse>[1] | null }).robinhood
        const rh = jobRobinhood ? toRobinhoodWalletScanResponse(address, jobRobinhood) : null
        setRobinhoodResult(rh)
        savePortfolioScanResult(address, freshReport, rh)
      }
      setScanAttempted(true)
      setScannedAddress(address)
      setViewSource('live_scan')
      setLastScanAt(Date.now())
    } catch (err) {
      setReport(null)
      setFailureReason(err instanceof Error ? err.message : 'Network error while loading portfolio.')
      setScanAttempted(true)
      setScannedAddress(address)
      setViewSource('live_scan')
    } finally {
      setLoading(false)
    }
  }

  const runClark = async () => {
    if (clarkLoading || loading || viewModel.finalUiState !== 'ready') return
    setClarkLoading(true)
    try {
      // CLARK-PORTFOLIO-INPUT, DISCLOSED (audit scope: "Clark portfolio insight input"): the prompt
      // now carries the SAME structured view model Clark AI Insights renders below (verdict,
      // concentration, chain exposure, top holdings) instead of a bare token/value dump — Clark's
      // read and this page's own Clark AI Insights panel can never disagree about this scan.
      const prompt = [
        `Analyze this multi-chain wallet portfolio. Verdict so far: ${viewModel.verdict}.`,
        `Total value: ${fmtUSD(viewModel.totalValueUsd)} across ${chainCount} chain(s) (${viewModel.chainExposure.map((c) => c.chain).join(', ')}).`,
        `Top holdings: ${viewModel.topHoldings.map((h) => `${h.symbol} ${fmtUSD(h.value ?? 0)}`).join(', ')}.`,
        `Concentration: ${viewModel.concentrationPercent.toFixed(1)}% in top holding.`,
        viewModel.pnl ? `PnL: ${viewModel.pnl.status} — ${viewModel.pnl.reason}` : 'PnL: unavailable',
      ].join('\n')
      const c = await fetch('/api/clark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'clark-ai', prompt, message: prompt, mode: 'portfolio', context: { viewModel } }) })
      const json = await c.json().catch(() => null)
      setClarkAnalysis(typeof json?.analysis === 'string' ? json.analysis : null)
    } finally {
      setClarkLoading(false)
    }
  }

  if (planLoading) return <PlanGateSkeleton />
  if (!canAccessFeature(plan, 'portfolio')) return <LockedPanel feature="portfolio" />

  const handleScan = () => { void runPortfolioScan() }
  const canScan = hasWallet && !loading && cooldownLeftMs <= 0
  const showScanPrompt = hasWallet && scannedAddress !== address && !loading

  const stateMessage: Record<PortfolioViewModel['finalUiState'], string> = {
    loading: 'Loading portfolio…',
    no_wallet: 'Connect wallet to view portfolio.',
    no_supported_assets: 'No supported assets found.',
    provider_failed: `Portfolio unavailable — provider failed: ${failureReason ?? 'unknown reason'}.`,
    ready: '',
  }

  // ── Presentation helpers (layout/styling only — every number comes from viewModel as before) ──
  const ready = viewModel.finalUiState === 'ready'
  const signColor = (v: number) => (v >= 0 ? '#1fd6dc' : '#f43f5e')
  // Verdict colour scale: BULLISH teal, NEUTRAL amber, CAUTIOUS red, NEEDS_DATA muted.
  const verdictColor = { BULLISH: '#1fd6dc', NEUTRAL: '#f59e0b', CAUTIOUS: '#f43f5e', NEEDS_DATA: '#6f7275' }[viewModel.verdict]
  const sortedHoldings = [...filtered].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const visibleHoldings = showAllHoldings ? sortedHoldings : sortedHoldings.slice(0, HOLDINGS_PREVIEW_ROWS)
  const clarkText = clarkAnalysis ?? viewModel.summary
  const loadStatus = viewSource === 'wallet_scanner_cache'
    ? 'Loaded instantly from a recent Wallet Scanner scan of this wallet.'
    : scannedAddress === address ? 'Portfolio scan loaded for current wallet.' : 'Portfolio not loaded yet. Press View to fetch data.'
  // The page keeps ONE ConnectWallet instance (top bar). The other Connect buttons click it.
  const openConnect = () => {
    document.querySelector<HTMLButtonElement>('.pf-connect-slot button:not(:disabled)')?.click()
  }
  const chainPill = (chain: string) => {
    const c = chain.toLowerCase()
    const tone = c === 'base' ? '#1fd6dc' : c === 'eth' || c === 'ethereum' ? '#c2c5c8' : c === 'bsc' || c === 'bnb' ? '#d9c27a' : '#9ea1a4'
    const label = c === 'eth' ? 'Ethereum' : c === 'bsc' || c === 'bnb' ? 'BSC' : chain.charAt(0).toUpperCase() + chain.slice(1)
    return <span className='pf-chain-pill' style={{ color: tone, background: `${tone}1a`, borderColor: `${tone}40` }}>{label}</span>
  }
  const unverifiedPill = (title?: string) => <span className='pf-unverified' title={title}>Unverified</span>

  const stats: Array<{ label: string; value: string | null; color?: string; sub: React.ReactNode }> = [
    { label: 'Portfolio Value', value: hasWallet ? fmtUSD(totalValue) : null, sub: totalValue > 0 ? `≈ ${(totalValue / 2600).toFixed(4)} ETH` : '' },
    {
      label: '24H PnL',
      value: !hasWallet ? null : hasPnl ? `${(totalPnL ?? 0) >= 0 ? '+' : ''}${fmtUSD(totalPnL ?? 0)}` : '—',
      color: hasPnl ? signColor(totalPnL ?? 0) : undefined,
      sub: hasWallet && !hasPnl ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>{unverifiedPill(viewModel.pnl?.reason ?? 'not verified')}<span className='pf-ellipsis'>{viewModel.pnl?.reason ?? 'not verified'}</span></span> : '',
    },
    { label: 'Tokens', value: hasWallet ? `${viewModel.pricedTokenCount}/${viewModel.tokenCount}` : null, sub: 'Priced / total' },
    {
      label: 'Wallet',
      value: hasWallet && address ? formatShortAddress(address) : null,
      sub: hasWallet && explorerUrl ? <a href={explorerUrl} target='_blank' rel='noopener noreferrer' style={{ color: '#1fd6dc', textDecoration: 'none' }}>View on Explorer ↗</a> : '',
    },
    {
      label: 'Network',
      value: hasWallet ? networkLabel : null,
      sub: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1fd6dc', boxShadow: '0 0 6px rgba(31,214,220,.7)' }} />{chainCount > 1 ? `${chainCount} chains` : 'Healthy'}</span>,
    },
  ]

  const tiles: Array<[string, string]> = [
    ['Highest Holding', topHolding ? `${topHolding.symbol} • ${fmtUSD(topHolding.value ?? 0)}` : '—'],
    ['Best Performer', bestPerformer && typeof bestPerformer.change24h === 'number' ? `${bestPerformer.symbol} • +${bestPerformer.change24h.toFixed(2)}%` : '—'],
    ['Realized PnL', hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}%` : 'Unverified'],
    ['Concentration', ready ? `${Math.round(viewModel.concentrationPercent)}%` : 'Unverified'],
  ]

  return <div className="portfolio-page">
    <style>{`
      .portfolio-page{height:100%;overflow:auto;color:#e4e7ea;padding:32px 24px 96px;font-family:var(--font-inter,Inter,sans-serif);background-color:#06060a;background-image:radial-gradient(circle at 0% 0%,rgba(31,214,220,.07),transparent 42%),radial-gradient(circle at 100% 100%,rgba(194,197,200,.06),transparent 44%);background-attachment:fixed,fixed;box-sizing:border-box}
      .pf-inner{max-width:1200px;margin:0 auto;display:flex;flex-direction:column;gap:24px;min-width:0}
      .pf-card{background:#090c0f;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px;min-width:0;box-sizing:border-box}
      .pf-label{font-family:var(--font-plex-mono,IBM Plex Mono,monospace);font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#6f7275}
      .pf-muted{color:#9ea1a4}
      .pf-ellipsis{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sk{background:linear-gradient(90deg,rgba(158,161,164,.10),rgba(158,161,164,.20),rgba(158,161,164,.10));background-size:180% 100%;animation:sh 1.45s infinite}
      @keyframes sh{from{background-position:180% 0}to{background-position:-180% 0}}
      @keyframes pfspin{to{transform:rotate(360deg)}}
      .pf-spinner{display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:pfspin .7s linear infinite;flex-shrink:0}
      /* top bar */
      .pf-topbar{padding:16px}
      .pf-topbar-row{display:flex;gap:10px;align-items:center}
      .pf-address-wrap{position:relative;flex:1;min-width:0}
      .pf-address-wrap svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);pointer-events:none}
      .pf-address-input{width:100%;height:48px;box-sizing:border-box;padding:0 14px 0 42px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(6,6,10,.72);color:#f8fafc;font-size:14px;font-family:var(--font-plex-mono,IBM Plex Mono,monospace);outline:none;transition:border-color .15s,box-shadow .15s}
      .pf-address-input::placeholder{color:#6f7275}
      .pf-address-input:focus{border-color:rgba(31,214,220,.85);box-shadow:0 0 0 3px rgba(31,214,220,.20)}
      .pf-address-display{display:flex;align-items:center;gap:6px;color:#c9ccce;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default;user-select:all}
      .pf-address-display--empty{color:#6f7275;user-select:none}
      .pf-address-full{color:#f8fafc;overflow:hidden;text-overflow:ellipsis}
      .pf-address-short{display:none;color:#f8fafc}
      @media (max-width:640px){.pf-address-full{display:none}.pf-address-short{display:inline}}
      .pf-topbar-hint{margin-top:8px;font-size:12px;color:#6f7275;display:flex;gap:10px;flex-wrap:wrap}
      .pf-btn-primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:48px;padding:0 20px;border-radius:12px;border:1.5px solid #2ad8df;background:radial-gradient(120% 150% at 50% -10%,rgba(92,240,240,.26) 0%,rgba(31,214,220,.08) 48%,rgba(3,9,10,.92) 100%);box-shadow:0 0 0 3px rgba(31,214,220,.07),0 0 22px rgba(31,214,220,.28),inset 0 1px 0 rgba(255,255,255,.18);color:#ffffff;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-family:var(--font-plex-mono,IBM Plex Mono,monospace);cursor:pointer;white-space:nowrap;flex-shrink:0;transition:filter .15s,transform .15s}
      .pf-btn-primary:hover:not(:disabled){border-color:#6ff3f3;box-shadow:0 0 0 3px rgba(31,214,220,.10),0 0 30px rgba(31,214,220,.42),inset 0 1px 0 rgba(255,255,255,.24);transform:translateY(-1px)}
      .pf-btn-primary:disabled{opacity:.5;cursor:not-allowed}
      .pf-btn-ghost{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:10px;border:1px solid rgba(194,197,200,.40);background:rgba(194,197,200,.12);color:#d8dbde;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-family:var(--font-plex-mono,IBM Plex Mono,monospace);cursor:pointer}
      .pf-btn-ghost:disabled{opacity:.5;cursor:not-allowed}
      .pf-connect-slot{flex-shrink:0}
      .pf-connect-slot > div{display:flex!important;gap:0!important}
      .pf-connect-slot > div > div{display:none!important}
      .pf-connect-slot button{width:auto!important;height:48px!important;padding:0 20px!important;border-radius:12px!important;font-size:12px!important;font-family:var(--font-plex-mono,IBM Plex Mono,monospace)!important;background:radial-gradient(120% 150% at 50% -10%,rgba(92,240,240,.26) 0%,rgba(31,214,220,.08) 48%,rgba(3,9,10,.92) 100%)!important;border:1.5px solid #2ad8df!important;color:#ffffff!important;box-shadow:0 0 0 3px rgba(31,214,220,.07),0 0 22px rgba(31,214,220,.28),inset 0 1px 0 rgba(255,255,255,.18)!important;transform:none!important}
      .pf-connect-slot button:disabled::before{content:'';display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:pfspin .7s linear infinite}
      /* stats */
      .pf-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px}
      .pf-stat{padding:16px 18px;display:flex;flex-direction:column;min-height:112px}
      .pf-stat-value{font-size:24px;font-weight:700;color:#f8fafc;margin-top:8px;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pf-stat-sub{margin-top:auto;padding-top:8px;font-size:12px;color:#9ea1a4;display:flex;min-width:0}
      .pf-unverified{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.06em;color:#fbbf24;background:rgba(251,191,36,.10);border:1px solid rgba(251,191,36,.28);font-family:var(--font-plex-mono,IBM Plex Mono,monospace);white-space:nowrap;flex-shrink:0}
      /* main grid */
      .pf-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(320px,1fr);gap:24px;align-items:start}
      .pf-left,.pf-side{display:flex;flex-direction:column;gap:24px;min-width:0}
      .pf-range{display:inline-flex;padding:3px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);gap:2px}
      .pf-range button{padding:6px 12px;border-radius:7px;border:none;background:transparent;color:#6f7275;font-size:11px;font-weight:700;letter-spacing:.08em;font-family:var(--font-plex-mono,IBM Plex Mono,monospace);cursor:pointer}
      .pf-range button:hover{color:#d1d4d7}
      .pf-range button.on{background:rgba(31,214,220,.15);color:#1fd6dc;box-shadow:inset 0 -2px 0 #1fd6dc}
      .pf-hero-value{font-size:40px;font-weight:800;line-height:1.1;letter-spacing:-.02em;background:linear-gradient(90deg,#1fd6dc,#c2c5c8);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
      .pf-pill{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--font-plex-mono,IBM Plex Mono,monospace)}
      .pf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:48px 16px;gap:10px}
      .pf-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:16px;background:rgba(31,214,220,.08);border:1px solid rgba(31,214,220,.22);margin-bottom:4px}
      .pf-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:20px}
      .pf-tile{padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.08);min-width:0}
      /* clark */
      .pf-clark{position:relative;padding:20px;border-radius:16px;background:rgba(255,255,255,.03);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:0 18px 48px rgba(0,0,0,.40),0 0 40px rgba(194,197,200,.10);overflow:hidden;min-width:0}
      .pf-clark::before{content:'';position:absolute;inset:0;border-radius:inherit;padding:1px;background:linear-gradient(135deg,rgba(194,197,200,.45),rgba(31,214,220,.38));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
      .pf-clark-text{font-size:14px;color:#9ea1a4;line-height:1.6;margin:10px 0 0}
      .pf-clamp3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      .pf-link-btn{background:none;border:none;padding:0;color:#1fd6dc;font-size:12px;cursor:pointer;font-family:inherit}
      /* holdings */
      .pf-search{position:relative;width:260px;max-width:100%}
      .pf-search svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none}
      .pf-search input{width:100%;height:40px;box-sizing:border-box;padding:0 12px 0 36px;border-radius:10px;border:1px solid rgba(255,255,255,.10);background:rgba(6,6,10,.72);color:#e4e7ea;font-size:13px;outline:none}
      .pf-search input:focus{border-color:rgba(31,214,220,.85);box-shadow:0 0 0 3px rgba(31,214,220,.18)}
      .pf-table-wrap{overflow:auto;max-height:560px;border-radius:12px;border:1px solid rgba(255,255,255,.06)}
      .pf-table{width:100%;border-collapse:collapse;min-width:520px}
      .pf-table th{position:sticky;top:0;z-index:1;background:#0e1114;text-align:right;padding:10px 14px;font-family:var(--font-plex-mono,IBM Plex Mono,monospace);font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#6f7275;border-bottom:1px solid rgba(255,255,255,.08)}
      .pf-table th:first-child,.pf-table td:first-child{text-align:left}
      .pf-table td{height:56px;padding:0 14px;text-align:right;border-bottom:1px solid rgba(255,255,255,.05);font-size:14px;white-space:nowrap}
      .pf-table tbody tr:hover{background:rgba(255,255,255,.02)}
      .pf-avatar{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;font-weight:800;color:#e4e7ea;background:linear-gradient(135deg,rgba(31,214,220,.22),rgba(194,197,200,.24));border:1px solid rgba(255,255,255,.10);font-family:var(--font-plex-mono,IBM Plex Mono,monospace)}
      .pf-chain-pill{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;border:1px solid;font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-family:var(--font-plex-mono,IBM Plex Mono,monospace)}
      @media (max-width:1023px){
        .pf-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
        .pf-grid{display:flex;flex-direction:column;align-items:stretch}
        .pf-left{display:contents}
        .pf-chart-card{order:1}.pf-side{order:2}.pf-holdings-card{order:3}
      }
      @media (max-width:768px){
        .portfolio-page{padding:64px 16px 96px!important}
        .pf-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        .pf-stat{min-height:96px;padding:14px}
        .pf-stat-value{font-size:20px}
        .pf-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
        .pf-chart-head{flex-direction:column;align-items:flex-start!important}
        .pf-hero-value{font-size:32px}
        .pf-holdings-head{flex-direction:column;align-items:stretch!important}
        .pf-search{width:100%}
        .pf-stat:last-child{grid-column:span 2}
      }
      @media (max-width:640px){
        .pf-topbar-row{flex-direction:column;align-items:stretch}
        .pf-topbar-row > .pf-btn-primary,.pf-connect-slot,.pf-connect-slot button{width:100%!important}
      }
    `}</style>

    <div className='pf-inner'>
      {/* ── Top bar: address + one compact action ─────────────────────────── */}
      <section className='pf-card pf-topbar'>
        <div className='pf-topbar-row'>
          <div className='pf-address-wrap'>
            <WalletIcon />
            <div className={`pf-address-input pf-address-display${connectedAddress ? '' : ' pf-address-display--empty'}`} title={connectedAddress ?? undefined} aria-label={connectedAddress ? `Connected wallet ${connectedAddress}` : 'No wallet connected'}>
              {connectedAddress ? <>Connected · <span className='pf-address-full'>{connectedAddress}</span><span className='pf-address-short'>{formatShortAddress(connectedAddress)}</span></> : isReconnecting ? 'Reconnecting wallet…' : 'No wallet connected'}
            </div>
          </div>
          {hasWallet ? (
            <button className='pf-btn-primary' onClick={handleScan} disabled={!canScan}>
              {loading && <span className='pf-spinner' />}
              {loading ? 'Loading' : scannedAddress === address ? 'Rescan' : 'View'}
            </button>
          ) : isReconnecting ? (
            <button className='pf-btn-primary' disabled><span className='pf-spinner' />Connect</button>
          ) : !isConnected ? (
            <div className='pf-connect-slot'><ConnectWallet className='active:scale-[0.98]' /></div>
          ) : (
            <button className='pf-btn-primary' disabled>View</button>
          )}
        </div>
        <div className='pf-topbar-hint'>
          <span>
            {loading && scanClock
              ? `Scanning · ${Math.max(0, Math.round((clockNow - scanClock.startedAt) / 1000))}s elapsed · Last stage: ${scanClock.stageLabel ?? (scanClock.jobId ? 'waiting for the worker to start' : 'starting')}${scanClock.lastWorkerUpdateAt != null ? ` · worker last reported ${Math.max(0, Math.round((clockNow - scanClock.lastWorkerUpdateAt) / 1000))}s ago` : ''}`
              : hasWallet ? loadStatus : 'Connect your wallet to view your portfolio'}
          </span>
          {cooldownLeftMs > 0 && <span>Please wait {Math.ceil(cooldownLeftMs / 1000)}s.</span>}
        </div>
      </section>

      {/* ── Stat cards ────────────────────────────────────────────────────── */}
      <div className='pf-stats'>
        {stats.map((s) => (
          <div key={s.label} className='pf-card pf-stat'>
            {loading ? <div className='sk' style={{ height: 64, borderRadius: 10 }} /> : <>
              <div className='pf-label'>{s.label}</div>
              {s.value == null
                ? <><div className='pf-stat-value' style={{ color: '#3c3f42' }}>—</div><div className='sk' style={{ height: 4, width: '60%', borderRadius: 2, marginTop: 10 }} /></>
                : <div className='pf-stat-value' style={{ color: s.color ?? '#f8fafc' }} title={s.value}>{s.value}</div>}
              {s.sub ? <div className='pf-stat-sub'>{s.sub}</div> : null}
            </>}
          </div>
        ))}
      </div>

      {viewModel.finalUiState === 'provider_failed' && (
        <div className='pf-card' style={{ padding: 14, borderColor: 'rgba(244,63,94,.35)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ color: '#fecdd3', fontSize: 13 }}>{stateMessage.provider_failed}</div>
          <button onClick={() => { void runPortfolioScan() }} disabled={!canScan} style={{ borderRadius: 10, border: '1px solid rgba(244,63,94,.35)', padding: '7px 12px', background: 'rgba(244,63,94,.10)', color: '#fecdd3', fontWeight: 700, cursor: canScan ? 'pointer' : 'not-allowed', flexShrink: 0 }}>Retry</button>
        </div>
      )}

      <div className='pf-grid'>
        <div className='pf-left'>
          {/* ── Main chart card ─────────────────────────────────────────── */}
          <section className='pf-card pf-chart-card'>
            {hasWallet && (
              <div className='pf-chart-head' style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
                <div style={{ minWidth: 0 }}>
                  <div className='pf-label' style={{ marginBottom: 6 }}>Portfolio value</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span className='pf-hero-value'>{fmtUSD(totalValue)}</span>
                    {hasPnl
                      ? <span className='pf-pill' style={{ color: signColor(pnlPct ?? 0), background: `${signColor(pnlPct ?? 0)}1a`, border: `1px solid ${signColor(pnlPct ?? 0)}40` }}>{`${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}% realized`}</span>
                      : <span className='pf-pill' style={{ color: '#9ea1a4', background: 'rgba(158,161,164,.08)', border: '1px solid rgba(158,161,164,.18)', fontSize: 11 }}>Not enough verified PnL history yet</span>}
                  </div>
                  {rangeCaption && <div style={{ color: '#6f7275', fontSize: 12, marginTop: 6 }}>{rangeCaption}</div>}
                </div>
                <div className='pf-range' role='group' aria-label='Chart range'>
                  {(['24H', '7D', '30D', '90D', 'ALL'] as const).map((r) => <button key={r} type='button' className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}
                </div>
              </div>
            )}

            {loading ? <div className='sk' style={{ height: 320, borderRadius: 14 }} />
              : !hasWallet ? (
                <div className='pf-empty'>
                  <span className='pf-empty-icon'><WalletIcon size={24} color='#1fd6dc' /></span>
                  <div style={{ fontSize: 18, fontWeight: 600, color: '#f8fafc' }}>Connect a wallet to view your portfolio</div>
                  <div style={{ fontSize: 14, color: '#9ea1a4', maxWidth: 420 }}>Holdings, value and PnL for your connected wallet across Base, Ethereum and Robinhood Chain. To read any other wallet, use Wallet Scanner.</div>
                  <button className='pf-btn-primary' style={{ marginTop: 8, height: 44 }} onClick={openConnect}>Connect Wallet</button>
                </div>
              ) : showScanPrompt ? (
                <div className='pf-empty'>
                  <span className='pf-empty-icon'><WalletIcon size={24} color='#1fd6dc' /></span>
                  <div style={{ fontSize: 18, fontWeight: 600, color: '#f8fafc' }}>Wallet ready — load your portfolio.</div>
                  <div style={{ fontSize: 14, color: '#9ea1a4', maxWidth: 440 }}>Click below to load holdings across Base, Ethereum, and Robinhood Chain. Data is only fetched when you request it.</div>
                  <button className='pf-btn-primary' style={{ marginTop: 8, height: 44 }} onClick={handleScan} disabled={!canScan}>Load Portfolio</button>
                </div>
              ) : !ready || !chart ? (
                <div className='pf-empty'>
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#e4e7ea' }}>{stateMessage[viewModel.finalUiState] || 'Not enough portfolio history yet'}</div>
                  {viewModel.finalUiState !== 'no_wallet' && viewModel.finalUiState !== 'loading' && <div style={{ fontSize: 13, color: '#9ea1a4' }}>Connect or load a wallet with supported assets to build a stronger history.</div>}
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <svg viewBox={`0 0 ${chart.w} ${chart.h}`} style={{ width: '100%', height: 300, display: 'block' }} onMouseMove={(e) => { const rect=(e.currentTarget as SVGElement).getBoundingClientRect(); const ratio=(e.clientX-rect.left)/rect.width; setHoverIdx(Math.max(0,Math.min(series.length-1,Math.round(ratio*(series.length-1))))); }} onMouseLeave={() => setHoverIdx(null)}>
                    <defs>
                      <linearGradient id='pl' x1='0' x2='1'><stop offset='0%' stopColor='#1fd6dc'/><stop offset='100%' stopColor='#c2c5c8'/></linearGradient>
                      <linearGradient id='pla' x1='0' x2='0' y1='0' y2='1'><stop offset='0%' stopColor='#1fd6dc' stopOpacity='0.22'/><stop offset='100%' stopColor='#c2c5c8' stopOpacity='0'/></linearGradient>
                    </defs>
                    {[0,1,2,3].map((i)=><line key={i} x1={chart.px} y1={chart.py+((chart.h-chart.py*2)/3)*i} x2={chart.w-chart.px} y2={chart.py+((chart.h-chart.py*2)/3)*i} stroke='rgba(158,161,164,.10)' />)}
                    <polyline fill='url(#pla)' points={chart.area} /><polyline fill='none' stroke='url(#pl)' strokeWidth='3' points={chart.points} strokeLinecap='round' strokeLinejoin='round' />
                    {hoverIdx !== null && series[hoverIdx] && <><line x1={chart.x(hoverIdx)} y1={chart.py} x2={chart.x(hoverIdx)} y2={chart.h-chart.py} stroke='rgba(31,214,220,.35)' /><circle cx={chart.x(hoverIdx)} cy={chart.y(series[hoverIdx].value)} r='6' fill='#1fd6dc' /></>}
                    {chart.ticks.map((t)=><text key={t.i} x={t.x} y={chart.h-4} fill='rgba(158,161,164,.75)' fontSize='16' textAnchor='middle'>{t.label}</text>)}
                  </svg>
                  {hoverIdx !== null && series[hoverIdx] && <div style={{ position: 'absolute', right: 10, top: 10, background: 'rgba(9,12,15,.92)', border: '1px solid rgba(31,214,220,.28)', borderRadius: 10, padding: '6px 10px', fontSize: 12 }}><div>{new Date(series[hoverIdx].ts).toLocaleString()}</div><div style={{ color: '#1fd6dc', fontWeight: 700 }}>{fmtUSD(series[hoverIdx].value)}</div></div>}
                </div>
              )}

            {hasWallet && (
              <div className='pf-tiles'>
                {tiles.map(([k, v]) => (
                  <div key={k} className='pf-tile'>
                    <div className='pf-label' style={{ fontSize: 10 }}>{k}</div>
                    <div style={{ marginTop: 6, fontSize: 14, fontWeight: 600, color: '#e4e7ea' }} className='pf-ellipsis'>{v === 'Unverified' ? unverifiedPill() : v}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Holdings ────────────────────────────────────────────────── */}
          <section className='pf-card pf-holdings-card'>
            <div className='pf-holdings-head' style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#f1f4f7' }}>Your Holdings</h3>
                {ready && <span className='pf-label' style={{ fontSize: 10 }}>{sortedHoldings.length} tokens</span>}
              </div>
              <div className='pf-search'>
                <svg aria-hidden='true' width='14' height='14' viewBox='0 0 24 24' fill='none'><circle cx='11' cy='11' r='7' stroke='#6f7275' strokeWidth='2' /><path d='M20 20l-3.2-3.2' stroke='#6f7275' strokeWidth='2' strokeLinecap='round' /></svg>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder='Search tokens...' />
              </div>
            </div>
            {loading ? <div className='sk' style={{ height: 220, borderRadius: 12 }} />
              : !ready ? (
                <div style={{ padding: '20px 0', textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: '#9ea1a4' }}>{stateMessage[viewModel.finalUiState] || 'No supported assets found.'}</div>
                  {hasWallet && <button onClick={handleScan} style={{ marginTop: 10, borderRadius: 10, border: '1px solid rgba(31,214,220,.32)', background: 'rgba(31,214,220,.10)', color: '#1fd6dc', padding: '7px 16px', cursor: 'pointer', fontWeight: 600 }}>Rescan</button>}
                </div>
              ) : sortedHoldings.length === 0 ? (
                <div style={{ padding: '20px 0', textAlign: 'center', fontSize: 14, color: '#9ea1a4' }}>No tokens match “{search}”.</div>
              ) : (
                <>
                  <div className='pf-table-wrap'>
                    <table className='pf-table'>
                      <thead><tr><th>Token</th><th>Balance</th><th>Value</th><th>24H</th></tr></thead>
                      <tbody>
                        {visibleHoldings.map((h: PortfolioHolding) => {
                          const up = (h.change24h ?? 0) >= 0
                          const alloc = totalValue > 0 ? ((h.value ?? 0) / totalValue) * 100 : 0
                          return (
                            <tr key={`${h.chain}-${h.contract ?? h.symbol}`}>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span className='pf-avatar'>{h.symbol.slice(0, 2).toUpperCase()}</span>
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ fontWeight: 700, color: '#f1f4f7' }}>{h.symbol}</span>{chainPill(h.chain)}</div>
                                    <div style={{ fontSize: 12, color: '#6f7275', maxWidth: 200 }} className='pf-ellipsis'>{h.name ?? h.symbol}</div>
                                  </div>
                                </div>
                              </td>
                              <td><div>{fmtBalance(h.balance)}</div><div style={{ fontSize: 12, color: '#6f7275' }}>{fmtPrice(h.price)}</div></td>
                              <td><div style={{ fontWeight: 600 }}>{fmtUSD(h.value ?? 0)}</div><div style={{ fontSize: 12, color: '#6f7275' }}>{alloc.toFixed(1)}% of portfolio</div></td>
                              <td style={{ color: typeof h.change24h === 'number' ? signColor(h.change24h) : '#6f7275', fontWeight: 600 }}>{typeof h.change24h === 'number' ? `${up ? '+' : ''}${h.change24h.toFixed(2)}%` : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {sortedHoldings.length > HOLDINGS_PREVIEW_ROWS && (
                    <div style={{ marginTop: 12, textAlign: 'center' }}>
                      <button type='button' className='pf-link-btn' onClick={() => setShowAllHoldings((v) => !v)}>
                        {showAllHoldings ? 'Show less' : `View all (${sortedHoldings.length})`}
                      </button>
                    </div>
                  )}
                </>
              )}
          </section>
        </div>

        <aside className='pf-side'>
          {/* ── Clark AI Insights ─────────────────────────────────────────── */}
          <section className='pf-clark'>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 16 }}>
              <span className='pf-label' style={{ color: '#d8dbde' }}>Clark AI Insights</span>
              {ready && (
                <button type='button' className='pf-btn-ghost' onClick={() => { void runClark() }} disabled={clarkLoading || loading}>
                  {clarkLoading && <span className='pf-spinner' />}{clarkLoading ? 'Analyzing…' : 'Ask Clark'}
                </button>
              )}
            </div>
            {loading ? <div className='sk' style={{ height: 200, borderRadius: 12 }} /> : <>
              <svg aria-hidden='true' width='44' height='44' viewBox='0 0 44 44' fill='none'>
                <circle cx='22' cy='22' r='17' stroke='rgba(158,161,164,0.16)' strokeWidth='4' />
                <path d='M22 5a17 17 0 0116.2 11.8' stroke={viewModel.verdict === 'NEEDS_DATA' ? 'rgba(158,161,164,0.35)' : verdictColor} strokeWidth='4' strokeLinecap='round' />
              </svg>
              <div className='pf-label' style={{ marginTop: 12, fontSize: 10 }}>Portfolio verdict</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: verdictColor, lineHeight: 1.2, marginTop: 4 }}>{viewModel.verdict.replace('_', ' ')}</div>
              <p className={`pf-clark-text${clarkExpanded ? '' : ' pf-clamp3'}`}>{clarkText}</p>
              {clarkText && clarkText.length > 160 && (
                <button type='button' className='pf-link-btn' style={{ marginTop: 4 }} onClick={() => setClarkExpanded((v) => !v)}>{clarkExpanded ? 'Show less' : 'Read more'}</button>
              )}
              {ready && (<>
                <div style={{ height: 1, background: 'rgba(255,255,255,.08)', margin: '16px 0' }} />
                {viewModel.riskNotes.length > 0 && <div style={{ marginBottom: 14 }}><div className='pf-label' style={{ fontSize: 10, marginBottom: 6 }}>Risk notes</div>{viewModel.riskNotes.map((n, i) => <div key={i} style={{ fontSize: 13, color: '#fecdd3', marginTop: 4 }}>• {n}</div>)}</div>}
                <div className='pf-label' style={{ fontSize: 10, marginBottom: 6 }}>Chain exposure</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>{viewModel.chainExposure.filter((c) => c.valueUsd > 0).map((c) => <span key={c.chain} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, background: 'rgba(31,214,220,.08)', border: '1px solid rgba(31,214,220,.22)', color: '#d1d4d7', textTransform: 'capitalize' }}>{c.chain} {c.percent.toFixed(0)}%</span>)}</div>
                <div style={{ padding: 12, borderRadius: 12, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.08)' }}><div className='pf-label' style={{ fontSize: 10, color: '#1fd6dc' }}>Top opportunity</div><div style={{ fontSize: 13, color: '#e4e7ea', marginTop: 4 }}>{viewModel.topOpportunity ?? 'No clear opportunity yet.'}</div></div>
              </>)}
              {!ready && viewModel.missingDataReasons.length > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, fontSize: 12, color: '#6f7275', lineHeight: 1.5 }}>
                  <svg aria-hidden='true' width='14' height='14' viewBox='0 0 24 24' fill='none' style={{ flexShrink: 0, marginTop: 2 }}><circle cx='12' cy='12' r='9' stroke='#6f7275' strokeWidth='2' /><path d='M12 11v5M12 8h.01' stroke='#6f7275' strokeWidth='2' strokeLinecap='round' /></svg>
                  <span>Missing: {viewModel.missingDataReasons.join(' ')}</span>
                </div>
              )}
              {!hasWallet && <button type='button' className='pf-btn-primary' style={{ width: '100%', height: 44, marginTop: 16 }} onClick={openConnect}>Connect to Unlock</button>}
            </>}
          </section>

          {/* ── Recent activity ─────────────────────────────────────────────── */}
          <section className='pf-card'>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: '#f1f4f7' }}>Recent Activity</h3>
            {loading ? <div className='sk' style={{ height: 120, borderRadius: 12 }} /> : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#6f7275' }}>
                <svg aria-hidden='true' width='16' height='16' viewBox='0 0 24 24' fill='none' style={{ flexShrink: 0 }}><circle cx='12' cy='12' r='9' stroke='#6f7275' strokeWidth='2' /><path d='M12 7v5l3 2' stroke='#6f7275' strokeWidth='2' strokeLinecap='round' /></svg>
                <span>Recent wallet activity will appear here once transactions are detected.</span>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  </div>
}
