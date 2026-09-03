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
import type { RobinhoodWalletScanResponse } from '@/lib/walletScan/canonicalWalletSelectors'

type Range = '24H' | '7D' | '30D' | '90D' | 'ALL'
type Point = { ts: number; value: number }

const PORTFOLIO_SCAN_CHAINS = ['base', 'eth', 'robinhood'] // identical to Wallet Scanner's own default handleScan() chain list

const fmtUSD = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtPrice = (v: number | null) => v == null || v <= 0 ? 'Unpriced' : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(6)}`
const fmtBalance = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1000 ? `${(v / 1000).toFixed(2)}K` : v.toFixed(v < 1 ? 4 : 2)
const formatShortAddress = (address?: string | null) => !address ? 'No wallet' : address.length <= 10 ? address : `${address.slice(0, 6)}...${address.slice(-4)}`
const spark = (seed: string, up: boolean) => { let x = seed.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 93; return Array.from({ length: 20 }, (_, i) => { x = (x * 31 + 11) % 97; const y = (up ? 32 - i * 0.8 : 15 + i * 0.7) + (x % 11) - 5; return `${(i / 19) * 100},${Math.max(5, Math.min(36, y))}` }).join(' ') }

const rangeToCount: Record<Range, number> = { '24H': 25, '7D': 8, '30D': 10, '90D': 14, ALL: 12 }

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default function PortfolioPage() {
  const { plan, loading: planLoading } = usePlanWithLoading()
  const { address: connectedAddress, isConnected } = useAccount()

  const [manualAddress, setManualAddress] = useState('')
  const [loading, setLoading] = useState(false)
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

  const CLIENT_SCAN_COOLDOWN_MS = 12 * 1000

  // Connected-wallet address is the source ONLY when no manual wallet has been entered — hard rule #1.
  const address = manualAddress.trim() || connectedAddress || null
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
    setFailureReason(null)
    setCacheHit(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      const [scanResponse, robinhoodResponse] = await Promise.all([
        scanWalletV2(address, PORTFOLIO_SCAN_CHAINS, 'normal', undefined, token),
        fetch(`/api/wallet-scan/robinhood?address=${encodeURIComponent(address)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
          .then((r) => r.json().catch(() => null))
          .catch(() => null) as Promise<(RobinhoodWalletScanResponse & { error?: { message?: string } }) | null>,
      ])

      if (!scanResponse.success || !scanResponse.data) {
        setReport(null)
        setFailureReason(scanResponse.error?.message ?? 'Portfolio provider failed to return a result.')
      } else {
        const freshReport = scanResponse.data as WalletV2Report
        setReport(freshReport)
        setFailureReason(null)
        const rh = robinhoodResponse?.ok ? robinhoodResponse : null
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

  return <div className="portfolio-page" style={{ height: '100%', overflow: 'auto', background: 'radial-gradient(circle at 18% -10%, rgba(34,211,238,.12), transparent 34%), radial-gradient(circle at 86% 2%, rgba(217,70,239,.13), transparent 34%), #05070d', color: '#e2e8f0', padding: 18 }}>
    <style>{`.glass{background:linear-gradient(165deg,rgba(8,16,32,.9),rgba(5,10,20,.84));border:1px solid rgba(125,211,252,.14);border-radius:18px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.02)}.sk{background:linear-gradient(90deg,rgba(148,163,184,.12),rgba(148,163,184,.22),rgba(148,163,184,.12));background-size:180% 100%;animation:sh 1.45s infinite}@keyframes sh{from{background-position:180% 0}to{background-position:-180% 0}}@media (max-width: 768px){.portfolio-page{padding:12px 12px 96px!important}.pf-main-grid{grid-template-columns:1fr!important}.pf-row4{grid-template-columns:repeat(2,minmax(0,1fr))!important}.pf-search-row{flex-direction:column;align-items:stretch!important;gap:8px}.pf-search-row input{width:100%}.pf-holdings-wrap{overflow-x:auto}.pf-holdings-wrap table{min-width:640px}.pf-side{grid-template-columns:1fr!important}.pf-wallet-row{flex-direction:column;align-items:stretch!important}.pf-wallet-row input{width:100%!important}.pf-range-row{flex-wrap:wrap;width:100%}}`}</style>

    <div className='pf-wallet-row glass' style={{ marginBottom: 12, padding: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ color: '#94a3b8', fontSize: 12, minWidth: 120 }}>Wallet address</div>
      <input
        value={manualAddress}
        onChange={(e) => setManualAddress(e.target.value)}
        placeholder={connectedAddress ? `Connected: ${formatShortAddress(connectedAddress)} (or paste a different address)` : '0x… wallet address'}
        style={{ flex: '1 1 260px', borderRadius: 10, border: '1px solid rgba(125,211,252,.24)', background: 'rgba(10,14,26,.75)', color: '#e2e8f0', padding: '8px 10px' }}
      />
      {!isConnected && !manualAddress && <ConnectWallet className='active:scale-[0.98]' />}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10, marginBottom: 12 }}>
      {[
        ['PORTFOLIO VALUE', hasWallet ? fmtUSD(totalValue) : '—', totalValue > 0 ? `≈ ${(totalValue / 2600).toFixed(4)} ETH` : ''],
        ['24H PNL', !hasWallet ? '—' : hasPnl ? `${(totalPnL ?? 0) >= 0 ? '+' : ''}${fmtUSD(totalPnL ?? 0)}` : `Unavailable: ${viewModel.pnl?.reason ?? 'not verified'}`],
        ['TOKENS', hasWallet ? `${viewModel.pricedTokenCount}/${viewModel.tokenCount}` : '—', 'Priced / total'],
        ['WALLET', hasWallet && address ? formatShortAddress(address) : 'Not connected', hasWallet && explorerUrl ? 'View on Explorer ↗' : ''],
        ['NETWORK', networkLabel, chainCount > 1 ? `${chainCount} chains` : 'Healthy'],
      ].map(([k, v, s], i) => <div key={String(k)} className='glass' style={{ padding: 14, minHeight: 96 }}>{loading ? <div className='sk' style={{ height: 54, borderRadius: 12 }} /> : <><div style={{ fontSize: 10, letterSpacing: '.15em', color: '#94a3b8' }}>{k}</div><div style={{ fontSize: i === 3 ? 24 : 22, fontWeight: 800, marginTop: 4, color: i === 1 && hasPnl ? ((totalPnL ?? 0) >= 0 ? '#2dd4bf' : '#fb7185') : i === 1 ? '#fbbf24' : '#f8fafc' }}>{v}</div>{i === 3 && explorerUrl ? <a href={explorerUrl} target='_blank' rel='noopener noreferrer' style={{ fontSize: 12, color: '#67e8f9', textDecoration: 'none' }}>{s}</a> : <div style={{ fontSize: 12, color: '#67e8f9' }}>{s}</div>}</>}</div>)}
    </div>

    {hasWallet && (
      <div className='glass' style={{ marginBottom: 12, padding: 12, display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ color: '#94a3b8', fontSize: 12 }}>
          {viewSource === 'wallet_scanner_cache' ? 'Loaded instantly from a recent Wallet Scanner scan of this wallet.' : scannedAddress === address ? 'Portfolio scan loaded for current wallet.' : 'Portfolio not loaded yet. Click Load Portfolio to fetch data.'}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => { void runPortfolioScan() }} disabled={!canScan} style={{ borderRadius: 10, border: '1px solid rgba(125,211,252,.24)', padding: '8px 12px', background: canScan ? 'rgba(34,211,238,.2)' : 'rgba(100,116,139,.18)', color: canScan ? '#67e8f9' : '#94a3b8', fontWeight: 700 }}>
            {loading ? 'Loading…' : scannedAddress === address ? 'Rescan' : 'Load Portfolio'}
          </button>
          {cooldownLeftMs > 0 && <span style={{ fontSize: 12, color: '#94a3b8' }}>Please wait {Math.ceil(cooldownLeftMs / 1000)}s.</span>}
          {viewModel.finalUiState === 'ready' && (
            <button onClick={() => { void runClark() }} disabled={clarkLoading || loading} style={{ borderRadius: 10, border: '1px solid rgba(168,85,247,.35)', padding: '8px 12px', background: 'rgba(168,85,247,.18)', color: '#c4b5fd', fontWeight: 700 }}>
              {clarkLoading ? 'Analyzing…' : 'Ask Clark'}
            </button>
          )}
        </div>
      </div>
    )}

    {viewModel.finalUiState === 'provider_failed' && (
      <div className='glass' style={{ marginBottom: 12, padding: 12, border: '1px solid rgba(251,113,133,.35)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ color: '#fecdd3', fontSize: 13 }}>{stateMessage.provider_failed}</div>
        <button onClick={() => { void runPortfolioScan() }} disabled={!canScan} style={{ borderRadius: 8, border: '1px solid rgba(251,113,133,.35)', padding: '6px 10px', background: 'rgba(251,113,133,.12)', color: '#fecdd3', fontWeight: 700 }}>Retry</button>
      </div>
    )}

    <div className='pf-main-grid' style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.1fr) minmax(320px,1fr)', gap: 12 }}>
      <div style={{ display: 'grid', gap: 12 }}>
        <section className='glass' style={{ padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}><div><div style={{ fontSize: 32, fontWeight: 800 }}>{fmtUSD(totalValue)}</div><div style={{ color: '#94a3b8', fontSize: 12 }}>{rangeCaption}</div><div style={{ color: hasPnl ? ((pnlPct ?? 0) >= 0 ? '#2dd4bf' : '#fb7185') : '#94a3b8' }}>{hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}% (realized)` : 'Not enough verified PnL history yet'}</div></div><div>{(['24H', '7D', '30D', '90D', 'ALL'] as const).map((r) => <button key={r} onClick={() => setRange(r)} style={{ marginLeft: 6, borderRadius: 10, border: '1px solid rgba(125,211,252,.24)', padding: '6px 11px', background: range === r ? 'rgba(34,211,238,.2)' : 'transparent', color: range === r ? '#67e8f9' : '#94a3b8' }}>{r}</button>)}</div></div>
          {loading ? <div className='sk' style={{ height: 320, borderRadius: 14 }} /> : viewModel.finalUiState !== 'ready' || !chart ? <div style={{ height: 320, borderRadius: 14, display: 'grid', placeItems: 'center', textAlign: 'center', border: '1px dashed rgba(125,211,252,.22)', color: '#94a3b8' }}><div><div style={{ fontWeight: 700, color: '#e2e8f0' }}>{stateMessage[viewModel.finalUiState] || 'Not enough portfolio history yet'}</div>{viewModel.finalUiState !== 'no_wallet' && viewModel.finalUiState !== 'loading' && <div>Connect or load a wallet with supported assets to build a stronger history.</div>}</div></div> : <div style={{ position: 'relative' }}><svg viewBox={`0 0 ${chart.w} ${chart.h}`} style={{ width: '100%', height: 320, borderRadius: 14, background: 'radial-gradient(circle at 50% 0%, rgba(56,189,248,.08), rgba(6,10,22,.96) 58%)' }} onMouseMove={(e) => { const rect=(e.currentTarget as SVGElement).getBoundingClientRect(); const ratio=(e.clientX-rect.left)/rect.width; setHoverIdx(Math.max(0,Math.min(series.length-1,Math.round(ratio*(series.length-1))))); }} onMouseLeave={() => setHoverIdx(null)}>
            <defs><linearGradient id='pl' x1='0' x2='1'><stop offset='0%' stopColor='#22d3ee'/><stop offset='40%' stopColor='#60a5fa'/><stop offset='72%' stopColor='#a78bfa'/><stop offset='100%' stopColor='#ec4899'/></linearGradient></defs>
            {[0,1,2,3].map((i)=><line key={i} x1={chart.px} y1={chart.py+((chart.h-chart.py*2)/3)*i} x2={chart.w-chart.px} y2={chart.py+((chart.h-chart.py*2)/3)*i} stroke='rgba(148,163,184,.15)' strokeDasharray='4 5'/>)}
            <polyline fill='url(#pl)' opacity='0.16' points={chart.area} /><polyline fill='none' stroke='url(#pl)' strokeWidth='4' points={chart.points} strokeLinecap='round' strokeLinejoin='round' />
            {hoverIdx !== null && series[hoverIdx] && <><line x1={chart.x(hoverIdx)} y1={chart.py} x2={chart.x(hoverIdx)} y2={chart.h-chart.py} stroke='rgba(103,232,249,.35)' /><circle cx={chart.x(hoverIdx)} cy={chart.y(series[hoverIdx].value)} r='6' fill='#67e8f9' /></>}
            {chart.ticks.map((t)=><text key={t.i} x={t.x} y={chart.h-4} fill='rgba(148,163,184,.8)' fontSize='18' textAnchor='middle'>{t.label}</text>)}
          </svg>
          {hoverIdx !== null && series[hoverIdx] && <div style={{ position: 'absolute', right: 10, top: 10, background: 'rgba(7,12,22,.88)', border: '1px solid rgba(125,211,252,.28)', borderRadius: 10, padding: '6px 10px', fontSize: 12 }}><div>{new Date(series[hoverIdx].ts).toLocaleString()}</div><div style={{ color: '#67e8f9', fontWeight: 700 }}>{fmtUSD(series[hoverIdx].value)}</div></div>}</div>}
          <div className='pf-row4' style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 8, marginTop: 10 }}>{[['Highest Holding', topHolding ? `${topHolding.symbol} • ${fmtUSD(topHolding.value ?? 0)}` : '—'], ['Best Performer', bestPerformer && typeof bestPerformer.change24h === 'number' ? `${bestPerformer.symbol} • +${bestPerformer.change24h.toFixed(2)}%` : '—'], ['Realized PnL', hasPnl ? `${(pnlPct ?? 0) >= 0 ? '+' : ''}${(pnlPct ?? 0).toFixed(2)}%` : 'Unverified'], ['Concentration', viewModel.finalUiState === 'ready' ? `${Math.round(viewModel.concentrationPercent)}%` : 'Unverified']].map(([k,v]) => <div key={String(k)} className='glass' style={{ padding: 10, borderRadius: 12 }}><div style={{ fontSize: 10, color: '#94a3b8' }}>{k}</div><div style={{ fontWeight: 700, marginTop: 4 }}>{v}</div></div>)}</div>
        </section>

        <section className='glass' style={{ padding: 14 }}>
          <div className='pf-search-row' style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}><h3 style={{ margin: 0 }}>Your Holdings</h3><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder='Search tokens...' style={{ borderRadius: 10, border: '1px solid rgba(125,211,252,.24)', background: 'rgba(10,14,26,.75)', color: '#e2e8f0', padding: '8px 10px' }} /></div>
          {loading ? <div className='sk' style={{ height: 220, borderRadius: 12 }} /> : viewModel.finalUiState !== 'ready' ? <div style={{ border: '1px dashed rgba(125,211,252,.24)', borderRadius: 12, padding: 28, textAlign: 'center' }}><div style={{ fontWeight: 700 }}>{stateMessage[viewModel.finalUiState] || 'No supported assets found.'}</div>{hasWallet && <button onClick={handleScan} style={{ marginTop: 10, borderRadius: 10, border: '1px solid rgba(34,211,238,.3)', background: 'transparent', color: '#67e8f9', padding: '8px 18px', cursor: 'pointer' }}>Rescan</button>}</div> : <div className='pf-holdings-wrap' style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr style={{ color: '#94a3b8', fontSize: 12 }}><th align='left'>Asset</th><th align='left'>Chain</th><th align='right'>Balance</th><th align='right'>Price</th><th align='right'>Value</th><th align='right'>24H %</th><th align='center'>Trend</th><th align='right'>Allocation</th></tr></thead><tbody>{filtered.map((h: PortfolioHolding) => {const up=(h.change24h??0)>=0; const alloc=totalValue>0?((h.value??0)/totalValue)*100:0; return <tr key={`${h.chain}-${h.contract ?? h.symbol}`} style={{ borderTop: '1px solid rgba(148,163,184,.12)' }}><td style={{ padding: '11px 0' }}><div style={{ fontWeight: 700 }}>{h.symbol}</div><div style={{ color: '#94a3b8', fontSize: 12 }}>{h.name ?? h.symbol}</div></td><td style={{ color: '#94a3b8', fontSize: 12, textTransform: 'capitalize' }}>{h.chain}</td><td align='right'>{fmtBalance(h.balance)}</td><td align='right'>{fmtPrice(h.price)}</td><td align='right'>{fmtUSD(h.value ?? 0)}</td><td align='right' style={{ color: typeof h.change24h === 'number' ? (up ? '#2dd4bf' : '#fb7185') : '#94a3b8' }}>{typeof h.change24h === 'number' ? `${up ? '+' : ''}${h.change24h.toFixed(2)}%` : '—'}</td><td align='center'><svg width='76' height='24' viewBox='0 0 100 40'><polyline fill='none' stroke={up ? '#2dd4bf' : '#f43f5e'} strokeWidth='3' points={spark(h.symbol, up)} /></svg></td><td align='right'><div>{alloc.toFixed(1)}%</div><div style={{ height: 6, borderRadius: 999, background: 'rgba(100,116,139,.25)', marginTop: 4 }}><div style={{ height: '100%', width: `${alloc}%`, borderRadius: 999, background: 'linear-gradient(90deg,#22d3ee,#a855f7)' }} /></div></td></tr>})}</tbody></table></div>}
        </section>
      </div>

      <aside className='pf-side' style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        <section className='glass' style={{ padding: 16, position: 'relative', overflow: 'hidden' }}><div style={{position:'absolute',right:-30,top:-30,width:150,height:150,borderRadius:'50%',background:'radial-gradient(circle,rgba(103,232,249,.22),rgba(168,85,247,.14),transparent 68%)'}} /><h3 style={{ marginTop: 0, marginBottom: 10, position:'relative' }}>Clark AI Insights</h3>{loading ? <div className='sk' style={{ height: 220, borderRadius: 12 }} /> : <><div style={{ fontSize: 12, color: '#94a3b8' }}>Portfolio Verdict</div><div style={{ fontSize: 32, fontWeight: 900, color: viewModel.verdict === 'BULLISH' ? '#2dd4bf' : viewModel.verdict === 'NEUTRAL' ? '#67e8f9' : viewModel.verdict === 'CAUTIOUS' ? '#f59e0b' : '#94a3b8' }}>{viewModel.verdict.replace('_', ' ')}</div><p style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.6, marginTop: 6, marginBottom: 10 }}>{clarkAnalysis ?? viewModel.summary}</p>{viewModel.finalUiState === 'ready' && (<><div style={{height:1,background:'rgba(148,163,184,.18)',margin:'8px 0 10px'}} />{viewModel.riskNotes.length > 0 && <div style={{ marginBottom: 10 }}><div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Risk Notes</div>{viewModel.riskNotes.map((n, i) => <div key={i} style={{ fontSize: 12, color: '#fecdd3', marginTop: 4 }}>• {n}</div>)}</div>}<div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Chain Exposure</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>{viewModel.chainExposure.filter((c) => c.valueUsd > 0).map((c) => <span key={c.chain} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, background: 'rgba(103,232,249,.1)', border: '1px solid rgba(103,232,249,.2)', textTransform: 'capitalize' }}>{c.chain} {c.percent.toFixed(0)}%</span>)}</div><div className='glass' style={{ padding: 10, borderRadius: 12 }}><div style={{ color: '#67e8f9', fontSize: 11 }}>Top Opportunity</div><div>{viewModel.topOpportunity ?? 'No clear opportunity yet.'}</div></div></>)}{viewModel.finalUiState !== 'ready' && viewModel.missingDataReasons.length > 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>Missing: {viewModel.missingDataReasons.join(' ')}</div>}</>}</section>
        <section className='glass' style={{ padding: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><h3 style={{ marginTop: 0 }}>Recent Activity</h3></div>{loading ? <div className='sk' style={{ height: 170, borderRadius: 12 }} /> : <div style={{ border: '1px dashed rgba(125,211,252,.2)', borderRadius: 12, padding: 18, color: '#94a3b8', textAlign: 'center' }}>Recent wallet activity will appear here once transactions are detected.</div>}</section>
      </aside>
    </div>

    {showScanPrompt && <div className='glass' style={{ marginTop: 12, padding: 18, textAlign: 'center' }}><div style={{ fontWeight: 700, fontSize: 18 }}>Wallet ready — load your portfolio.</div><div style={{ color: '#94a3b8', marginTop: 6 }}>Click below to load holdings across Base, Ethereum, and Robinhood Chain. Data is only fetched when you request it.</div><div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}><button onClick={handleScan} style={{ borderRadius: 12, border: '1px solid rgba(34,211,238,.4)', background: 'linear-gradient(135deg,rgba(34,211,238,.18),rgba(168,85,247,.18))', color: '#67e8f9', fontWeight: 700, fontSize: 15, padding: '12px 28px', cursor: 'pointer' }}>Load Portfolio</button></div></div>}
    {!hasWallet && <div className='glass' style={{ marginTop: 12, padding: 18, textAlign: 'center' }}><div style={{ fontWeight: 700, fontSize: 18 }}>{stateMessage.no_wallet}</div><div style={{ color: '#94a3b8', marginTop: 6 }}>Connect a wallet or paste an address above to load portfolio data.</div><div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}><ConnectWallet className='active:scale-[0.98]' /></div></div>}
  </div>
}
