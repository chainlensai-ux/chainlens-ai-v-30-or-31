'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

type WalletCtx = {
  shortAddress: string
  isContract: boolean | null
  nativeBalanceEth: number | null
  txCount: number | null
  alertCount24h: number
  buyCount24h: number
  sellCount24h: number
  totalVerifiedUsd24h: number | null
  repeatedTokens: string[]
  repeatedTokenCount: number
  tags: string[]
  confidence: 'high' | 'medium' | 'low'
  status: 'ok' | 'partial' | 'unverified'
}
type AlertItem = {
  id?: string
  wallet_address?: string | null
  wallet_label?: string | null
  token_address?: string | null
  token_symbol?: string | null
  focus_token_symbol?: string | null
  token_name?: string | null
  alert_type?: string | null
  side?: string | null
  amount_usd?: number | null
  amount_token?: number | null
  tx_hash?: string | null
  severity?: string | null
  occurred_at?: string | null
  legs?: number | null
  repeats?: number | null
  signal_score?: string | null
  summary?: string | null
  token_image_url?: string | null
  logo_url?: string | null
  image?: string | null
  token_logo?: string | null
  walletContext?: {
    shortAddress: string; behaviorType: string; behaviorScore: number; confidence: string
    repeatedTokens: string[]; alertCount24h: number; alertCount7d: number
    verifiedUsdFlow7d: number | null; monitorReason: string; nextWatch: string
    tags: string[]; isContract: boolean | null
  } | null
}
type AlertStats = { alerts15m: number; alerts1h: number; alerts24h: number; trackedWallets: number }
type ValueRange = 'all' | '100-500' | '500-1000' | '1000-5000' | '5000-10000' | '10000+'
type SyncResponse = {
  ok?: boolean
  savedAt?: number
  mode?: 'batch' | 'full'
  processed?: number
  processedTotal?: number
  inserted?: number
  insertedTotal?: number
  skipped?: number
  nextOffset?: number | null
  hasMore?: boolean
  done?: boolean
  noFreshSignal?: boolean
  refreshStatus?: string
  providerErrors?: number
  trackedWalletsTotal?: number
  offset?: number
  skipReasons?: Record<string, number>
  message?: string
}
type EnrichmentBudget = { liveEnrichmentEnabled?: boolean; trigger?: string; rpcCallsAttempted?: number; cacheHits?: number; skippedForDefaultLoad?: number }
type FeedDiagnostics = { rawRows?: number; afterDiversityCap?: number; hiddenAsBoring?: number; hiddenByFilter?: number; hiddenAsDust?: number; enrichmentBudget?: EnrichmentBudget }
type AlertIntelligence = {
  walletCount?: number
  activeWalletCount?: number
  pricedAlertCount?: number
  unpricedAlertCount?: number
  topRepeatedTokens?: string[]
  walletBehavior?: {
    monitoredWallets?: number
    behaviorLeaders?: Array<{
      address?: string
      shortAddress?: string
      behaviorType?: string
      behaviorScore?: number
      confidence?: 'high' | 'medium' | 'low' | string
      repeatedTokens?: string[]
      verifiedUsdFlow24h?: number | null
      alertCount24h?: number
      alertCount7d?: number
      monitorReason?: string
      nextWatch?: string
    }>
    repeatedTokenWalletMap?: Array<{
      token?: string
      walletCount?: number
      wallets?: string[]
      totalVerifiedUsd?: number | null
    }>
  }
}

const RANGE_OPTIONS: { label: string; value: ValueRange }[] = [
  { label: 'All',       value: 'all' },
  { label: '$100–$500', value: '100-500' },
  { label: '$500–$1k',  value: '500-1000' },
  { label: '$1k–$5k',   value: '1000-5000' },
  { label: '$5k–$10k',  value: '5000-10000' },
  { label: '$10k+',     value: '10000+' },
]
const WINDOWS = ['1h', '6h', '24h', '7d'] as const
const DEV_SYNC_COOLDOWN_MS = 10 * 1000
const PRO_SYNC_COOLDOWN_MS = 60 * 1000
const ELITE_SYNC_COOLDOWN_MS = 30 * 1000
const CLIENT_SYNC_CACHE_KEY = 'whale_alerts_last_sync_at'
const CLIENT_FULL_SYNC_CACHE_KEY = 'whale_alerts_last_full_sync_at'
const CLIENT_SYNC_STATE_CACHE_KEY = 'whale_alerts_last_sync_state_v1'

const short = (value?: string | null) => (!value ? 'Unknown' : `${value.slice(0, 6)}...${value.slice(-4)}`)
const timeAgo = (iso?: string | null) => {
  if (!iso) return 'No sync yet'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.max(1, Math.floor(diff / 60000))
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const fmtUsd = (n?: number | null) => {
  if (n == null) return '—'
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

const fmtToken = (n?: number | null, sym?: string | null) => {
  if (n == null || !sym) return null
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ${sym}`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K ${sym}`
  return `${n.toFixed(2)} ${sym}`
}

const fmtAmtNum = (n?: number | null) => {
  if (n == null) return null
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(2)
}

const getSide = (s: string | null | undefined) => {
  const k = (s ?? '').toLowerCase()
  if (k === 'buy')  return { line: '#2dd4bf', avatarBg: '#0d3b35', chipBg: 'rgba(45,212,191,0.12)',  chipBd: 'rgba(45,212,191,0.32)',  chipTx: '#5eead4', label: 'BUY'      }
  if (k === 'sell') return { line: '#f43f5e', avatarBg: '#3d0d1a', chipBg: 'rgba(244,63,94,0.12)',   chipBd: 'rgba(244,63,94,0.32)',   chipTx: '#fda4af', label: 'SELL'     }
  return               { line: '#8b5cf6', avatarBg: '#1e0d3b', chipBg: 'rgba(139,92,246,0.12)',  chipBd: 'rgba(139,92,246,0.32)',  chipTx: '#c4b5fd', label: 'Activity' }
}

const sevLabel = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return 'HIGH'
  if (sev === 'medium') return 'MED'
  if (sev === 'low') return 'LOW'
  return sev?.toUpperCase() ?? null
}

const sevStyle = (sev: string | null | undefined): React.CSSProperties => {
  if (sev === 'major' || sev === 'large') return { background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.30)', color: '#fda4af' }
  if (sev === 'medium') return { background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.28)', color: '#fcd34d' }
  return { background: 'rgba(100,116,139,0.09)', border: '1px solid rgba(100,116,139,0.20)', color: '#64748b' }
}

const signalStyle = (sig: string): React.CSSProperties => {
  if (sig === 'HIGH SIGNAL') return { background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.28)', color: '#2dd4bf' }
  if (sig === 'WATCH') return { background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.28)', color: '#fcd34d' }
  if (sig === 'NOISE') return { background: 'rgba(100,116,139,0.05)', border: '1px solid rgba(100,116,139,0.14)', color: '#64748b' }
  return { background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.18)', color: '#94a3b8' }
}

const rowDesc = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return '● High value movement'
  if (sev === 'medium') return '● Fresh tracked-wallet activity'
  if (sev === 'low') return '● Below whale threshold'
  return null
}

function Pill({ children, color = 'slate', dot }: { children: React.ReactNode; color?: string; dot?: boolean }) {
  const m: Record<string, { bg: string; bd: string; tx: string; dt: string }> = {
    slate:  { bg: 'rgba(148,163,184,0.08)', bd: 'rgba(148,163,184,0.18)', tx: '#94a3b8', dt: '#64748b' },
    teal:   { bg: 'rgba(45,212,191,0.09)',  bd: 'rgba(45,212,191,0.26)',  tx: '#5eead4', dt: '#2dd4bf' },
    purple: { bg: 'rgba(139,92,246,0.09)',  bd: 'rgba(139,92,246,0.26)',  tx: '#c4b5fd', dt: '#8b5cf6' },
    cyan:   { bg: 'rgba(34,211,238,0.09)',  bd: 'rgba(34,211,238,0.26)',  tx: '#67e8f9', dt: '#22d3ee' },
    amber:  { bg: 'rgba(251,191,36,0.09)',  bd: 'rgba(251,191,36,0.26)',  tx: '#fcd34d', dt: '#f59e0b' },
    green:  { bg: 'rgba(34,197,94,0.09)',   bd: 'rgba(34,197,94,0.26)',   tx: '#86efac', dt: '#22c55e' },
  }
  const c = m[color] ?? m.slate
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full"
      style={{ gap: 6, padding: '5px 10px', fontSize: 11, fontWeight: 500, background: c.bg, border: `1px solid ${c.bd}`, color: c.tx }}>
      {dot && <span className="rounded-full" style={{ width: 6, height: 6, background: c.dt, display: 'inline-block' }} />}
      {children}
    </span>
  )
}

// DESIGN, DISCLOSED (Whale Alerts UI redesign): the sparkline is deliberately kept as SUPPORT, not
// a feature — no gradient area fill, hairline stroke, low opacity, no end-cap dot. Same fixed paths
// as before (these have always been decorative shape, never plotted data — unchanged, and no data
// claim is made about them anywhere in the UI).
function CardSpark({ color, seed = 0 }: { color: string; seed?: number }) {
  const paths = [
    'M0 30 L18 22 L36 16 L54 20 L72 11 L90 14 L108 7 L126 10 L144 3 L160 2',
    'M0 28 L18 20 L36 24 L54 14 L72 18 L90 9 L108 13 L126 5 L144 9 L160 3',
    'M0 24 L18 30 L36 19 L54 25 L72 13 L90 17 L108 8 L126 13 L144 4 L160 2',
    'M0 26 L18 19 L36 14 L54 21 L72 10 L90 15 L108 6 L126 11 L144 2 L160 5',
  ]
  const d = paths[seed % 4]
  return (
    <svg width="120" height="32" viewBox="0 0 160 40" fill="none" preserveAspectRatio="none"
      style={{ position: 'absolute', bottom: 12, right: 14, opacity: 0.22, pointerEvents: 'none' }}>
      <path d={d} stroke={color} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

// Crisp segmented control — flat surface, solid selected state, no glow. Replaces the previous
// soft/glowy pill rows for Time Window and Feed Mode.
function Segmented<T extends string>({ options, value, onChange, className }: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={`wa-seg inline-flex${className ? ` ${className}` : ''}`} role="tablist">
      {options.map((o) => {
        const active = value === o.value
        return (
          <button key={o.value} type="button" role="tab" aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`wa-seg-btn${active ? ' is-active' : ''}`}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// Small uppercase field label — one consistent treatment for every control group and stat.
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="wa-label">{children}</span>
}

function SymBubble({ label, size, avatarBg, line, small }: { label: string; size: number; avatarBg: string; line: string; small?: boolean }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: avatarBg, border: `1px solid ${line}33`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <span style={{ fontSize: small ? 7 : 10, fontWeight: 800, color: '#f8fafc', lineHeight: 1 }}>{label}</span>
    </div>
  )
}

function TokenAvatar({ tok, logoUrl, avatarBg, line }: {
  tok: string; logoUrl: string | null | undefined; avatarBg: string; line: string
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const syms = tok.split(' / ').slice(0, 2).map(s => s.trim().slice(0, 4).toUpperCase())
  const isMulti = syms.length > 1

  if (logoUrl && !imgFailed) {
    return (
      <div className="shrink-0 flex items-center justify-center overflow-hidden"
        style={{ width: 36, height: 36, marginTop: 2, borderRadius: 12, background: avatarBg, border: `1px solid ${line}22`, flexShrink: 0 }}>
        <img src={logoUrl} alt={syms[0]} width={36} height={36}
          style={{ width: 36, height: 36, objectFit: 'cover' }}
          onError={() => setImgFailed(true)}
        />
      </div>
    )
  }

  if (isMulti) {
    return (
      <div className="shrink-0 relative" style={{ width: 36, height: 36, marginTop: 2, flexShrink: 0 }}>
        {/* back bubble (second token) — sits behind */}
        <div style={{ position: 'absolute', bottom: 0, right: 0, border: '2px solid #060810', borderRadius: '50%' }}>
          <SymBubble label={syms[1]} size={22} avatarBg={avatarBg} line={line} small />
        </div>
        {/* front bubble (first token) — sits in front */}
        <div style={{ position: 'absolute', top: 0, left: 0, border: '2px solid #060810', borderRadius: '50%' }}>
          <SymBubble label={syms[0]} size={22} avatarBg={avatarBg} line={line} small />
        </div>
      </div>
    )
  }

  return (
    <div className="shrink-0 flex items-center justify-center"
      style={{ width: 36, height: 36, marginTop: 2, borderRadius: 12, background: avatarBg, border: `1px solid ${line}22`, flexShrink: 0 }}>
      <SymBubble label={syms[0]} size={28} avatarBg={avatarBg} line={line} />
    </div>
  )
}

export default function WhaleAlertsPage() {
  const { plan, loading: planLoading, betaEliteActive } = usePlanWithLoading()
  const [windowValue, setWindowValue] = useState<(typeof WINDOWS)[number]>('24h')
  const [feedMode, setFeedMode]       = useState<'interesting' | 'all'>('interesting')
  const [valueRange, setValueRange]   = useState<ValueRange>('all')
  const [typeFilter, setTypeFilter]   = useState('all')
  const [sevFilter, setSevFilter]     = useState('all')
  const [sideFilter, setSideFilter]   = useState('all')
  const [alerts, setAlerts]           = useState<AlertItem[]>([])
  const [stats, setStats]             = useState<AlertStats>({ alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
  const [loading, setLoading]         = useState(false)
  const [enrichLoading, setEnrichLoading] = useState(false)
  const [syncing, setSyncing]         = useState(false)
  const [syncState, setSyncState]     = useState<SyncResponse | null>(null)
  const [feedError, setFeedError]     = useState(false)
  const [feedDiagnostics, setFeedDiagnostics] = useState<FeedDiagnostics | null>(null)
  const [intelligence, setIntelligence] = useState<AlertIntelligence | null>(null)
  // UI-ONLY DISCLOSURE STATE, DISCLOSED (Whale Alerts UI redesign): drives the collapsed/expanded
  // state of the diagnostics disclosure in the sync module. No fetch, no backend involvement — it
  // only reveals `feedDiagnostics`, which this page already receives from /api/whale-alerts today.
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [syncCooldownLeftMs, setSyncCooldownLeftMs] = useState(0)
  const [fullSyncCooldownLeftMs, setFullSyncCooldownLeftMs] = useState(0)

  const isDevMode = process.env.NODE_ENV === 'development'
  const normalizedPlan = String(plan ?? '').toLowerCase()
  const baseCooldownMs = useMemo(() => {
    if (isDevMode) return DEV_SYNC_COOLDOWN_MS
    return normalizedPlan === 'elite' ? ELITE_SYNC_COOLDOWN_MS : PRO_SYNC_COOLDOWN_MS
  }, [isDevMode, normalizedPlan])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CLIENT_SYNC_STATE_CACHE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as SyncResponse
      if (!parsed || typeof parsed !== 'object') return
      const savedAt = Number(parsed.savedAt ?? 0)
      const maxAgeMs = 24 * 60 * 60 * 1000
      const looksInvalid = (parsed.trackedWalletsTotal ?? 0) < 0 || (parsed.processedTotal ?? 0) < 0
      if (looksInvalid || !Number.isFinite(savedAt) || savedAt <= 0 || (Date.now() - savedAt) > maxAgeMs) {
        window.localStorage.removeItem(CLIENT_SYNC_STATE_CACHE_KEY)
        return
      }
      setSyncState(parsed)
    } catch {}
  }, [baseCooldownMs])

  const loadAlerts = useCallback(async (opts?: { enrich?: boolean }) => {
    if (opts?.enrich) setEnrichLoading(true)
    else setLoading(true)
    setFeedError(false)
    try {
      const p = new URLSearchParams({ window: windowValue, limit: '100' })
      if (feedMode === 'all') p.set('interesting', 'false')
      if (valueRange !== 'all') p.set('valueRange', valueRange)
      if (typeFilter !== 'all') p.set('type', typeFilter)
      if (sevFilter !== 'all')  p.set('severity', sevFilter)
      if (sideFilter !== 'all') p.set('side', sideFilter)
      if (opts?.enrich) p.set('enrich', 'true')
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch(`/api/whale-alerts?${p.toString()}`, {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) { setFeedError(true); return }
      const json = await res.json()
      setAlerts(Array.isArray(json?.alerts) ? json.alerts : [])
      setStats(json?.stats ?? { alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
      setFeedDiagnostics(json?.diagnostics ?? null)
      setIntelligence(json?.intelligence ?? null)
    } catch {
      setFeedError(true)
    } finally {
      setLoading(false)
      setEnrichLoading(false)
    }
  }, [windowValue, feedMode, valueRange, typeFilter, sevFilter, sideFilter])

  useEffect(() => { void loadAlerts() }, [loadAlerts])

  const runSync = async (offset?: number, mode: 'batch' | 'full' = 'batch') => {
    const now = Date.now()
    const cacheKey = mode === 'full' ? CLIENT_FULL_SYNC_CACHE_KEY : CLIENT_SYNC_CACHE_KEY
    const cooldownMs = baseCooldownMs
    const isBatchContinuation = mode === 'batch' && typeof offset === 'number' && offset > 0
    const isFullResume = mode === 'full' && typeof offset === 'number' && offset > 0
    const isContinuation = isBatchContinuation || isFullResume
    const lastSyncAt = Number(window.localStorage.getItem(cacheKey) ?? '0')
    const elapsed = now - lastSyncAt
    if (!isContinuation && elapsed < cooldownMs) {
      if (mode === 'full') setFullSyncCooldownLeftMs(cooldownMs - elapsed)
      else setSyncCooldownLeftMs(cooldownMs - elapsed)
      return
    }
    setSyncing(true)
    try {
      if (mode === 'full') {
        // Auto-loop: run batches until done=true or error — no manual Continue needed
        let currentOffset = typeof offset === 'number' ? offset : 0
        let cumulativeInserted = isFullResume ? (syncState?.insertedTotal ?? 0) : 0
        while (true) {
          const params = new URLSearchParams({ window: '7d', limit: '10', minUsd: '0', mode: 'full', offset: String(currentOffset) })
          const { data: { session: syncSession } } = await supabase.auth.getSession()
          const syncToken = syncSession?.access_token
          const res = await fetch(`/api/whale-alerts/sync?${params.toString()}`, {
            method: 'POST',
            headers: syncToken ? { Authorization: `Bearer ${syncToken}` } : {},
          })
          const json = (await res.json()) as SyncResponse
          if (!res.ok || json.ok === false) break
          cumulativeInserted += Number(json.inserted ?? 0)
          const merged: SyncResponse = {
            ...json,
            mode: 'full',
            processedTotal: json.processedTotal,
            insertedTotal: cumulativeInserted,
            refreshStatus: json.hasMore ? 'full_in_progress' : 'full_complete',
            savedAt: Date.now(),
          }
          setSyncState(merged)
          window.localStorage.setItem(CLIENT_SYNC_STATE_CACHE_KEY, JSON.stringify(merged))
          if (json.done === true || !json.hasMore || json.nextOffset == null) {
            window.localStorage.setItem(cacheKey, String(Date.now()))
            setFullSyncCooldownLeftMs(cooldownMs)
            break
          }
          currentOffset = json.nextOffset
          await new Promise<void>(r => setTimeout(r, 80))
        }
      } else {
        // Batch: single call
        const params = new URLSearchParams({ window: '7d', limit: '10', minUsd: '0', mode: 'batch' })
        if (typeof offset === 'number') params.set('offset', String(offset))
        const { data: { session: syncSession } } = await supabase.auth.getSession()
        const syncToken = syncSession?.access_token
        const res = await fetch(`/api/whale-alerts/sync?${params.toString()}`, {
          method: 'POST',
          headers: syncToken ? { Authorization: `Bearer ${syncToken}` } : {},
        })
        const json = (await res.json()) as SyncResponse
        const prev = isBatchContinuation && syncState?.mode === 'batch' ? syncState : null
        const processedTotal = Number(prev?.processedTotal ?? 0) + Number(json.processed ?? 0)
        const insertedTotal = Number(prev?.insertedTotal ?? 0) + Number(json.inserted ?? 0)
        const merged: SyncResponse = { ...json, mode: 'batch', processedTotal, insertedTotal, savedAt: Date.now() }
        setSyncState(merged)
        window.localStorage.setItem(CLIENT_SYNC_STATE_CACHE_KEY, JSON.stringify(merged))
        if (!isBatchContinuation) {
          window.localStorage.setItem(cacheKey, String(Date.now()))
          setSyncCooldownLeftMs(cooldownMs)
        }
      }
      await loadAlerts()
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => {
    const tick = () => {
      const lastSyncAt = Number(window.localStorage.getItem(CLIENT_SYNC_CACHE_KEY) ?? '0')
      const lastFullSyncAt = Number(window.localStorage.getItem(CLIENT_FULL_SYNC_CACHE_KEY) ?? '0')
      const left = Math.max(0, baseCooldownMs - (Date.now() - lastSyncAt))
      const fullLeft = Math.max(0, baseCooldownMs - (Date.now() - lastFullSyncAt))
      setSyncCooldownLeftMs(left)
      setFullSyncCooldownLeftMs(fullLeft)
    }
    tick()
    const id = window.setInterval(tick, 30_000)
    return () => window.clearInterval(id)
  }, [baseCooldownMs])

  const resetFilters = () => {
    setTypeFilter('all')
    setSevFilter('all')
    setSideFilter('all')
    setValueRange('all')
    setWindowValue('24h')
    setFeedMode('all')
  }
  const showAllAlerts = () => {
    setFeedMode('all')
    setValueRange('all')
    setTypeFilter('all')
    setSevFilter('all')
    setSideFilter('all')
  }
  const clearSyncState = () => {
    window.localStorage.removeItem(CLIENT_SYNC_STATE_CACHE_KEY)
    window.localStorage.removeItem(CLIENT_SYNC_CACHE_KEY)
    window.localStorage.removeItem(CLIENT_FULL_SYNC_CACHE_KEY)
    setSyncCooldownLeftMs(0)
    setFullSyncCooldownLeftMs(0)
    setSyncState(null)
  }

  const types = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.alert_type).filter(Boolean) as string[]))], [alerts])
  const sevs  = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.severity).filter(Boolean) as string[]))], [alerts])
  const sides = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.side).filter(Boolean) as string[]))], [alerts])

  const effectiveProcessed = syncState?.processedTotal ?? syncState?.processed ?? 0
  const effectiveInserted = syncState?.insertedTotal ?? syncState?.inserted ?? 0
  const covPct = syncState && (syncState.trackedWalletsTotal ?? 0) > 0
    ? Math.min(100, Math.round((effectiveProcessed / (syncState.trackedWalletsTotal ?? 1)) * 100)) : null
  const scannedCount = effectiveProcessed
  const trackedCount = syncState?.trackedWalletsTotal ?? 0
  const isPartial = trackedCount > 0 && scannedCount < trackedCount
  const fullNeedsContinue = syncState?.mode === 'full' && trackedCount > 0 && scannedCount < trackedCount
  const isFullInProgress = Boolean(syncState?.mode === 'full' && (syncState?.hasMore || fullNeedsContinue))
  const computedFullNextOffset = (() => {
    if (syncState?.mode !== 'full') return 0
    if (typeof syncState.nextOffset === 'number' && syncState.nextOffset >= 0) return syncState.nextOffset
    if (fullNeedsContinue) return Math.max(0, scannedCount)
    return 0
  })()
  const syncStatusText = syncing
    ? (syncState?.mode === 'full' && (syncState?.trackedWalletsTotal ?? 0) > 0
        ? `Scanning ${scannedCount}/${syncState.trackedWalletsTotal}`
        : 'Scanning…')
    : isFullInProgress
      ? 'Full refresh in progress'
      : syncState
        ? (syncState.hasMore ? 'Partial refresh' : (syncState.mode === 'full' ? `Full refresh complete — ${scannedCount}/${trackedCount} wallets` : 'Recently refreshed'))
        : 'Ready to sync'

  const lastSyncSummary = syncState ? `${syncState.processed ?? 0} scanned this batch / ${syncState.inserted ?? 0} inserted` : 'No signal in checked window'
  const providerSummary = syncState ? ((syncState.providerErrors ?? 0) > 0 ? `Degraded (${syncState.providerErrors} errors)` : 'Healthy') : 'No signal in checked window'
  const ageStr = (iso?: string | null) => {
    if (!iso) return 'unknown'
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
    return `${Math.floor(ms / 3_600_000)}h ago`
  }

  const buildClarkPrompt = () => {
    const publicWalletLabel = '60+'
    const syncProgress = syncState
      ? `${syncState.processedTotal ?? 0}/${syncState.trackedWalletsTotal ?? 0} wallets scanned${syncState.done ? ' (complete)' : ' (partial)'}`
      : 'No sync run yet'
    const totalFound = syncState?.insertedTotal ?? syncState?.inserted ?? null

    if (alerts.length > 0) {
      const top5 = alerts.slice(0, 5).map((a, idx) => {
        const label  = a.wallet_label || 'Tracked Wallet'
        const tok    = a.focus_token_symbol ?? a.token_symbol ?? a.token_name ?? 'Unknown token'
        const side   = a.side ?? 'move'
        const usd    = (a.amount_usd != null && a.amount_usd > 0) ? `$${a.amount_usd.toFixed(0)}` : 'USD unverified'
        const sig    = a.signal_score ?? 'LOW SIGNAL'
        const sev    = a.severity ?? 'unknown'
        const age    = ageStr(a.occurred_at)
        const legs   = (a.legs ?? 1) > 1 ? ` ${a.legs}-leg swap` : ''
        const rep    = (a.repeats ?? 1) > 1 ? ` ×${a.repeats} repeats` : ''
        return `${idx + 1}. [${sig}/${sev}] ${label}: ${side} ${usd}${legs}${rep} — ${tok} — ${age}`
      }).join('\n')
      return [
        `[ChainLens Whale Alerts — Feature Context]`,
        `Chain: Base Mainnet`,
        `Tracked wallets: ${publicWalletLabel} (on-demand sync, no webhook required)`,
        `Time window: ${windowValue} | Value range: ${valueRange} | Feed mode: ${feedMode}`,
        `Visible alerts: ${alerts.length}${totalFound != null ? ` | Total signals found this sync: ${totalFound}` : ''}`,
        `Sync progress: ${syncProgress}`,
        ``,
        `Top ${Math.min(5, alerts.length)} visible alerts:`,
        top5,
        ``,
        `Note: wallet_label is an internal ChainLens label, not a verified public identity. USD values are on-chain estimates; always verify before acting. Do not invent data. Do not suggest copy-trading. Say "worth monitoring" rather than "buy".`,
        ``,
        `Answer: What are whales doing on Base right now? Which alerts matter most and why? What tokens or patterns are worth monitoring next?`,
      ].join('\n')
    }
    return [
      `[ChainLens Whale Alerts — Feature Context]`,
      `Chain: Base Mainnet`,
      `Tracked wallets: ${publicWalletLabel} (on-demand sync, no webhook required)`,
      `Time window: ${windowValue} | Value range: ${valueRange} | Feed mode: ${feedMode}`,
      `Sync progress: ${syncProgress}`,
      `No alerts visible.`,
      ``,
      `Note: Do not invent alerts or fake data.`,
      ``,
      `Explain what it means to have no visible alerts in this context and what the user should try next.`,
    ].join('\n')
  }
  const goClark = () => { window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1` }

  // COPY TIGHTENED, DISCLOSED (Whale Alerts UI redesign): sub-labels were restating the label in
  // words ("Last quarter hour" under "ALERTS · 15M"). Now each carries a distinct unit/scope line.
  // ZERO-STATE COPY, DISCLOSED (final polish): a bare "0" with a generic "Rolling" caption reads as
  // broken. `zeroSub` gives each counter an intentional, factual line for the 0 case — it states
  // only what a 0 in that window literally means (no signal recorded), never a claim about sync
  // health or upcoming data. Tracked wallets has no zeroSub: its value is the fixed "60+" label,
  // so it can never be 0.
  const metrics = [
    { label: 'Alerts',          unit: '15m', val: stats.alerts15m, sub: 'Rolling', zeroSub: 'Quiet this window',   color: '#2dd4bf' },
    { label: 'Alerts',          unit: '1h',  val: stats.alerts1h,  sub: 'Rolling', zeroSub: 'No signal past hour',  color: '#2dd4bf' },
    { label: 'Alerts',          unit: '24h', val: stats.alerts24h, sub: 'Rolling', zeroSub: 'None in last 24h',     color: '#8b5cf6' },
    { label: 'Tracked wallets', unit: null,  val: '60+',           sub: 'Smart money + manual', zeroSub: null,      color: '#94a3b8' },
  ]

  // SURFACE SYSTEM, DISCLOSED (Whale Alerts UI redesign): three flat, neutral surfaces + two border
  // weights, replacing the previous per-card gradients/glows. Engineered, not decorated.
  const cardBg   = 'rgba(9,14,24,0.90)'
  const innerBg  = 'rgba(5,9,17,0.80)'
  const bdr      = '1px solid rgba(148,163,184,0.12)'
  const bdrInner = '1px solid rgba(148,163,184,0.07)'

  if (planLoading) return <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Loading plan access…</div>
  if (!betaEliteActive && !canAccessFeature(plan, 'whale-alerts')) return <LockedPanel feature="whale-alerts" />

  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden"
      style={{ background: 'radial-gradient(ellipse 120% 50% at 50% -10%,rgba(45,212,191,0.045) 0%,transparent 60%),#05070d', color: '#e2e8f0' }}>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }

        /* ── Typography scale ─────────────────────────────────────────────── */
        .wa-label {
          font-size: 10px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase;
          color: #55647d; line-height: 1;
        }
        .wa-sec-title { font-size: 13px; font-weight: 700; letter-spacing: -0.005em; color: #e8eef7; margin: 0; }
        .wa-help { font-size: 11.5px; line-height: 1.55; color: #5d6b82; margin: 0; }

        /* ── Segmented control — flat, crisp, no glow ─────────────────────── */
        .wa-seg {
          gap: 2px; padding: 3px; border-radius: 9px;
          background: rgba(2,6,14,0.60); border: 1px solid rgba(148,163,184,0.10);
        }
        .wa-seg-btn {
          padding: 6px 14px; border-radius: 6px; border: 1px solid transparent;
          font-size: 12px; font-weight: 600; line-height: 1; white-space: nowrap;
          background: transparent; color: #64748b; cursor: pointer;
          transition: color .13s, background .13s;
        }
        .wa-seg-btn:hover:not(.is-active) { color: #a9b6c9; background: rgba(148,163,184,0.05); }
        .wa-seg-btn.is-active {
          background: rgba(45,212,191,0.13); border-color: rgba(45,212,191,0.30); color: #5eead4;
        }

        /* ── Filter chips ─────────────────────────────────────────────────── */
        .wa-chip {
          padding: 6px 12px; border-radius: 7px; font-size: 12px; font-weight: 600; line-height: 1;
          background: rgba(148,163,184,0.045); border: 1px solid rgba(148,163,184,0.10);
          color: #64748b; cursor: pointer; transition: color .13s, background .13s, border-color .13s;
        }
        .wa-chip:hover:not(.is-active) { color: #a9b6c9; border-color: rgba(148,163,184,0.20); }
        .wa-chip.is-active { background: rgba(45,212,191,0.13); border-color: rgba(45,212,191,0.30); color: #5eead4; }

        /* ── Buttons ──────────────────────────────────────────────────────── */
        .wa-btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          border-radius: 8px; font-weight: 600; line-height: 1; cursor: pointer;
          transition: background .13s, border-color .13s, color .13s, opacity .13s;
          white-space: nowrap;
        }
        .wa-btn:disabled { cursor: not-allowed; }
        .wa-btn-primary {
          padding: 9px 16px; font-size: 12.5px; font-weight: 700;
          background: #14b8a6; border: 1px solid #14b8a6; color: #04120f;
        }
        .wa-btn-primary:hover:not(:disabled) { background: #2dd4bf; border-color: #2dd4bf; }
        .wa-btn-primary:disabled { background: rgba(20,184,166,0.20); border-color: rgba(20,184,166,0.22); color: rgba(4,18,15,0.55); }
        .wa-btn-secondary {
          padding: 8px 13px; font-size: 12px;
          background: rgba(148,163,184,0.06); border: 1px solid rgba(148,163,184,0.14); color: #93a3ba;
        }
        .wa-btn-secondary:hover:not(:disabled) { background: rgba(148,163,184,0.11); color: #cbd5e1; }
        .wa-btn-secondary:disabled { opacity: 0.42; }
        .wa-btn-quiet {
          padding: 6px 9px; font-size: 11px; font-weight: 600;
          background: transparent; border: 1px solid transparent; color: #55647d;
        }
        .wa-btn-quiet:hover:not(:disabled) { color: #93a3ba; background: rgba(148,163,184,0.06); }
        .wa-btn-quiet:disabled { opacity: 0.4; }
        /* Sync card's tertiary row (full refresh / reset / clear state) — deliberately the quietest
           interactive element on the page: smaller, dimmer, no hover fill, reveals only on hover.
           A separate class from .wa-btn-quiet so the feed's Pause and the empty state's Ask Clark
           keep their existing, more visible weight. */
        .wa-btn-micro {
          padding: 3px 0; font-size: 10.5px; font-weight: 600; letter-spacing: 0.005em;
          background: transparent; border: none; color: #465469;
          transition: color .13s;
        }
        .wa-btn-micro:hover:not(:disabled) { color: #9fb0c6; }
        .wa-btn-micro:disabled { opacity: 0.4; }

        /* ── Feed row hover ───────────────────────────────────────────────── */
        .wa-row { transition: background .12s; }
        .wa-row:hover { background: rgba(148,163,184,0.028); }

        @media (max-width: 900px) {
          .wa-controls  { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 767px) {
          .wa-main-wrap { padding-top: 60px !important; }
          .wa-head      { flex-direction: column !important; align-items: flex-start !important; }
          .wa-metrics   { grid-template-columns: repeat(2, 1fr) !important; }
          .wa-dropdowns { grid-template-columns: 1fr !important; }
          .wa-ctl-row   { flex-direction: column !important; align-items: flex-start !important; }
          .wa-sync-btns { flex-wrap: wrap !important; }
          .wa-feed-actions { width: 100%; justify-content: flex-start !important; flex-wrap: wrap; }
        }
      `}</style>

      <div className="wa-main-wrap mx-auto w-full flex flex-col" style={{ maxWidth: 1280, gap: 16, padding: '20px 16px 40px' }}>

        {/* ═══ 1. CONTROL HEADER ═════════════════════════════════════════════
            Compressed from a 2-column marketing hero (large h1, duplicated eyebrow, decorative
            radar rings + fake sparkline) into a single-row operator header. Same information,
            roughly a third of the vertical space, no decorative SVG.
            ICON REMOVED, DISCLOSED (header polish): the boxed/glowing bell icon next to the title
            read as template filler — dropped entirely rather than replaced, per this task's own
            "no replacement icon unless absolutely necessary" instruction. Title/subtitle now lead
            the header directly; spacing tightened to close the gap the icon left behind. */}
        <header className="wa-head flex items-center justify-between" style={{ gap: 16, paddingBottom: 2 }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1.2, color: '#f1f5f9', margin: 0 }}>Whale Alerts</h1>
            <p className="wa-help" style={{ marginTop: 3 }}>Tracked Base wallets, monitored for meaningful token movement.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end" style={{ gap: 6 }}>
            <Pill color="cyan" dot>Base Mainnet</Pill>
            <Pill color="slate">60+ wallets</Pill>
            <Pill color={syncing ? 'amber' : 'teal'} dot>{syncing ? 'Syncing' : 'On-demand sync'}</Pill>
            <Pill color="purple" dot>CORTEX</Pill>
          </div>
        </header>

        {/* ═══ 2. KPI ROW ════════════════════════════════════════════════════
            Flat surfaces, no per-card icon tile, no bottom accent bar, no gradient spark fill.
            The number is the only loud element; label and unit sit on one baseline above it. */}
        <div className="wa-metrics grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          {metrics.map((m, idx) => {
            const isZero = m.val === 0
            return (
              <div key={`${m.label}-${m.unit ?? 'total'}`} className="relative overflow-hidden rounded-[12px]"
                style={{ border: bdr, background: cardBg, padding: '15px 16px 14px' }}>
                <div className="flex items-baseline" style={{ gap: 6 }}>
                  <FieldLabel>{m.label}</FieldLabel>
                  {m.unit && (
                    <span className="tabular-nums" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: m.color, opacity: isZero ? 0.45 : 0.85 }}>
                      {m.unit}
                    </span>
                  )}
                </div>
                {/* A zero is dimmed rather than shown at full weight — it is a real reading, but not
                    a headline number, so it stops competing with populated counters. */}
                <p className="tabular-nums" style={{ marginTop: 10, fontSize: 30, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em', color: isZero ? '#3f4a5c' : '#f1f5f9' }}>{m.val}</p>
                <p style={{ marginTop: 7, fontSize: 11, color: '#4a5769' }}>{isZero && m.zeroSub ? m.zeroSub : m.sub}</p>
                {!isZero && <CardSpark color={m.color} seed={idx}/>}
              </div>
            )
          })}
        </div>

        {/* ═══ 3. CONTROL BAR + SYNC MODULE ══════════════════════════════════
            Previously one large card wrapping a 4-row stacked filter column and a heavy purple
            gradient sync card. Now two peer modules: a grouped control bar (rows read left→right,
            each group labelled once) and a compact operations module. */}
        <div className="wa-controls grid" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,0.85fr)', gap: 10, alignItems: 'start' }}>

          {/* ── Control bar ── */}
          {/* SPACING, DISCLOSED (final polish): row gap 14→11, group gap 22→18, label→control gap
              10→8, divider margin removed. Denser and more deliberate; no control moved or changed. */}
          <div className="rounded-[12px] flex flex-col" style={{ border: bdr, background: cardBg, padding: '13px 15px', gap: 11 }}>

            <div className="wa-ctl-row flex flex-wrap items-center" style={{ gap: 18, rowGap: 10 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <FieldLabel>Window</FieldLabel>
                <Segmented
                  options={WINDOWS.map(w => ({ value: w, label: w }))}
                  value={windowValue}
                  onChange={setWindowValue}
                />
              </div>
              <div className="flex items-center" style={{ gap: 8 }}>
                <FieldLabel>Feed</FieldLabel>
                <Segmented
                  options={[{ value: 'interesting' as const, label: 'Interesting' }, { value: 'all' as const, label: 'All activity' }]}
                  value={feedMode}
                  onChange={setFeedMode}
                />
              </div>
            </div>

            <div style={{ height: 1, background: 'rgba(148,163,184,0.07)' }} />

            <div className="flex flex-col" style={{ gap: 7 }}>
              <FieldLabel>Value range</FieldLabel>
              <div className="flex flex-wrap" style={{ gap: 5 }}>
                {RANGE_OPTIONS.map(opt => (
                  <button key={opt.value} type="button" onClick={() => setValueRange(opt.value)}
                    className={`wa-chip${valueRange === opt.value ? ' is-active' : ''}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="wa-dropdowns grid" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8 }}>
              {[
                { label: 'Alert type', val: typeFilter, set: setTypeFilter, opts: types },
                { label: 'Severity',   val: sevFilter,  set: setSevFilter,  opts: sevs  },
                { label: 'Side',       val: sideFilter, set: setSideFilter, opts: sides },
              ].map(({ label, val, set, opts }) => (
                <div key={label} className="flex flex-col" style={{ gap: 6, minWidth: 0 }}>
                  <FieldLabel>{label}</FieldLabel>
                  <div className="relative">
                    <select value={val} onChange={e => set(e.target.value)}
                      className="wa-select w-full appearance-none rounded-[8px]"
                      style={{ background: innerBg, border: bdr, color: val === 'all' ? '#64748b' : '#cbd5e1', padding: '7px 26px 7px 10px', fontSize: 12.5, fontWeight: 500, outline: 'none' }}>
                      {opts.map(o => <option key={o} value={o}>{o === 'all' ? `All` : o}</option>)}
                    </select>
                    <span className="pointer-events-none absolute" style={{ right: 10, top: '50%', transform: 'translateY(-50%)', color: '#475569' }}>
                      <svg width="8" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M0 0l4.5 5L9 0z"/></svg>
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Active-filter context line — replaces the two separate always-on helper paragraphs
                that previously sat under Value Range and Feed Mode. */}
            {(feedMode === 'interesting' || valueRange !== 'all') && (
              <p className="wa-help">
                {feedMode === 'interesting' && 'Hiding sub-$1k WETH/USDC/cbBTC moves.'}
                {feedMode === 'interesting' && valueRange !== 'all' && ' '}
                {valueRange !== 'all' && `Limited to ${RANGE_OPTIONS.find(o => o.value === valueRange)?.label} verified value.`}
              </p>
            )}
          </div>

          {/* ── Sync operations module ── */}
          <aside className="rounded-[12px] flex flex-col" style={{ border: bdr, background: cardBg, padding: '14px 16px', gap: 12 }}>

            <div className="flex items-center justify-between" style={{ gap: 8 }}>
              <h2 className="wa-sec-title">Wallet sync</h2>
              <Pill color={syncing || isFullInProgress ? 'amber' : syncState ? 'teal' : 'slate'} dot>{syncStatusText}</Pill>
            </div>

            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="rounded-[9px]" style={{ padding: '10px 12px', background: innerBg, border: bdrInner }}>
                <FieldLabel>Tracked set</FieldLabel>
                <p className="tabular-nums" style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.015em', color: '#e8eef7', margin: '7px 0 0' }}>60+</p>
              </div>
              <div className="rounded-[9px]" style={{ padding: '10px 12px', background: innerBg, border: bdrInner }}>
                <FieldLabel>Signals</FieldLabel>
                <p className="tabular-nums" style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.015em', color: effectiveInserted > 0 ? '#5eead4' : '#3f4a5c', margin: '7px 0 0' }}>
                  {syncState ? effectiveInserted : '—'}
                </p>
              </div>
            </div>

            {covPct !== null ? (
              <div>
                <div className="flex items-baseline justify-between" style={{ marginBottom: 6 }}>
                  <FieldLabel>Coverage</FieldLabel>
                  <span className="tabular-nums" style={{ fontSize: 11, fontWeight: 700, color: '#93a3ba' }}>
                    {scannedCount}/{trackedCount || stats.trackedWallets} · {covPct}%
                  </span>
                </div>
                <div className="w-full overflow-hidden rounded-full" style={{ height: 3, background: 'rgba(148,163,184,0.12)' }}>
                  <div style={{ width: `${covPct}%`, height: '100%', background: '#2dd4bf', transition: 'width 0.3s ease' }}/>
                </div>
              </div>
            ) : (
              <p className="wa-help">No sync run yet. Coverage appears after the first scan.</p>
            )}

            {(syncState?.providerErrors ?? 0) > 0 && (
              <p className="rounded-[8px]"
                style={{ margin: 0, padding: '7px 10px', fontSize: 11, lineHeight: 1.5, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.16)', color: '#e0b44a' }}>
                {syncState?.providerErrors} source delay{(syncState?.providerErrors ?? 0) > 1 ? 's' : ''} — some wallets may lag.
              </p>
            )}

            {/* Primary action stands alone; every secondary action is quiet and on one row below. */}
            <button onClick={() => { void runSync(syncState?.hasMore ? (syncState?.nextOffset ?? 0) : undefined, 'batch') }}
              disabled={syncing || (syncCooldownLeftMs > 0 && !syncState?.hasMore)}
              className="wa-btn wa-btn-primary w-full">
              {syncing
                ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"/></svg>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>}
              {syncing ? 'Scanning…' : syncState?.hasMore ? 'Continue refresh' : syncCooldownLeftMs > 0 ? `Wait ${Math.ceil(syncCooldownLeftMs / 1000)}s` : 'Sync wallets'}
            </button>

            <div className="wa-sync-btns flex items-center" style={{ gap: 9, marginTop: -3 }}>
              <button onClick={() => { void runSync(syncState?.mode === 'full' && isFullInProgress ? computedFullNextOffset : 0, 'full') }}
                disabled={syncing || (fullSyncCooldownLeftMs > 0 && !isFullInProgress)}
                className="wa-btn wa-btn-micro"
                title="Refreshes the complete tracked-wallet set">
                {syncState?.mode === 'full' && isFullInProgress
                  ? (fullSyncCooldownLeftMs > 0 ? `Wait ${Math.ceil(fullSyncCooldownLeftMs / 1000)}s` : 'Continue full')
                  : 'Full refresh'}
              </button>
              <span aria-hidden style={{ width: 1, height: 9, background: 'rgba(148,163,184,0.14)' }} />
              <button onClick={resetFilters} disabled={syncing} className="wa-btn wa-btn-micro">Reset filters</button>
              <span aria-hidden style={{ width: 1, height: 9, background: 'rgba(148,163,184,0.14)' }} />
              <button onClick={clearSyncState} disabled={syncing} className="wa-btn wa-btn-micro">Clear state</button>
            </div>

            {syncState && (
              <p className="wa-help" style={{ borderTop: bdrInner, paddingTop: 10 }}>
                {syncing && syncState.mode === 'full'
                  ? `Scanning ${scannedCount} of ${trackedCount || stats.trackedWallets}…`
                  : isFullInProgress
                    ? `Full refresh paused at ${scannedCount} of ${trackedCount || stats.trackedWallets}.`
                    : syncState.mode === 'full' && syncState.done === true && !syncState.hasMore
                      ? `Full refresh complete — ${scannedCount} of ${trackedCount} checked.`
                      : `Last refresh checked ${scannedCount} of ${trackedCount || stats.trackedWallets} wallets.`}
              </p>
            )}

            {/* DIAGNOSTICS DISCLOSURE, DISCLOSED: the previous "+ Advanced Diagnostics" button had
                no onClick at all — it rendered but did nothing. Kept (per the redesign brief's
                "should not dominate the card") as a quiet, collapsed-by-default disclosure that now
                actually works, rendering the REAL `feedDiagnostics` this page already receives from
                /api/whale-alerts. No new request and no fabricated values — each row is omitted
                entirely when the API didn't supply that field. */}
            {feedDiagnostics && (
              <div style={{ borderTop: bdrInner, paddingTop: 10 }}>
                <button type="button" onClick={() => setShowDiagnostics(v => !v)}
                  className="wa-btn wa-btn-quiet" style={{ padding: '2px 0', gap: 5 }}
                  aria-expanded={showDiagnostics}>
                  <svg width="8" height="8" viewBox="0 0 9 5" fill="currentColor"
                    style={{ transform: showDiagnostics ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
                    <path d="M0 0l4.5 5L9 0z"/>
                  </svg>
                  Diagnostics
                </button>
                {showDiagnostics && (
                  <div className="flex flex-col tabular-nums" style={{ gap: 5, marginTop: 9 }}>
                    {([
                      ['Rows returned',  feedDiagnostics.rawRows],
                      ['After cap',      feedDiagnostics.afterDiversityCap],
                      ['Hidden: low signal', feedDiagnostics.hiddenAsBoring],
                      ['Hidden: filters', feedDiagnostics.hiddenByFilter],
                      ['Hidden: dust',   feedDiagnostics.hiddenAsDust],
                      ['Enrichment',     feedDiagnostics.enrichmentBudget?.liveEnrichmentEnabled == null
                        ? undefined
                        : (feedDiagnostics.enrichmentBudget.liveEnrichmentEnabled ? 'live' : 'cached')],
                      ['Cache hits',     feedDiagnostics.enrichmentBudget?.cacheHits],
                    ] as Array<[string, number | string | undefined]>)
                      .filter(([, v]) => v !== undefined && v !== null)
                      .map(([k, v]) => (
                        <div key={k} className="flex items-baseline justify-between" style={{ gap: 10, fontSize: 11 }}>
                          <span style={{ color: '#4a5769' }}>{k}</span>
                          <span style={{ color: '#93a3ba', fontWeight: 600 }}>{v}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </aside>

        </div>

        {/* ═══ 4. ALERT FEED — page focus ═════════════════════════════════════
            Given the strongest border, its own sticky operational header and the most internal
            room on the page, so it reads as the product rather than one card among five. */}
        <section className="overflow-hidden rounded-[12px]"
          style={{ border: '1px solid rgba(148,163,184,0.17)', background: cardBg, boxShadow: '0 1px 0 rgba(255,255,255,0.03) inset, 0 18px 48px rgba(0,0,0,0.36)' }}>

          {/* feed header */}
          <div className="flex flex-wrap items-center justify-between"
            style={{ gap: 12, padding: '13px 18px', borderBottom: '1px solid rgba(148,163,184,0.11)', background: 'rgba(148,163,184,0.022)' }}>
            <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
              <h2 className="wa-sec-title" style={{ fontSize: 14 }}>Alert feed</h2>
              <span aria-hidden style={{ width: 1, height: 12, background: 'rgba(148,163,184,0.16)' }} />
              <span className="flex items-center" style={{ gap: 5, fontSize: 11, fontWeight: 600, color: '#5eead4' }}>
                <span className="rounded-full" style={{ width: 5, height: 5, background: '#2dd4bf', display: 'inline-block' }} />
                Auto-update
              </span>
              {feedDiagnostics != null && (
                <span style={{ fontSize: 11, color: feedDiagnostics.enrichmentBudget?.liveEnrichmentEnabled ? '#5eead4' : '#8b7a4a' }}>
                  · Signals {feedDiagnostics.enrichmentBudget?.liveEnrichmentEnabled ? 'live' : 'cached'}
                </span>
              )}
              {alerts.length > 0 && (
                <span className="tabular-nums" style={{ fontSize: 11, color: '#55647d' }}>
                  · {alerts.length} shown{(feedDiagnostics?.afterDiversityCap ?? 0) > alerts.length ? ` of ${feedDiagnostics?.afterDiversityCap}` : ''}
                </span>
              )}
            </div>
            <div className="wa-feed-actions flex items-center" style={{ gap: 6 }}>
              <button className="wa-btn wa-btn-quiet" title="Pause auto-update">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>
                Pause
              </button>
              <button onClick={goClark} className="wa-btn wa-btn-secondary">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Ask Clark
              </button>
              <button onClick={() => void loadAlerts({ enrich: true })}
                disabled={enrichLoading || loading}
                className="wa-btn wa-btn-primary" style={{ padding: '8px 14px', fontSize: 12 }}>
                {enrichLoading
                  ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"/></svg>
                  : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                }
                {enrichLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>

          {/* skeleton */}
          {loading && Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center"
              style={{ gap: 12, padding: '13px 18px', borderBottom: bdrInner, borderLeft: '2px solid rgba(148,163,184,0.07)', opacity: 1 - i * 0.14 }}>
              <div className="shrink-0 rounded-[10px]" style={{ width: 36, height: 36, background: 'rgba(148,163,184,0.06)' }}/>
              <div className="flex-1 flex flex-col" style={{ gap: 7 }}>
                <div className="rounded-full" style={{ height: 10, width: '52%', background: 'rgba(148,163,184,0.06)' }}/>
                <div className="rounded-full" style={{ height: 8, width: '34%', background: 'rgba(148,163,184,0.04)' }}/>
              </div>
              <div className="rounded-full" style={{ height: 16, width: 52, background: 'rgba(148,163,184,0.06)' }}/>
            </div>
          ))}

          {/* error */}
          {feedError && !loading && (
            <div className="flex flex-col items-center" style={{ padding: '56px 24px 52px', textAlign: 'center' }}>
              <div className="flex items-center justify-center rounded-[10px]"
                style={{ width: 40, height: 40, marginBottom: 16, background: 'rgba(244,63,94,0.07)', border: '1px solid rgba(244,63,94,0.18)' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="1.7" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <p style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: '#e8eef7', margin: 0 }}>Feed request failed</p>
              <p style={{ marginTop: 7, maxWidth: 420, fontSize: 12.5, lineHeight: 1.6, color: '#5d6b82' }}>
                The alert feed could not be reached. Tracked wallets are unaffected and any sync in progress continues.
              </p>
              <button onClick={() => void loadAlerts()} className="wa-btn wa-btn-primary" style={{ marginTop: 18 }}>
                Retry
              </button>
            </div>
          )}

          {/* empty state */}
          {!feedError && !loading && alerts.length === 0 && (() => {
            const total   = syncState?.trackedWalletsTotal ?? 0
            const scanned = effectiveProcessed
            const partial = Boolean(syncState && (syncState.hasMore ?? false))
            const allDone = Boolean(syncState && !(syncState.hasMore ?? false))
            const hasProviderErrors = (syncState?.providerErrors ?? 0) > 0
            const insertedSoFar = syncState?.insertedTotal ?? syncState?.inserted ?? 0
            const rangeActive = valueRange !== 'all'
            // Use server diagnostics to detect API-side filtering
            const serverHiddenBoring = feedDiagnostics?.hiddenAsBoring ?? 0
            const serverHiddenFilter = feedDiagnostics?.hiddenByFilter ?? 0
            const serverRawRows = feedDiagnostics?.rawRows ?? 0
            const serverFilteredSomething = serverHiddenBoring > 0 || serverHiddenFilter > 0 || serverRawRows > 0
            // UI-level filters user explicitly set (not interesting mode which is implicit)
            const uiFiltersActive = rangeActive || typeFilter !== 'all' || sevFilter !== 'all' || sideFilter !== 'all'
            const hiddenByFilters = serverFilteredSomething || (insertedSoFar > 0 && uiFiltersActive)
            const hiddenCount = serverHiddenBoring + serverHiddenFilter || insertedSoFar
            const rangeLabel = RANGE_OPTIONS.find(o => o.value === valueRange)?.label ?? valueRange
            // Specific case: value range filter is hiding unpriced (null-USD) activity
            const unpricedHidden = rangeActive && serverHiddenFilter > 0
            const title = unpricedHidden
              ? 'Alerts exist, but this value filter hides unpriced activity.'
              : hiddenByFilters
                ? `${hiddenCount > 0 ? `${hiddenCount} alerts` : 'Alerts'} found — hidden by filters`
                : rangeActive
                  ? 'No alerts match this range in the selected window.'
                  : partial
                    ? 'Batch scan in progress'
                    : allDone
                      ? 'No qualifying whale alerts found'
                      : 'No whale alerts yet'
            const body = unpricedHidden
              ? `${serverHiddenFilter} alert${serverHiddenFilter !== 1 ? 's' : ''} found with unverified USD value. Switch to All value range and All activity to see them.`
              : hiddenByFilters
                ? 'Switch to All activity or reset filters to view them.'
                : rangeActive
                  ? `No alerts in the ${windowValue} window have a verified USD value in the ${rangeLabel} range. Try "All" or a different range.`
                  : partial
                    ? `Checked ${scanned} of ${total} wallets. No fresh signal in the checked window yet. Use Continue refresh to scan more wallets.`
                    : allDone
                      ? 'No qualifying recent whale activity found in this batch.'
                      : 'ChainLens is watching selected Base wallets. Run a sync to index recent movements.'
            // A filtered-out result always offers a widening action; an un-synced/empty result
            // offers the sync that would actually produce data. There is never a dead end.
            const filterBlocked = unpricedHidden || hiddenByFilters || rangeActive || uiFiltersActive
            return (
              <div className="flex flex-col items-center" style={{ padding: '56px 24px 52px', textAlign: 'center' }}>
                <div className="flex items-center justify-center rounded-[10px]"
                  style={{ width: 40, height: 40, marginBottom: 16, background: 'rgba(45,212,191,0.07)', border: '1px solid rgba(45,212,191,0.16)' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" opacity="0.9">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                </div>
                <p style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: '#e8eef7', margin: 0 }}>{title}</p>
                <p style={{ marginTop: 7, maxWidth: 420, fontSize: 12.5, lineHeight: 1.6, color: '#5d6b82' }}>
                  {body}
                </p>

                {/* ACTIONS, DISCLOSED (final polish): all three routes out of an empty feed are
                    always offered — sync (produce data), broaden (stop hiding data), Ask Clark
                    (explain the state). Only the EMPHASIS changes: whichever action actually
                    addresses the current cause takes the primary slot, so the card never presents
                    a dead end or a misleading "fix". Every handler here already existed. */}
                {(() => {
                  const syncBtn = (
                    <button key="sync"
                      onClick={() => { void runSync(syncState?.hasMore ? (syncState?.nextOffset ?? 0) : undefined, 'batch') }}
                      disabled={syncing || (syncCooldownLeftMs > 0 && !syncState?.hasMore)}
                      className={`wa-btn ${filterBlocked ? 'wa-btn-secondary' : 'wa-btn-primary'}`}>
                      {syncing ? 'Scanning…' : syncState?.hasMore ? 'Continue refresh' : syncCooldownLeftMs > 0 ? `Wait ${Math.ceil(syncCooldownLeftMs / 1000)}s` : 'Sync wallets'}
                    </button>
                  )
                  const broadenBtn = (
                    <button key="broaden" onClick={showAllAlerts}
                      className={`wa-btn ${filterBlocked ? 'wa-btn-primary' : 'wa-btn-secondary'}`}>
                      {unpricedHidden ? 'Show unpriced activity' : 'Broaden filters'}
                    </button>
                  )
                  const clarkBtn = (
                    <button key="clark" onClick={goClark} className="wa-btn wa-btn-quiet" style={{ padding: '8px 11px' }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                      </svg>
                      Ask Clark
                    </button>
                  )
                  return (
                    <div className="flex flex-wrap items-center justify-center" style={{ gap: 7, marginTop: 18 }}>
                      {filterBlocked ? [broadenBtn, syncBtn, clarkBtn] : [syncBtn, broadenBtn, clarkBtn]}
                    </div>
                  )
                })()}
                {filterBlocked && (
                  <button onClick={resetFilters} className="wa-btn wa-btn-quiet" style={{ marginTop: 8, fontSize: 11 }}>
                    Reset all filters
                  </button>
                )}

                {hasProviderErrors && (
                  <p className="rounded-[8px]"
                    style={{ marginTop: 14, maxWidth: 420, padding: '7px 12px', fontSize: 11.5, lineHeight: 1.5, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.16)', color: '#e0b44a' }}>
                    {syncState!.providerErrors} source delay{(syncState!.providerErrors ?? 0) > 1 ? 's' : ''} — some wallets may be delayed.
                  </p>
                )}

                {/* Status strip — proves the monitor is alive and what it has actually done, so an
                    empty feed reads as "no signal yet", never as "nothing is running". */}
                <div className="flex flex-wrap items-center justify-center tabular-nums"
                  style={{ gap: '6px 14px', marginTop: 22, paddingTop: 16, borderTop: bdrInner, maxWidth: 480, width: '100%', fontSize: 11 }}>
                  {[
                    { k: 'Tracked', v: '60+ wallets' },
                    { k: 'Scanned', v: syncState ? `${scanned} of ${total || stats.trackedWallets}` : 'No sync yet' },
                    ...(syncState && insertedSoFar > 0 ? [{ k: 'Found', v: `${insertedSoFar} signals` }] : []),
                    ...(syncState ? [{ k: 'Skipped', v: String(syncState.skipped ?? 0) }] : []),
                    { k: 'Feed', v: hasProviderErrors ? 'Source delay' : 'Healthy' },
                  ].map(({ k, v }) => (
                    <span key={k} className="flex items-center" style={{ gap: 5 }}>
                      <span style={{ color: '#3f4a5c' }}>{k}</span>
                      <span style={{ color: '#93a3ba', fontWeight: 600 }}>{v}</span>
                    </span>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* alert rows */}
          {!feedError && !loading && alerts.length > 0 && alerts.map((alert, i) => {
            const sideStyle  = getSide(alert.side)
            const rawTok     = alert.token_symbol || alert.token_name || 'Unknown token'
            const focusTok    = alert.focus_token_symbol || null
            const tok         = focusTok ?? rawTok
            const isMultiTok  = rawTok.includes(' / ')
            const primarySym = tok.split(' / ')[0]
            const lbl        = primarySym.slice(0, 4).toUpperCase()
            const s          = alert.side?.toLowerCase() ?? ''
            const chipLabel  = isMultiTok ? 'SWAP' : sideStyle.label

            // Amount: prefer USD; fall back to token number; never render $0 for unpriced rows.
            // amount_usd=0 means the DB did not have a verified price — treat it as null.
            const amtUnverified = alert.amount_usd == null || alert.amount_usd === 0
            const amtU    = (!amtUnverified && alert.amount_usd != null) ? fmtUsd(alert.amount_usd) : null
            const amtTNum = isMultiTok ? null : fmtAmtNum(alert.amount_token)
            const amtShow = amtU ?? (amtTNum ? `${amtTNum} ${primarySym}` : (amtUnverified ? 'value unverified' : null))

            // Verb and preposition split so amount fits between them for swaps
            const isSwap   = isMultiTok || (focusTok != null && s !== 'buy')
            const baseVerb = isSwap ? 'swapped' : s === 'buy' ? 'bought' : s === 'sell' ? 'sold' : 'moved'

            const logoUrl = alert.token_image_url ?? alert.logo_url ?? alert.image ?? alert.token_logo ?? null

            const walletName = alert.wallet_label || 'Tracked Wallet'
            const signal     = alert.signal_score ?? 'LOW SIGNAL'
            const signalReason =
              signal === 'HIGH SIGNAL' ? ((alert.token_symbol ?? '').toUpperCase().includes('USDC') ? 'Large stablecoin move' : 'High-value tracked-wallet movement')
              : signal === 'WATCH' ? 'Repeated activity from tracked wallet'
              : signal === 'NOISE' ? 'Value unverified'
              : (amtUnverified ? 'Value unverified' : 'Low-value token movement')

            // Per-row Clark prompt — full structured context
            const alertAge = ageStr(alert.occurred_at)
            const alertType = isSwap ? 'swap' : s === 'buy' ? 'buy' : s === 'sell' ? 'sell' : 'transfer'
            const rowPrompt = [
              `[ChainLens Whale Alert — Row Context]`,
              `Feature: whale_alerts | Chain: Base Mainnet`,
              `Alert type: ${alertType}`,
              `Wallet label: ${walletName}`,
              alert.wallet_address ? `Wallet address: ${alert.wallet_address}` : null,
              `Token: ${tok}`,
              alert.token_symbol && tok !== alert.token_symbol ? `Raw token symbol: ${alert.token_symbol}` : null,
              `Side: ${alert.side ?? 'unknown'}`,
              (alert.amount_usd != null && alert.amount_usd > 0)
                ? `Value (USD): $${alert.amount_usd.toFixed(2)}`
                : 'Value (USD): unverified',
              alert.amount_token != null
                ? `Amount (token): ${alert.amount_token} ${alert.token_symbol ?? ''}`.trim()
                : null,
              `Legs: ${alert.legs ?? 1}${(alert.legs ?? 1) > 1 ? ' (multi-leg swap)' : ''}`,
              (alert.repeats ?? 1) > 1 ? `Repeated: ${alert.repeats} times within 5 minutes` : null,
              `Signal score: ${signal}`,
              alert.severity ? `Severity: ${alert.severity}` : null,
              alert.summary ? `Summary: ${alert.summary}` : null,
              alert.tx_hash ? `TX hash: ${alert.tx_hash}` : null,
              `Timestamp: ${alert.occurred_at ?? 'unknown'} (${alertAge})`,
              ``,
              `Answer these questions about this alert:`,
              `1. What happened on-chain?`,
              `2. Why might this matter — what does this wallet's action suggest?`,
              `3. Is this worth monitoring and why?`,
              `4. What should I check next (token, wallet pattern, or related activity)?`,
              ``,
              `Do not invent data. Do not suggest copy-trading. Say "worth monitoring" not "buy". Do not give financial advice.`,
            ].filter(Boolean).join('\n')
            const goRowClark = () => { window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(rowPrompt)}&autosend=1` }

            const scanHref = alert.tx_hash ? `https://basescan.org/tx/${alert.tx_hash}` : null

            return (
              <div key={alert.id ?? `${alert.tx_hash ?? ''}-${i}`}
                className="wa-row"
                style={{ borderBottom: bdrInner, borderLeft: `2px solid ${sideStyle.line}` }}>
                <div className="flex items-start" style={{ gap: 12, padding: '13px 18px' }}>

                  <TokenAvatar tok={tok} logoUrl={logoUrl} avatarBg={sideStyle.avatarBg} line={sideStyle.line} />

                  {/* Content */}
                  <div className="flex-1" style={{ minWidth: 0 }}>

                    {/* Primary line — HIERARCHY, DISCLOSED (final polish): previously wallet name,
                        verb, amount and token all rendered at one size/weight, separated only by
                        colour, so nothing led the row. Now the VALUE and TOKEN (what actually
                        happened) carry the weight, the wallet name is secondary, and the verb is
                        connective tissue. Amount uses tabular-nums so figures align down the feed.
                        Identical content and identical conditional logic — type only. */}
                    <div className="flex flex-wrap items-baseline" style={{ gap: '0 6px' }}>
                      <span className="rounded-[4px]" style={{
                        padding: '2px 7px', fontSize: 9.5, fontWeight: 800, letterSpacing: '0.09em',
                        background: sideStyle.chipBg, border: `1px solid ${sideStyle.chipBd}`, color: sideStyle.chipTx,
                        alignSelf: 'center',
                      }}>
                        {chipLabel}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#b9c6d8' }}>{walletName}</span>
                      <span style={{ fontSize: 12.5, color: '#55647d' }}>{baseVerb}</span>
                      {amtShow && (
                        <span className={amtShow === 'value unverified' ? undefined : 'tabular-nums'}
                          style={{
                            fontSize: amtShow === 'value unverified' ? 12.5 : 14.5,
                            fontWeight: amtShow === 'value unverified' ? 500 : 700,
                            letterSpacing: '-0.01em',
                            color: amtShow === 'value unverified' ? '#4a5769' : '#5eead4',
                            fontStyle: amtShow === 'value unverified' ? 'italic' : undefined,
                          }}>
                          {amtShow}
                        </span>
                      )}
                      {isSwap && <span style={{ fontSize: 12.5, color: '#55647d' }}>into</span>}
                      <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', color: '#f1f5f9' }}>{tok}</span>
                    </div>

                    {/* Subline — time pulled to the front as the anchor a live feed is scanned by;
                        the rest stays in the same order, one quieter tone. */}
                    <p style={{ marginTop: 5, fontSize: 11, color: '#4a5769' }}>
                      <span style={{ color: '#7c8ba1', fontWeight: 600 }}>{timeAgo(alert.occurred_at)}</span>
                      {' · '}Tracked wallet · Base
                      {(alert.legs ?? 1) > 1 ? ` · ${alert.legs} legs` : ''}
                      {(alert.repeats ?? 1) > 1 ? ` · ×${alert.repeats} in 5m` : ''}
                      {' · '}{signalReason}
                    </p>
                    {/* Wallet behavior tags */}
                    {alert.walletContext && (() => {
                      const ctx = alert.walletContext!
                      const TYPE_LABEL: Record<string, string> = {
                        repeat_accumulator: 'Repeat accumulator', active_rotator: 'Active rotator',
                        fresh_wallet: 'Fresh wallet', seller_distribution: 'Seller / distribution',
                        mixed_flow: 'Mixed flow', contract_or_router: 'Contract / router',
                        one_off: 'One-off',
                      }
                      const typeLabel = TYPE_LABEL[ctx.behaviorType] ?? ''
                      const showMonitor = ctx.behaviorScore >= 60 && ctx.confidence !== 'low'
                      if (!typeLabel && !showMonitor) return null
                      return (
                        <div className="flex flex-wrap items-center" style={{ gap: 4, marginTop: 4 }}>
                          {typeLabel && (
                            <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'rgba(148,163,184,0.07)', border: '1px solid rgba(148,163,184,0.14)', color: '#475569' }}>
                              {typeLabel}
                            </span>
                          )}
                          {showMonitor && (
                            <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.20)', color: '#34d399' }}>
                              Worth monitoring
                            </span>
                          )}
                          {ctx.alertCount7d > 1 && (
                            <span style={{ fontSize: 9, color: '#334155' }}>· {ctx.alertCount7d} alerts/7d</span>
                          )}
                          {(ctx.verifiedUsdFlow7d ?? 0) > 0 && (
                            <span style={{ fontSize: 9, color: '#334155' }}>· {fmtUsd(ctx.verifiedUsdFlow7d)} 7d flow</span>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  {/* Right column */}
                  <div className="shrink-0 flex flex-col items-end" style={{ marginTop: 2, gap: 6 }}>
                    <span className="rounded-full"
                      style={{ padding: '2px 10px', fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', ...signalStyle(signal) }}>
                      {signal}
                    </span>
                    <div className="flex items-center" style={{ gap: 6 }}>
                      {scanHref && (
                        <a href={scanHref} target="_blank" rel="noreferrer"
                          className="flex items-center justify-center rounded-[8px] hover:opacity-80"
                          style={{ width: 24, height: 24, color: '#475569', background: 'rgba(255,255,255,0.04)', border: bdrInner }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                          </svg>
                        </a>
                      )}
                      <button onClick={goRowClark}
                        className="flex items-center rounded-[8px] hover:opacity-90"
                        style={{ gap: 4, padding: '4px 10px', fontSize: 10, fontWeight: 700, background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.24)', color: '#c4b5fd' }}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        Ask Clark
                      </button>
                    </div>
                  </div>

                </div>
              </div>
            )
          })}

          {/* feed footer */}
          {alerts.length > 0 && (
            <div className="flex flex-wrap items-center justify-between"
              style={{ gap: 10, padding: '10px 18px', borderTop: '1px solid rgba(148,163,184,0.09)', background: 'rgba(148,163,184,0.015)' }}>
              <span style={{ fontFamily: 'var(--font-plex-mono,monospace)', fontSize: 10, letterSpacing: '0.04em', color: '#3a4557' }}>base.alerts.v2</span>
              <div className="flex items-center" style={{ gap: 14, fontSize: 10.5 }}>
                {[{ c: '#2dd4bf', l: 'Buy' }, { c: '#f43f5e', l: 'Sell' }, { c: '#8b5cf6', l: 'Transfer' }].map(({ c, l }) => (
                  <span key={l} className="flex items-center" style={{ gap: 5 }}>
                    <span className="inline-block rounded-full" style={{ width: 5, height: 5, background: c, opacity: 0.85 }}/>
                    <span style={{ color: '#55647d' }}>{l}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

        </section>

      </div>
    </div>
  )
}
