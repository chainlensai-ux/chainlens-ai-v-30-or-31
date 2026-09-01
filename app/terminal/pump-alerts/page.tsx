'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { usePlanWithLoading, LockedPanel, canAccessFeature, PlanGateSkeleton } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'
import {
  type PumpAlert,
  type PumpCategory,
  type PumpFeedAudit,
  type FilterKey,
  CATEGORY_LABEL,
  CATEGORY_COLOR,
  FILTER_CHIPS,
  RISK_LABEL,
  fmtUSD,
  AlertCard,
  SummaryStrip,
  prefetchReportForAlert,
  openReportForAlert,
} from './pumpAlertsUi'

export default function PumpAlertsPage() {
  const { plan, loading: planLoading } = usePlanWithLoading()
  const router = useRouter()
  // INSTANT-REPORT-NAV FIX, DISCLOSED: tracks which report URLs have already been prefetched
  // (card hover) so repeated hovers/re-renders never re-issue the same prefetch call.
  const prefetchedReportUrls = useRef<Set<string>>(new Set())
  const [alerts, setAlerts] = useState<PumpAlert[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  // `loading` is the first-paint skeleton only and never returns to true; `refreshing` drives the
  // non-blocking "refreshing" indicator so a background refresh never tears down a good feed.
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  // TRUTHFUL, SPECIFIC EMPTY STATE, DISCLOSED: finalState drives which real empty-state message
  // renders; candidateAudit backs the "why is this empty" rejection breakdown so a small/zero
  // result is never presented as an undifferentiated "no pump signals".
  const [finalState, setFinalState] = useState<
    'providerUnavailable' | 'noRawCandidates' | 'noneQualified' | 'finalRendered' | null
  >(null)
  const [candidateAudit, setCandidateAudit] = useState<PumpFeedAudit | null>(null)
  const [countdown, setCountdown] = useState(120)
  const [activeFilter, setActiveFilter] = useState<FilterKey>('ALL')
  const [refreshKey, setRefreshKey] = useState(0)
  // LOAD MORE, DISCLOSED (requested: initial render shows 8-10 alerts, Load More appends the next
  // 8-10 client-side — the backend has no cursor/page param, so this paginates over the already-
  // fetched `alerts` array without ever refetching). Reset only when the active filter changes, not
  // on every background refresh, so a user who's expanded the feed doesn't lose that on auto-refresh.
  const PAGE_SIZE = 10
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [loadMoreLoading, setLoadMoreLoading] = useState(false)
  const [loadMoreClicks, setLoadMoreClicks] = useState(0)
  const loadMoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // COPY-CA, DISCLOSED (requested: pump alerts cards had no way to grab the contract address).
  // Tracks which contract was just copied so its button shows "✓ Copied" briefly.
  const [copiedContract, setCopiedContract] = useState<string | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // OPTIMISTIC COPY FEEDBACK, DISCLOSED (button-responsiveness task): the "✓ Copied" pressed state
  // used to be set only inside writeText's resolved .then() — real on every modern browser, but
  // still a network-free async hop the click had to wait through before showing anything. Now the
  // pressed state is set synchronously, before the (still real) clipboard write is even issued; if
  // that write genuinely fails (permissions, non-secure context), the optimistic state is rolled
  // back immediately rather than left showing a false "Copied".
  function copyCA(contract: string) {
    const key = contract.toLowerCase()
    setCopiedContract(key)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopiedContract(null), 1600)
    navigator.clipboard?.writeText(contract).then(
      () => { /* optimistic state already showing — nothing further to do on success */ },
      () => {
        // ROLLBACK, DISCLOSED: the copy did not actually happen — never leave a fake "Copied" state
        // showing for a write that failed.
        setCopiedContract((current) => (current === key ? null : current))
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      },
    )
  }

  // PUMP-CHAIN-SELECTOR, DISCLOSED (requested: load more Base <$20M, ETH <$50M, Robinhood <$20M
  // low caps). Which chains to scan — sent to /api/pump-alerts as ?chains=; default is all three
  // (the API silently drops Robinhood when its feature flag is off server-side).
  type PumpChainKey = 'base' | 'eth' | 'robinhood'
  const CHAIN_CHIPS: Array<{ key: PumpChainKey; label: string }> = [
    { key: 'base', label: 'Base' },
    { key: 'eth', label: 'ETH' },
    { key: 'robinhood', label: 'Robinhood' },
  ]
  const [activeChains, setActiveChains] = useState<Set<PumpChainKey>>(new Set(['base', 'eth', 'robinhood']))

  // NON-BLANKING REFRESH + HONEST FAILURES, DISCLOSED (full Radar/Pump audit): this previously
  // called setAlerts([]) on any error and replaced alerts with [] whenever a response had no
  // `alerts` key — so a single failed background refresh wiped a good feed to an empty state that
  // looked like "no pumps found" rather than "the request failed". It also discarded the route's
  // error/chainsFailed entirely, hiding provider outages. Now: last-good results are retained on
  // failure, and the real reason is surfaced instead of being swallowed.
  const fetchAlerts = useCallback(() => {
    setRefreshing(true)
    return (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token
        const qs = new URLSearchParams()
        if (chainParamRef.current.length > 0) qs.set('chains', chainParamRef.current.join(','))
        const res = await fetch(`/api/pump-alerts?${qs.toString()}`, {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        const json = await res.json()
        if (Array.isArray(json.alerts)) {
          setAlerts(json.alerts)
          setFetchedAt(json.fetchedAt ?? null)
          // A partial scan still returns real alerts — show them AND say which chains are missing.
          setFeedError(typeof json.error === 'string' ? json.error : null)
          setFinalState(typeof json.finalState === 'string' ? json.finalState : null)
          setCandidateAudit(json.pumpFeedAudit && typeof json.pumpFeedAudit === 'object' ? json.pumpFeedAudit : null)
        } else {
          // No usable payload: keep whatever is already on screen and explain why it didn't update.
          setFeedError(typeof json.error === 'string' ? json.error : 'Pump feed request failed. Showing last known results.')
        }
      } catch {
        setFeedError('Could not reach the pump feed. Showing last known results.')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    })()
  }, [])

  // Keep the latest chain selection readable inside the stable fetchAlerts callback without
  // re-creating it. Updated directly in event handlers (not via a sync effect), so the ref is
  // always current by the time fetchAlerts() is called.
  const chainParamRef = useRef<Array<PumpChainKey>>(['base', 'eth', 'robinhood'])

  useEffect(() => { fetchAlerts() }, [fetchAlerts])

  useEffect(() => {
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { setRefreshKey(k => k + 1); return 120 }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (refreshKey > 0) { fetchAlerts(); setCountdown(120) }
  }, [refreshKey, fetchAlerts])

  // CHAIN-STRICT HANDOFF, DISCLOSED (full Radar/Pump audit): these three handoffs all assumed Base.
  // openToken passed no chain at all and openReport hardcoded `chain: 'base'`, so once Pump Alerts
  // went multi-chain an ETH or Robinhood token was scanned and reported against the WRONG network
  // (Token Scanner's URL autodetect defaults to Base when no chain param is present). Base Radar's
  // equivalent handoff was already fixed in an earlier audit; this brings Pump Alerts in line with
  // it, including omitting the param for Base so existing Base links stay byte-for-byte identical.
  function openToken(alert: PumpAlert) {
    const chainQuery = alert.chain === 'base' ? '' : `&chain=${alert.chain}`
    router.push(`/terminal/token-scanner?contract=${alert.contract}${chainQuery}`)
  }

  function prefetchReport(alert: PumpAlert) {
    prefetchReportForAlert(router, prefetchedReportUrls.current, alert)
  }

  function openReport(alert: PumpAlert) {
    openReportForAlert(router, prefetchedReportUrls.current, alert)
  }

  function openClark(alert: PumpAlert) {
    // The Chain line is load-bearing, not decoration: without it Clark reasoned about (and could
    // look up) a Robinhood/ETH contract as if it were on Base. Base Radar's prompt already states
    // its chain for exactly this reason.
    const chainName = alert.chain === 'robinhood' ? 'Robinhood Chain' : alert.chain === 'eth' ? 'Ethereum' : 'Base'
    const prompt = [
      '[mode: pump-alerts]',
      `Chain: ${chainName}`,
      `Token: ${alert.name} (${alert.symbol})`,
      `Contract: ${alert.contract}`,
      `Category: ${CATEGORY_LABEL[alert.category]}`,
      `14d Change: ${alert.change14d != null ? `+${alert.change14d.toFixed(1)}%` : 'N/A'}`,
      `24h Change: ${alert.change24h != null ? `${(alert.change24h >= 0 ? '+' : '')}${alert.change24h.toFixed(1)}%` : 'N/A'}`,
      `Volume 24h: ${fmtUSD(alert.volume24hUsd)}`,
      `Liquidity: ${fmtUSD(alert.liquidityUsd)}`,
      `FDV: ${fmtUSD(alert.fdvUsd ?? alert.marketCapUsd)}`,
      `Risk: ${RISK_LABEL[alert.riskLevel]}`,
      `Signal: ${alert.reason}`,
      `Qualified because: ${alert.qualifyingReason}`,
    ].join('\n')
    router.push(`/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}`)
  }

  const filtered = useMemo(() =>
    activeFilter === 'ALL' ? alerts : alerts.filter(a => a.category === activeFilter),
    [alerts, activeFilter],
  )

  // Reset pagination to the first page only when the filter actually changes — not on every
  // background refresh, so Load More progress survives an auto-refresh (requirement: "Refresh keeps
  // existing cards visible" / "Do not reset filters when loading more"). Adjusted during render
  // (React's documented pattern for state that must reset when a prop/value changes) rather than in
  // a useEffect, since setState-in-effect triggers an extra render pass and an eslint error.
  const [prevActiveFilterForReset, setPrevActiveFilterForReset] = useState(activeFilter)
  if (activeFilter !== prevActiveFilterForReset) {
    setPrevActiveFilterForReset(activeFilter)
    setVisibleCount(PAGE_SIZE)
  }

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const hasMore = visibleCount < filtered.length

  function handleLoadMore() {
    setLoadMoreClicks(c => c + 1)
    setLoadMoreLoading(true)
    if (loadMoreTimerRef.current) clearTimeout(loadMoreTimerRef.current)
    // Purely client-side — the alerts are already fetched, this only reveals more of them. The
    // brief delay is deliberate UI feedback (requirement: "button should have loading state"), not
    // a real fetch — no network call happens here.
    loadMoreTimerRef.current = setTimeout(() => {
      setVisibleCount(c => Math.min(filtered.length, c + PAGE_SIZE))
      setLoadMoreLoading(false)
    }, 180)
  }

  // UI AUDIT, DISCLOSED: exact shape requested — answers "what is actually on screen and why" for
  // the pagination/market-cap-availability layer, distinct from the backend's discovery-side audits.
  const pumpAlertsUiAudit = useMemo(() => ({
    totalAlertsFromApi: alerts.length,
    initialRenderedCount: Math.min(PAGE_SIZE, filtered.length),
    currentRenderedCount: visible.length,
    hasMore,
    marketCapAvailableCount: alerts.filter(a => a.marketCapUsd != null).length,
    marketCapMissingCount: alerts.filter(a => a.marketCapUsd == null).length,
    fdvAvailableCount: alerts.filter(a => a.fdvUsd != null).length,
    loadMoreClicks,
    activeFilter,
    activeChains: Array.from(activeChains),
  }), [alerts, filtered.length, visible.length, hasMore, loadMoreClicks, activeFilter, activeChains])

  useEffect(() => {
    console.debug('[pumpAlertsUiAudit]', pumpAlertsUiAudit)
  }, [pumpAlertsUiAudit])

  // SKELETON, NOT A TEXT WALL, DISCLOSED (performance + UX optimization task): this was a
  // full-screen "Loading plan access…" wall that ALSO rendered into the SSR HTML, so it flashed on
  // every single load even for a user whose plan was already cached. PlanGateSkeleton mirrors the
  // page's real rhythm so nothing jumps when content replaces it, and the shared account store now
  // only reports loading:true when there is genuinely no cached plan to trust.
  if (planLoading) return <PlanGateSkeleton />
  if (!canAccessFeature(plan, 'pump-alerts')) return <LockedPanel feature="pump-alerts" />

  return (
    <>
      <style>{`
        @keyframes pumpSlideIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes livePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(236,72,153,0.6); }
          50%       { opacity: 0.6; box-shadow: 0 0 0 5px rgba(236,72,153,0); }
        }
        @keyframes spinRefresh {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes tagPulse {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-1px) scale(1.035); }
        }
        @keyframes clarkIntelGlow {
          0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.055), 0 0 22px rgba(168,85,247,0.070), 0 0 34px rgba(45,212,191,0.045); }
          50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.065), 0 0 28px rgba(168,85,247,0.105), 0 0 44px rgba(34,211,238,0.060); }
        }
        @keyframes flameMomentumPulse {
          0%, 100% { transform: scale(1); opacity: 0.18; }
          50% { transform: scale(1.018); opacity: 0.28; }
        }
        .pump-card { position: relative; isolation: isolate; }
        .pump-card::before {
          content: '';
          position: absolute;
          inset: 10px auto 10px 0;
          width: 4px;
          border-radius: 0 999px 999px 0;
          background: linear-gradient(180deg, var(--pump-identity-color), rgba(168,85,247,0.72), rgba(34,211,238,0.46));
          box-shadow: 0 0 16px color-mix(in srgb, var(--pump-identity-color) 36%, transparent), 0 0 26px rgba(45,212,191,0.055);
          opacity: 0.86;
          z-index: 1;
        }
        .pump-card > * { position: relative; z-index: 2; }
        .pump-flame { position: relative; display: inline-flex; align-items: center; justify-content: center; }
        .pump-flame::before {
          content: '';
          position: absolute;
          inset: -4px;
          border-radius: 999px;
          background: radial-gradient(circle, rgba(34,211,238,0.16), rgba(168,85,247,0.055) 42%, transparent 70%);
          animation: flameMomentumPulse 3.8s ease-in-out infinite;
          z-index: -1;
        }
        .pump-pill { transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease; }
        .pump-pill:hover { animation: tagPulse 760ms ease-in-out; box-shadow: 0 0 16px rgba(45,212,191,0.10), 0 0 22px rgba(168,85,247,0.08); }
        .pump-action-btn:hover { transform: translateY(-2px) scale(1.045) !important; box-shadow: 0 0 18px rgba(45,212,191,0.20), 0 0 22px rgba(168,85,247,0.12) !important; }
        .pump-clark-preview { max-height: 0; opacity: 0; overflow: hidden; transform: translateY(-4px); transition: max-height 220ms ease, opacity 180ms ease, transform 180ms ease; }
        .pump-card:hover .pump-clark-preview { max-height: 74px; opacity: 1; transform: translateY(0); }
        .pump-card:hover .pump-clark-intel { animation: clarkIntelGlow 3.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .pump-card, .pump-pill, .pump-action-btn, .pump-clark-preview, .pump-card:hover .pump-clark-intel, .pump-flame::before { animation: none !important; transition: none !important; }
        }
        @media (max-width: 768px) {
          /* 60px top clears the fixed hamburger button (top:12 + height:36 + 12 buffer) */
          .pump-main        { padding: 60px 12px 120px !important; }
          /* target the actual grid div inside SummaryStrip */
          .pump-strip > div { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
          .pump-header-row  { padding-left: 0 !important; }
          /* MOBILE FIX, DISCLOSED (requested: "no horizontal overflow"): 340px minmax columns are too
             wide to fit a ~375-414px viewport once the page's own side padding is subtracted, so force
             a single column below the tablet breakpoint rather than letting auto-fill try to squeeze
             a second narrow column. */
          .pump-card-grid-container { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 640px) {
          /* Cards stack cleanly: identity/badges wrap onto their own lines, metric grid drops to 3
             columns so labels/values stay readable instead of being clipped, actions stay a full-width
             row of equal-width buttons. */
          .pump-card-top    { flex-wrap: wrap !important; row-gap: 8px !important; }
          .pump-card-top > div:last-child { max-width: 100% !important; justify-content: flex-start !important; }
          .pump-card-grid   { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
          .pump-card-actions { flex-wrap: wrap !important; }
        }
      `}</style>

      <div className="pump-main" style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '28px 32px 120px', color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>

        {/* Header */}
        <div style={{ marginBottom: '20px' }}>
          <div className="pump-header-row" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#f8fafc', margin: 0, letterSpacing: '-0.01em' }}>
              Pump Alerts
            </h1>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '4px 10px', borderRadius: '99px',
              background: 'rgba(236,72,153,0.12)', border: '1px solid rgba(236,72,153,0.30)',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#ec4899',
              fontFamily: 'var(--font-plex-mono)',
            }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ec4899', animation: 'livePulse 1.8s ease-in-out infinite', flexShrink: 0 }} />
              LIVE
            </span>
          </div>
          <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 16px' }}>
            Ranked by momentum, volume, liquidity, and CORTEX quality filters. Not financial advice.
          </p>

          <div className="pump-strip">
            <SummaryStrip alerts={alerts} />
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
            <span style={{ fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
              Refresh in {countdown}s
            </span>
            <button
              onClick={() => { setCountdown(60); fetchAlerts() }}
              disabled={loading}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '5px 12px', borderRadius: '8px',
                background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.20)',
                color: loading ? '#3a5268' : '#2DD4BF',
                fontSize: '10px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'
                style={{ animation: loading ? 'spinRefresh 0.8s linear infinite' : 'none' }}>
                <path d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' />
                <path d='M21 3v5h-5' />
                <path d='M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' />
                <path d='M8 16H3v5' />
              </svg>
              {loading ? 'Scanning…' : 'Refresh'}
            </button>
            {fetchedAt && (
              <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
                Updated {new Date(fetchedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Filter chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {FILTER_CHIPS.map(chip => {
              const active = chip.key === activeFilter
              const color = chip.key !== 'ALL' ? CATEGORY_COLOR[chip.key as PumpCategory] : '#2DD4BF'
              return (
                <button
                  key={chip.key}
                  onClick={() => setActiveFilter(chip.key)}
                  style={{
                    padding: '5px 11px', borderRadius: '99px', fontSize: '9px', fontWeight: 700,
                    letterSpacing: '0.10em', textTransform: 'uppercase', cursor: 'pointer',
                    border: `1px solid ${active ? `${color}55` : 'rgba(255,255,255,0.10)'}`,
                    background: active ? `${color}1c` : 'rgba(255,255,255,0.03)',
                    color: active ? color : '#94a3b8',
                    fontFamily: 'var(--font-plex-mono)',
                    boxShadow: active ? `0 0 12px ${color}18` : 'none',
                    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
                  }}
                >
                  {chip.label}
                  {chip.key !== 'ALL' && (
                    <span style={{ marginLeft: '5px', opacity: 0.60 }}>
                      {alerts.filter(a => a.category === chip.key).length}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Chain selector, DISCLOSED: isolate-then-toggle. Default is all three. Clicking a
              chain while all are selected used to DESELECT that chain (click BASE → ETH+ROBINHOOD),
              which requested the wrong pair and surfaced "Provider unavailable for: eth, robinhood".
              With all selected, a click isolates that chain; later clicks add/toggle. Never empty;
              never mutate the existing Set. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', margin: '8px 0 4px' }}>
            <span style={{ fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>
              Chains
            </span>
            {CHAIN_CHIPS.map(chip => {
              const active = activeChains.has(chip.key)
              return (
                <button
                  key={chip.key}
                  onClick={() => {
                    const next = new Set<PumpChainKey>()
                    if (activeChains.size === CHAIN_CHIPS.length) {
                      next.add(chip.key)
                    } else if (activeChains.has(chip.key)) {
                      if (activeChains.size === 1) return
                      for (const key of activeChains) {
                        if (key !== chip.key) next.add(key)
                      }
                    } else {
                      for (const key of activeChains) next.add(key)
                      next.add(chip.key)
                    }
                    const nextChains = Array.from(next)
                    setActiveChains(next)
                    chainParamRef.current = nextChains
                    setCountdown(120)
                    fetchAlerts()
                  }}
                  aria-pressed={active}
                  style={{
                    padding: '5px 11px', borderRadius: '99px', fontSize: '9px', fontWeight: 700,
                    letterSpacing: '0.10em', textTransform: 'uppercase', cursor: 'pointer',
                    border: `1px solid ${active ? 'rgba(45,212,191,0.40)' : 'rgba(255,255,255,0.10)'}`,
                    background: active ? 'rgba(45,212,191,0.14)' : 'rgba(255,255,255,0.03)',
                    color: active ? '#2DD4BF' : '#94a3b8',
                    fontFamily: 'var(--font-plex-mono)',
                    boxShadow: active ? '0 0 12px rgba(45,212,191,0.16)' : 'none',
                    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
                  }}
                >
                  {chip.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Feed */}
        <div>
          <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 8px' }}>
            Alerts {filtered.length > 0 && `— ${filtered.length}`}
          </p>

          {/* Provider/data failure — always visible, never silently swallowed. Rendered above the
              feed so a stale-but-shown list is never mistaken for a fresh complete one. */}
          {feedError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 12px', marginBottom: '10px', borderRadius: '10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.28)', fontFamily: 'var(--font-plex-mono)' }}>
              <span style={{ color: '#fbbf24', fontSize: '12px' }}>△</span>
              <span style={{ fontSize: '10.5px', color: '#fbbf24', lineHeight: 1.35 }}>{feedError}</span>
            </div>
          )}

          {/* Background refresh indicator — the feed stays on screen underneath it. */}
          {refreshing && !loading && (
            <div style={{ fontSize: '9.5px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '8px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Refreshing — showing last results
            </div>
          )}

          {/* Loading skeletons */}
          {loading && alerts.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
              {[...Array(7)].map((_, i) => (
                <div key={i} style={{ height: '66px', borderRadius: '10px', borderLeft: '3px solid rgba(45,212,191,0.18)', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', animation: 'pumpSlideIn 0.3s ease both', animationDelay: `${i * 55}ms` }} />
              ))}
            </div>
          )}

          {/* TRUTHFUL, SPECIFIC EMPTY STATE, DISCLOSED (live-pump-discovery rewrite): the backend's
              finalState now has 4 real outcomes — a provider outage, zero raw candidates, real raw
              candidates that none qualified, or a rendered feed — plus, whenever it sent one, the
              rejection breakdown so "why is this empty" never needs a second round-trip to ask. */}
          {!loading && filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 20px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
              <div style={{ fontSize: '32px', marginBottom: '14px', opacity: 0.35 }}>{finalState === 'providerUnavailable' ? '◐' : '◈'}</div>
              <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 6px', color: '#64748b' }}>
                {activeFilter !== 'ALL' && activeFilter in CATEGORY_LABEL
                  ? `No ${CATEGORY_LABEL[activeFilter as PumpCategory]} signals right now.`
                  : finalState === 'providerUnavailable' ? 'Providers failed — could not reach discovery sources for any requested chain.'
                  : finalState === 'noRawCandidates' ? 'No candidates found — providers returned zero pools for the requested chains.'
                  : finalState === 'noneQualified' ? 'Checked every real candidate this cycle — none is pumping under $30M right now.'
                  : 'No fresh pump signals passed the quality filter.'}
              </p>
              <p style={{ fontSize: '11px', margin: '0 0 14px', color: '#3a5268' }}>
                {finalState === 'providerUnavailable'
                  ? 'This is a provider issue, not a filtering result — try refreshing shortly.'
                  : 'Try refreshing or widening the chain selection.'}
              </p>
              {/* REJECTION BREAKDOWN, DISCLOSED: exact bullets requested — majors/stables removed,
                  over $30M removed, low liquidity removed, low volume removed, no momentum removed. */}
              {activeFilter === 'ALL' && candidateAudit && (
                <div style={{
                  display: 'inline-grid', gridTemplateColumns: 'repeat(3, minmax(120px, 1fr))', gap: '6px',
                  padding: '10px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.06)', fontSize: '9.5px', textAlign: 'left',
                }}>
                  {[
                    ['Raw candidates', candidateAudit.rawCandidates],
                    ['Qualified', candidateAudit.qualified],
                    ['Majors/stables removed', candidateAudit.rejectedMajorStableWrapped],
                    ['Over $30M removed', candidateAudit.rejectedOverCap],
                    ['Cap data missing', candidateAudit.rejectedCapDataMissing],
                    ['Low liquidity removed', candidateAudit.rejectedLowLiquidity],
                    ['Low volume removed', candidateAudit.rejectedLowVolume],
                    ['No momentum removed', candidateAudit.rejectedNoMomentum],
                  ].map(([label, value]) => (
                    <div key={label as string} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: '#3a5268', letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: '8px' }}>{label}</span>
                      <span style={{ color: '#7c94ab', fontWeight: 700 }}>{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* FEED-QUANTITY EXPLANATION, DISCLOSED (requested: "if only 1 token shows, the UI must
              display '1 of X candidates qualified' with a rejection breakdown"). Below a small
              threshold, cite the real numbers instead of a generic "limited candidates" line. */}
          {!loading && alerts.length > 0 && alerts.length < 10 && (
            candidateAudit ? (
              <div style={{ margin: '0 0 8px', padding: '7px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', fontFamily: 'var(--font-plex-mono)' }}>
                <p style={{ fontSize: '9.5px', color: '#7c94ab', margin: '0 0 4px', fontWeight: 700 }}>
                  {alerts.length} of {candidateAudit.rawCandidates} candidates qualified
                </p>
                <p style={{ fontSize: '8.5px', color: '#3a5268', margin: 0 }}>
                  {candidateAudit.rejectedMajorStableWrapped} majors/stables removed · {candidateAudit.rejectedOverCap} over $30M removed · {candidateAudit.rejectedCapDataMissing} missing cap data · {candidateAudit.rejectedLowLiquidity} low liquidity removed · {candidateAudit.rejectedLowVolume} low volume removed · {candidateAudit.rejectedNoMomentum} no momentum removed.
                </p>
              </div>
            ) : (
              <p style={{ fontSize: '9.5px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: '0 0 8px', padding: '5px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                Limited fresh candidates right now — refresh shortly for more.
              </p>
            )
          )}

          {/* CARD GRID, DISCLOSED (requested: cards feel too wide/heavy): a responsive grid instead
              of a single full-width column — cards narrow to a sensible width and multiple sit
              side-by-side on wide screens, collapsing to one column on mobile via the media query
              below. */}
          <div className="pump-card-grid-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '11px' }}>
            {visible.map((alert, i) => (
              <div key={alert.contract} style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                <AlertCard
                  alert={alert}
                  onScan={() => openToken(alert)}
                  onAskClark={() => openClark(alert)}
                  onReport={() => openReport(alert)}
                  onCopyCA={() => copyCA(alert.contract)}
                  onHoverPrefetch={() => prefetchReport(alert)}
                  copied={copiedContract === alert.contract.toLowerCase()}
                />
              </div>
            ))}
          </div>

          {/* LOAD MORE, DISCLOSED: purely client-side pagination over the already-fetched alerts —
              never a new network request. Hidden once every filtered alert is on screen. */}
          {filtered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', marginTop: '16px' }}>
              <p style={{ margin: 0, fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.04em' }}>
                Showing {visible.length} of {filtered.length}
              </p>
              {hasMore ? (
                <button
                  onClick={handleLoadMore}
                  disabled={loadMoreLoading}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '7px',
                    padding: '9px 20px', borderRadius: '999px',
                    background: 'rgba(45,212,191,0.09)', border: '1px solid rgba(45,212,191,0.28)',
                    color: loadMoreLoading ? '#3a5268' : '#2DD4BF',
                    fontSize: '10.5px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
                    cursor: loadMoreLoading ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-plex-mono)',
                    transition: 'background 0.15s ease, border-color 0.15s ease',
                  }}
                >
                  {loadMoreLoading && (
                    <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round' style={{ animation: 'spinRefresh 0.8s linear infinite' }}>
                      <path d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' />
                      <path d='M21 3v5h-5' />
                      <path d='M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' />
                      <path d='M8 16H3v5' />
                    </svg>
                  )}
                  {loadMoreLoading ? 'Loading…' : 'Load More'}
                </button>
              ) : (
                <p style={{ margin: 0, fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
                  All current pump candidates shown.
                </p>
              )}
            </div>
          )}

          {/* Disclaimer */}
          {filtered.length > 0 && (
            <p style={{ marginTop: '20px', fontSize: '10px', color: '#2d3f52', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '14px' }}>
              Pump Alerts surface tokens meeting momentum thresholds based on live CORTEX market data. This is not financial advice. Always verify independently before acting.
            </p>
          )}
        </div>
      </div>
    </>
  )
}
