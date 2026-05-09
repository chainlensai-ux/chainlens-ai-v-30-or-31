'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

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
type FeedDiagnostics = { rawRows?: number; afterDiversityCap?: number }

const RANGE_OPTIONS: { label: string; value: ValueRange }[] = [
  { label: 'All',       value: 'all' },
  { label: '$100–$500', value: '100-500' },
  { label: '$500–$1k',  value: '500-1000' },
  { label: '$1k–$5k',   value: '1000-5000' },
  { label: '$5k–$10k',  value: '5000-10000' },
  { label: '$10k+',     value: '10000+' },
]
const WINDOWS = ['1h', '6h', '24h', '7d'] as const
const CLIENT_SYNC_COOLDOWN_MS = 10 * 60 * 1000
const CLIENT_FULL_SYNC_COOLDOWN_MS = 45 * 60 * 1000
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
  return               { line: '#8b5cf6', avatarBg: '#1e0d3b', chipBg: 'rgba(139,92,246,0.12)',  chipBd: 'rgba(139,92,246,0.32)',  chipTx: '#c4b5fd', label: 'TRANSFER' }
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
  if (sig === 'HIGH')  return { background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.28)', color: '#2dd4bf' }
  if (sig === 'WATCH') return { background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.28)', color: '#fcd34d' }
  return { background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.18)', color: '#64748b' }
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

function CardSpark({ color, seed = 0 }: { color: string; seed?: number }) {
  const paths = [
    'M0 30 L18 22 L36 16 L54 20 L72 11 L90 14 L108 7 L126 10 L144 3 L160 2',
    'M0 28 L18 20 L36 24 L54 14 L72 18 L90 9 L108 13 L126 5 L144 9 L160 3',
    'M0 24 L18 30 L36 19 L54 25 L72 13 L90 17 L108 8 L126 13 L144 4 L160 2',
    'M0 26 L18 19 L36 14 L54 21 L72 10 L90 15 L108 6 L126 11 L144 2 L160 5',
  ]
  const d = paths[seed % 4]
  const uid = `csp${seed}${color.replace('#', '')}`
  return (
    <svg width="160" height="40" viewBox="0 0 160 40" fill="none"
      style={{ position: 'absolute', bottom: 0, right: 0, opacity: 0.48, pointerEvents: 'none' }}>
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.26" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L160 40 L0 40Z`} fill={`url(#${uid})`} />
      <path d={d} stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <circle cx="160" cy="2" r="2" fill={color} />
    </svg>
  )
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
  const { plan, loading: planLoading } = usePlanWithLoading()
  const [windowValue, setWindowValue] = useState<(typeof WINDOWS)[number]>('24h')
  const [valueRange, setValueRange]   = useState<ValueRange>('all')
  const [typeFilter, setTypeFilter]   = useState('all')
  const [sevFilter, setSevFilter]     = useState('all')
  const [sideFilter, setSideFilter]   = useState('all')
  const [alerts, setAlerts]           = useState<AlertItem[]>([])
  const [stats, setStats]             = useState<AlertStats>({ alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
  const [loading, setLoading]         = useState(false)
  const [syncing, setSyncing]         = useState(false)
  const [syncState, setSyncState]     = useState<SyncResponse | null>(null)
  const [feedError, setFeedError]     = useState(false)
  const [feedDiagnostics, setFeedDiagnostics] = useState<FeedDiagnostics | null>(null)
  const [syncCooldownLeftMs, setSyncCooldownLeftMs] = useState(0)
  const [fullSyncCooldownLeftMs, setFullSyncCooldownLeftMs] = useState(0)

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
  }, [])

  const loadAlerts = useCallback(async () => {
    setLoading(true)
    setFeedError(false)
    try {
      const p = new URLSearchParams({ window: windowValue, limit: '100' })
      if (valueRange !== 'all') p.set('valueRange', valueRange)
      if (typeFilter !== 'all') p.set('type', typeFilter)
      if (sevFilter !== 'all')  p.set('severity', sevFilter)
      if (sideFilter !== 'all') p.set('side', sideFilter)
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
    } catch {
      setFeedError(true)
    } finally {
      setLoading(false)
    }
  }, [windowValue, valueRange, typeFilter, sevFilter, sideFilter])

  useEffect(() => { void loadAlerts() }, [loadAlerts])

  const runSync = async (offset?: number, mode: 'batch' | 'full' = 'batch') => {
    const now = Date.now()
    const cacheKey = mode === 'full' ? CLIENT_FULL_SYNC_CACHE_KEY : CLIENT_SYNC_CACHE_KEY
    const cooldownMs = mode === 'full' ? CLIENT_FULL_SYNC_COOLDOWN_MS : CLIENT_SYNC_COOLDOWN_MS
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
          const params = new URLSearchParams({ window: '7d', limit: '15', minUsd: '0', mode: 'full', offset: String(currentOffset) })
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
          await new Promise<void>(r => setTimeout(r, 300))
        }
      } else {
        // Batch: single call
        const params = new URLSearchParams({ window: '7d', limit: '15', minUsd: '0', mode: 'batch' })
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
      const left = Math.max(0, CLIENT_SYNC_COOLDOWN_MS - (Date.now() - lastSyncAt))
      const fullLeft = Math.max(0, CLIENT_FULL_SYNC_COOLDOWN_MS - (Date.now() - lastFullSyncAt))
      setSyncCooldownLeftMs(left)
      setFullSyncCooldownLeftMs(fullLeft)
    }
    tick()
    const id = window.setInterval(tick, 30_000)
    return () => window.clearInterval(id)
  }, [])

  const resetFilters = () => {
    setTypeFilter('all')
    setSevFilter('all')
    setSideFilter('all')
    setValueRange('all')
    setWindowValue('24h')
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
        : 'Checking wallets…')
    : isFullInProgress
      ? 'Full refresh in progress'
      : syncState
        ? (syncState.hasMore ? 'Partial refresh' : (syncState.mode === 'full' ? 'Full refresh complete' : 'Recently refreshed'))
        : 'Ready to sync'

  const lastSyncSummary = syncState ? `${syncState.processed ?? 0} scanned this batch / ${syncState.inserted ?? 0} inserted` : 'No signal in checked window'
  const providerSummary = syncState ? ((syncState.providerErrors ?? 0) > 0 ? `Degraded (${syncState.providerErrors} errors)` : 'Healthy') : 'No signal in checked window'
  const buildClarkPrompt = () => {
    if (alerts.length > 0) {
      const topAlerts = alerts.slice(0, 10).map(a => {
        const label  = a.wallet_label || 'Tracked Wallet'
        const tok    = a.token_symbol || a.token_name || 'Unknown token'
        const side   = a.side ?? 'move'
        const amtUsd = a.amount_usd != null ? `$${a.amount_usd.toFixed(0)}` : 'USD unverified'
        const amtTok = a.amount_token != null ? `${a.amount_token} ${tok}`.trim() : null
        const amtStr = amtTok ? `${amtTok} (${amtUsd})` : amtUsd
        const sig    = a.signal_score ?? 'LOW'
        const legs   = (a.legs ?? 1) > 1 ? ` | ${a.legs} legs` : ''
        const rep    = (a.repeats ?? 1) > 1 ? ` | ×${a.repeats}` : ''
        return `[${sig}] ${label}: ${side} ${amtStr}${legs}${rep}`
      }).join('\n')
      return [
        `Summarize my Whale Alerts feed. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Window: ${windowValue}. Alerts visible: ${alerts.length}.`,
        `Top alerts:\n${topAlerts}`,
        `Note: wallet_label is an internal ChainLens label, not a verified public identity. USD value unverified for tokens outside USDC/USDT/WETH/cbBTC.`,
        `What are whales doing, which signals are strongest, and what should I watch next? Do not invent data.`,
      ].join('\n\n')
    }
    return `Review my Whale Alerts setup. No alerts visible. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, valueRange ${valueRange}. Explain what this means. Do not invent alerts.`
  }
  const goClark = () => { window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1` }

  const metrics = [
    { label: 'ALERTS · 15M',    val: stats.alerts15m,      sub: 'Last quarter hour',   color: '#2dd4bf' },
    { label: 'ALERTS · 1H',     val: stats.alerts1h,       sub: 'Past 60 minutes',      color: '#2dd4bf' },
    { label: 'ALERTS · 24H',    val: stats.alerts24h,      sub: 'Rolling day window',   color: '#8b5cf6' },
    { label: 'TRACKED WALLETS', val: stats.trackedWallets, sub: 'Smart money + manual', color: '#ec4899' },
  ]

  const cardBg   = 'rgba(7,16,27,0.92)'
  const innerBg  = 'rgba(4,10,18,0.95)'
  const bdr      = '1px solid rgba(255,255,255,0.09)'
  const bdrInner = '1px solid rgba(255,255,255,0.06)'

  if (planLoading) return <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Loading plan access…</div>
  if (!canAccessFeature(plan, 'whale-alerts')) return <LockedPanel feature="whale-alerts" />

  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden"
      style={{ background: 'radial-gradient(ellipse 90% 60% at 50% -8%,rgba(45,212,191,0.09) 0%,transparent 52%),radial-gradient(ellipse 55% 45% at 88% 6%,rgba(139,92,246,0.07) 0%,transparent 46%),#060810', color: '#f1f5f9' }}>

      <div className="mx-auto w-full flex flex-col" style={{ maxWidth: 1280, gap: 24, padding: '24px 16px' }}>

        {/* ═══ 1. HERO ═══════════════════════════════════════════════════════ */}
        <div className="grid rounded-[28px]"
          style={{ gridTemplateColumns: '1.4fr 360px', gap: 24, border: bdr, background: cardBg, padding: 24, boxShadow: '0 0 80px rgba(45,212,191,0.05),0 24px 64px rgba(0,0,0,0.55)' }}>

          <div className="flex flex-col justify-center">
            <div className="flex items-center" style={{ gap: 8, marginBottom: 12 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#2dd4bf' }}>Whale Alerts</span>
              <span style={{ color: '#1e293b' }}>·</span>
              <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#334155' }}>base mainnet</span>
            </div>
            <h1 style={{ fontSize: '2.6rem', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em', color: '#f8fafc', margin: 0 }}>Whale Alerts</h1>
            <p style={{ marginTop: 8, maxWidth: 420, fontSize: 14, lineHeight: 1.6, color: '#64748b' }}>
              Track selected Base wallets for meaningful token movement.
            </p>
            <div className="flex flex-wrap" style={{ gap: 8, marginTop: 16 }}>
              <Pill color="cyan" dot>Base Mainnet</Pill>
              <Pill color="slate">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 2, opacity: 0.6 }}>
                  <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
                </svg>
                {stats.trackedWallets > 0 ? `${stats.trackedWallets} tracked wallets` : 'Wallets loading'}
              </Pill>
              <Pill color="teal" dot>{syncing ? 'Syncing…' : 'On-demand sync mode'}</Pill>
              <Pill color="purple" dot>CORTEX Watching</Pill>
            </div>
          </div>

          <div className="flex flex-col justify-center rounded-[16px]" style={{ background: innerBg, border: bdrInner, padding: 16 }}>
            <div className="flex items-start" style={{ gap: 16 }}>
              <div className="relative shrink-0" style={{ width: 76, height: 76, marginTop: 2 }}>
                {([0, 9, 18, 27] as const).map((ins, ri) => (
                  <div key={ri} className="absolute rounded-full" style={{
                    inset: ins,
                    border: `1px solid rgba(45,212,191,${[0.10, 0.14, 0.21, 0.31][ri]})`,
                    background: ri === 3 ? 'rgba(45,212,191,0.09)' : 'transparent',
                  }}/>
                ))}
                <div className="absolute rounded-full" style={{ inset: 34, background: 'rgba(45,212,191,0.80)', boxShadow: '0 0 10px rgba(45,212,191,0.85)' }}/>
                <div className="absolute rounded-full" style={{ width: 7, height: 7, top: 9, left: '50%', transform: 'translateX(-50%)', background: '#22c55e', boxShadow: '0 0 8px #22c55e' }}/>
              </div>
              <div className="flex-1" style={{ minWidth: 0 }}>
                <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.16em', color: '#4ade80' }}>● Live Wallet Movement</p>
                <p style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, color: '#475569' }}>Listening for high-signal wallet moves on Base.</p>
                <div style={{ marginTop: 12 }}>
                  <svg width="100%" height="28" viewBox="0 0 200 28" preserveAspectRatio="none" fill="none">
                    <defs>
                      <linearGradient id="hero-sp" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.20"/>
                        <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0"/>
                      </linearGradient>
                    </defs>
                    <path d="M0 25 L22 20 L44 15 L66 18 L88 10 L110 13 L132 6 L154 9 L176 3 L200 2"
                      stroke="#2dd4bf" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.70"/>
                    <path d="M0 25 L22 20 L44 15 L66 18 L88 10 L110 13 L132 6 L154 9 L176 3 L200 2 L200 28 L0 28Z"
                      fill="url(#hero-sp)"/>
                    <circle cx="200" cy="2" r="2.2" fill="#2dd4bf" opacity="0.9"/>
                  </svg>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* ═══ 2. METRICS ════════════════════════════════════════════════════ */}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', gap: 16 }}>
          {metrics.map((m, idx) => (
            <div key={m.label} className="relative overflow-hidden rounded-[16px]"
              style={{ minHeight: 132, border: bdr, background: cardBg, padding: 20 }}>
              <div className="flex items-center justify-center rounded-[12px]"
                style={{ width: 32, height: 32, background: `${m.color}14`, border: `1px solid ${m.color}28` }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={m.color} strokeWidth="2.2">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
              </div>
              <p style={{ marginTop: 12, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#475569' }}>{m.label}</p>
              <p className="tabular-nums" style={{ marginTop: 2, fontSize: '2.6rem', fontWeight: 800, lineHeight: 1, color: '#f8fafc' }}>{m.val}</p>
              <p style={{ marginTop: 6, fontSize: 12, color: '#475569' }}>{m.sub}</p>
              <CardSpark color={m.color} seed={idx}/>
              <div className="absolute" style={{ bottom: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg,${m.color}55,transparent)` }}/>
            </div>
          ))}
        </div>

        {/* ═══ 3. CONTROLS + SYNC ════════════════════════════════════════════ */}
        <div className="rounded-[24px]" style={{ border: bdr, background: cardBg, padding: 20 }}>
          <div className="grid" style={{ gridTemplateColumns: '1.35fr 0.95fr', gap: 20 }}>

            {/* left: filters */}
            <div className="flex flex-col" style={{ gap: 16 }}>
              <div>
                <p style={{ marginBottom: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#475569' }}>Time Window</p>
                <div className="flex w-fit rounded-[12px]" style={{ gap: 4, background: 'rgba(255,255,255,0.025)', border: bdrInner, padding: 4 }}>
                  {WINDOWS.map(w => (
                    <button key={w} onClick={() => setWindowValue(w)}
                      className="rounded-[9px]"
                      style={windowValue === w
                        ? { padding: '6px 16px', fontSize: 12, fontWeight: 600, background: 'rgba(45,212,191,0.14)', border: '1px solid rgba(45,212,191,0.42)', color: '#2dd4bf', boxShadow: '0 0 14px rgba(45,212,191,0.12)' }
                        : { padding: '6px 16px', fontSize: 12, fontWeight: 600, background: 'transparent', border: '1px solid transparent', color: '#475569' }}>
                      {w}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p style={{ marginBottom: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#475569' }}>Value Range</p>
                <div className="flex flex-wrap" style={{ gap: 8 }}>
                  {RANGE_OPTIONS.map(opt => (
                    <button key={opt.value} onClick={() => setValueRange(opt.value)}
                      className="rounded-full"
                      style={valueRange === opt.value
                        ? { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: 'rgba(45,212,191,0.14)', border: '1px solid rgba(45,212,191,0.42)', color: '#2dd4bf' }
                        : { padding: '6px 14px', fontSize: 12, fontWeight: 600, background: 'rgba(255,255,255,0.03)', border: bdrInner, color: '#475569' }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
                {valueRange !== 'all' && (
                  <p style={{ marginTop: 6, fontSize: 11, color: '#475569' }}>Showing alerts inside selected value range.</p>
                )}
              </div>

              <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
                {[
                  { label: 'Alert Type', val: typeFilter, set: setTypeFilter, opts: types },
                  { label: 'Severity',   val: sevFilter,  set: setSevFilter,  opts: sevs  },
                  { label: 'Side',       val: sideFilter, set: setSideFilter, opts: sides },
                ].map(({ label, val, set, opts }) => (
                  <div key={label} className="flex flex-col" style={{ gap: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.16em', color: '#475569' }}>{label}</span>
                    <div className="relative">
                      <select value={val} onChange={e => set(e.target.value)}
                        className="wa-select w-full appearance-none rounded-[12px]"
                        style={{ background: innerBg, border: bdr, color: '#94a3b8', padding: '10px 12px', fontSize: 14, outline: 'none' }}>
                        {opts.map(o => <option key={o} value={o}>{o === 'all' ? `All ${label}s` : o}</option>)}
                      </select>
                      <span className="pointer-events-none absolute" style={{ right: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569' }}>
                        <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M0 0l4.5 5L9 0z"/></svg>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* right: wallet sync panel */}
            <div className="flex flex-col rounded-[18px]"
              style={{ gap: 14, border: '1px solid rgba(139,92,246,0.24)', background: 'linear-gradient(160deg,rgba(13,18,33,0.98),rgba(9,15,30,0.94) 60%,rgba(8,12,24,0.98))', padding: 18, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 40px rgba(0,0,0,0.38)' }}>

              <div className="flex items-center justify-between">
                <div className="flex items-center" style={{ gap: 10 }}>
                  <div className="flex items-center justify-center rounded-[12px]"
                    style={{ width: 34, height: 34, background: 'rgba(139,92,246,0.16)', border: '1px solid rgba(139,92,246,0.30)' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </div>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.01em', color: '#f8fafc', margin: 0 }}>Whale sync</p>
                    <p style={{ fontSize: 11, color: '#64748b', margin: 0 }}>Refreshes latest tracked-wallet activity</p>
                  </div>
                </div>
                <Pill color={syncing || isFullInProgress ? 'amber' : 'teal'} dot>{syncStatusText}</Pill>
              </div>

              <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="rounded-[14px]" style={{ padding: 13, background: 'rgba(7,13,25,0.72)', border: '1px solid rgba(148,163,184,0.16)' }}>
                  <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#64748b', margin: 0 }}>Tracked set</p>
                  <p className="tabular-nums" style={{ fontSize: 24, fontWeight: 800, color: '#f8fafc', margin: '8px 0 0' }}>{trackedCount > 0 ? trackedCount : stats.trackedWallets > 0 ? stats.trackedWallets : '60+'} wallets</p>
                </div>
                <div className="rounded-[14px]" style={{ padding: 13, background: 'rgba(7,13,25,0.72)', border: '1px solid rgba(148,163,184,0.16)' }}>
                  <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#64748b', margin: 0 }}>Signals found</p>
                  <p className="tabular-nums" style={{ fontSize: 24, fontWeight: 800, color: '#f8fafc', margin: '8px 0 0' }}>
                    {effectiveInserted != null ? effectiveInserted : <span style={{ color: '#334155' }}>—</span>}
                  </p>
                </div>
              </div>

              {covPct !== null ? (
                <div className="rounded-[12px]" style={{ padding: 10, background: 'rgba(5,10,20,0.55)', border: '1px solid rgba(148,163,184,0.12)' }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b' }}>Coverage</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1' }}>{covPct}%</span>
                  </div>
                  <div className="w-full overflow-hidden rounded-full" style={{ height: 5, background: 'rgba(255,255,255,0.08)' }}>
                    <div className="rounded-full" style={{ width: `${covPct}%`, height: '100%', background: 'linear-gradient(90deg,#2dd4bf,#8b5cf6)', transition: 'width 0.3s ease' }}/>
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: 11, color: '#475569' }}>Run a sync to see coverage progress.</p>
              )}
              {syncState && (
                <p style={{ margin: 0, fontSize: 11, color: '#94a3b8' }}>
                  {syncing && syncState.mode === 'full'
                    ? `Scanning ${scannedCount} / ${trackedCount || stats.trackedWallets} wallets…`
                    : isFullInProgress
                      ? `Full refresh progress: ${scannedCount} / ${trackedCount || stats.trackedWallets}`
                      : `Last refresh checked ${scannedCount} / ${trackedCount || stats.trackedWallets} tracked wallets`}
                </p>
              )}

              {(syncState?.providerErrors ?? 0) > 0 && (
                <p className="rounded-[12px]"
                  style={{ padding: '8px 12px', fontSize: 11, background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.18)', color: '#fcd34d' }}>
                  {syncState?.providerErrors} source delay{(syncState?.providerErrors ?? 0) > 1 ? 's' : ''} — some alerts may be delayed.
                </p>
              )}

              <div className="flex" style={{ gap: 8 }}>
                <button onClick={() => { void runSync(syncState?.hasMore ? (syncState?.nextOffset ?? 0) : undefined, 'batch') }} disabled={syncing || (syncCooldownLeftMs > 0 && !syncState?.hasMore)}
                  className="flex flex-1 items-center justify-center rounded-[12px]"
                  style={{ gap: 8, padding: '10px 0', fontSize: 14, fontWeight: 700, background: 'linear-gradient(135deg,#1aa99c,#8b5cf6)', color: '#fff', boxShadow: '0 0 22px rgba(45,212,191,0.14)', opacity: syncing || (syncCooldownLeftMs > 0 && !syncState?.hasMore) ? 0.5 : 1, border: 'none' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                  {syncing ? 'Checking wallets…' : syncState?.hasMore ? 'Continue refresh' : syncCooldownLeftMs > 0 ? 'Refresh available shortly' : 'Refresh now'}
                </button>
                <button onClick={() => { void runSync(syncState?.mode === 'full' && isFullInProgress ? computedFullNextOffset : 0, 'full') }} disabled={syncing || (fullSyncCooldownLeftMs > 0 && !isFullInProgress)}
                  className="flex items-center rounded-[12px]"
                  style={{ gap: 6, padding: '10px 12px', fontSize: 12, fontWeight: 600, background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.30)', color: '#fcd34d', opacity: syncing ? 0.5 : 1 }}>
                  {syncState?.mode === 'full' && isFullInProgress
                    ? (fullSyncCooldownLeftMs > 0 ? 'Continue shortly' : 'Continue refresh')
                    : (syncState?.mode === 'full' && syncState?.done === true && !syncState?.hasMore ? 'Full refresh complete' : 'Full refresh')}
                </button>
                <button onClick={resetFilters} disabled={syncing}
                  className="flex items-center rounded-[12px]"
                  style={{ gap: 6, padding: '10px 16px', fontSize: 14, fontWeight: 500, background: 'rgba(255,255,255,0.05)', border: bdr, color: '#64748b', opacity: syncing ? 0.4 : 1 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                  Reset
                </button>
                <button onClick={clearSyncState} disabled={syncing}
                  className="flex items-center rounded-[12px]"
                  style={{ gap: 6, padding: '10px 12px', fontSize: 12, fontWeight: 600, background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.28)', color: '#cbd5e1', opacity: syncing ? 0.4 : 1 }}>
                  Clear sync state
                </button>
              </div>

              <button className="text-left hover:opacity-80"
                style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#475569', background: 'none', border: 'none' }}>
                + Advanced Diagnostics
              </button>
              <p style={{ margin: 0, fontSize: 11, color: '#fbbf24' }}>
                Full sync refreshes the complete tracked-wallet set.
              </p>
              {syncState?.mode === 'full' && syncState?.hasMore && (
                <p style={{ margin: 0, fontSize: 11, color: '#94a3b8' }}>
                  Full refresh in progress.
                </p>
              )}
              {syncState?.mode === 'full' && syncState?.done === true && !syncState?.hasMore && (
                <p style={{ margin: 0, fontSize: 11, color: '#86efac' }}>
                  Full refresh complete — {scannedCount} / {trackedCount} checked
                </p>
              )}
            </div>

          </div>
        </div>

        {/* ═══ 4. ALERT FEED ══════════════════════════════════════════════════ */}
        <div className="overflow-hidden rounded-[24px]" style={{ border: bdr, background: cardBg }}>

          {/* feed header */}
          <div className="flex flex-wrap items-center justify-between"
            style={{ gap: 12, padding: '16px 20px', borderBottom: bdrInner, background: 'rgba(255,255,255,0.012)' }}>
            <div className="flex items-center" style={{ gap: 12 }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: '#f8fafc', margin: 0 }}>Alert feed</h2>
              <Pill color="green" dot>Auto-update</Pill>
              {alerts.length > 0 && (
                <span style={{ fontSize: 12, color: '#475569' }}>
                  {alerts.length} shown{(feedDiagnostics?.afterDiversityCap ?? 0) > alerts.length ? ` of ${feedDiagnostics?.afterDiversityCap} matching` : ' matching'}
                </span>
              )}
            </div>
            <div className="flex items-center" style={{ gap: 8 }}>
              <button className="flex items-center justify-center rounded-[8px]"
                style={{ width: 28, height: 28, background: 'rgba(255,255,255,0.04)', border: bdrInner, color: '#475569' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
              </button>
              <button className="flex items-center rounded-[8px]"
                style={{ gap: 6, padding: '6px 12px', fontSize: 11, fontWeight: 500, color: '#64748b', background: 'rgba(255,255,255,0.04)', border: bdrInner }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>
                Pause
              </button>
              <button onClick={goClark}
                className="flex items-center rounded-[8px] hover:opacity-90"
                style={{ gap: 6, padding: '6px 12px', fontSize: 11, fontWeight: 600, background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.28)', color: '#c4b5fd' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Ask Clark
              </button>
            </div>
          </div>

          {/* skeleton */}
          {loading && Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center"
              style={{ gap: 16, padding: '16px 20px', borderBottom: bdrInner, borderLeft: '3px solid rgba(255,255,255,0.04)', opacity: 0.6 }}>
              <div className="shrink-0 rounded-[12px]" style={{ width: 36, height: 36, background: 'rgba(255,255,255,0.05)' }}/>
              <div className="flex-1 flex flex-col" style={{ gap: 8 }}>
                <div className="rounded-full" style={{ height: 12, width: '60%', background: 'rgba(255,255,255,0.05)' }}/>
                <div className="rounded-full" style={{ height: 10, width: '40%', background: 'rgba(255,255,255,0.04)' }}/>
              </div>
              <div className="rounded-full" style={{ height: 20, width: 56, background: 'rgba(255,255,255,0.05)' }}/>
            </div>
          ))}

          {/* error */}
          {feedError && !loading && (
            <div style={{ padding: '48px 20px', textAlign: 'center' }}>
              <div className="mx-auto flex items-center justify-center rounded-[16px]"
                style={{ width: 48, height: 48, marginBottom: 16, background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.18)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#fda4af' }}>No fresh signal in the checked window</p>
              <p style={{ marginTop: 4, fontSize: 12, color: '#475569' }}>The request failed. Sync may still be active.</p>
              <button onClick={() => void loadAlerts()}
                className="rounded-[12px] hover:opacity-80"
                style={{ marginTop: 16, padding: '8px 20px', fontSize: 12, fontWeight: 600, color: '#f8fafc', background: 'rgba(255,255,255,0.06)', border: bdr }}>
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
            const insertedSoFar = syncState?.inserted ?? 0
            const rangeActive = valueRange !== 'all'
            const filtersActive = rangeActive || typeFilter !== 'all' || sevFilter !== 'all' || sideFilter !== 'all'
            const hiddenByFilters = insertedSoFar > 0 && filtersActive
            const rangeLabel = RANGE_OPTIONS.find(o => o.value === valueRange)?.label ?? valueRange
            const title = hiddenByFilters
              ? 'Alerts found — hidden by filters'
              : rangeActive
                ? 'No alerts match this range in the selected window.'
                : partial
                  ? 'Batch scan in progress'
                  : allDone
                    ? 'No qualifying whale alerts found'
                    : 'No whale alerts yet'
            const body = hiddenByFilters
              ? `${insertedSoFar} alert${insertedSoFar !== 1 ? 's' : ''} found in this batch, but hidden by the current filter settings. Try "All" value range or reset filters.`
              : rangeActive
                ? `No alerts in the ${windowValue} window have a verified USD value in the ${rangeLabel} range. Try "All" or a different range.`
                : partial
                  ? `Checked ${scanned} of ${total} wallets. No fresh signal in the checked window yet. Use Continue refresh to scan more wallets.`
                  : allDone
                    ? 'No qualifying recent whale activity found in this batch.'
                    : 'ChainLens is watching selected Base wallets. Run a sync to index recent movements.'
            return (
              <div style={{ padding: '64px 20px', textAlign: 'center' }}>
                <div className="mx-auto flex items-center justify-center rounded-[16px]"
                  style={{ width: 56, height: 56, marginBottom: 20, background: 'rgba(45,212,191,0.07)', border: '1px solid rgba(45,212,191,0.15)', boxShadow: '0 0 28px rgba(45,212,191,0.07)' }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                </div>
                <p style={{ fontSize: 15, fontWeight: 700, color: '#f8fafc' }}>{title}</p>
                <p className="mx-auto" style={{ marginTop: 8, maxWidth: 400, fontSize: 14, lineHeight: 1.6, color: '#64748b' }}>
                  {body}
                </p>
                {hasProviderErrors && (
                  <p className="mx-auto rounded-[10px]"
                    style={{ marginTop: 12, maxWidth: 400, padding: '8px 14px', fontSize: 12, background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.18)', color: '#fcd34d' }}>
                    {syncState!.providerErrors} source delay{(syncState!.providerErrors ?? 0) > 1 ? 's' : ''} — some wallets may be delayed.
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-center" style={{ gap: 8, marginTop: 20 }}>
                  <Pill color="slate">{stats.trackedWallets ? `${stats.trackedWallets} tracked wallets` : 'Wallet count pending in current checks'}</Pill>
                  {syncState
                    ? <Pill color="teal">{scanned} of {total || stats.trackedWallets} scanned</Pill>
                    : <Pill color="teal">No sync yet</Pill>}
                  {syncState && <Pill color="purple">Found {syncState.inserted ?? 0} qualifying alerts</Pill>}
                  {syncState && <Pill color="amber">{syncState.skipped ?? 0} skipped (stable/routing/duplicate/no recent movement)</Pill>}
                  <Pill color={hasProviderErrors ? 'amber' : 'purple'}>
                    {hasProviderErrors ? 'Provider degraded' : 'Provider healthy'}
                  </Pill>
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

            // Amount: prefer USD; fall back to token number (no symbol — tok appended in render)
            const amtU    = fmtUsd(alert.amount_usd)
            const amtTNum = isMultiTok ? null : fmtAmtNum(alert.amount_token)
            const amtShow = amtU !== '—' ? amtU : amtTNum

            // Verb and preposition split so amount fits between them for swaps
            const isSwap   = isMultiTok || (focusTok != null && s !== 'buy')
            const baseVerb = isSwap ? 'swapped' : s === 'buy' ? 'bought' : s === 'sell' ? 'sold' : 'moved'

            const logoUrl = alert.token_image_url ?? alert.logo_url ?? alert.image ?? alert.token_logo ?? null

            const walletName = alert.wallet_label || 'Tracked Wallet'
            const signal     = alert.signal_score ?? 'LOW'

            // Per-row Clark prompt — structured fields, no raw wallet address
            const rowPrompt = [
              `Explain this whale alert. Signal: ${signal}.`,
              `Label: ${walletName}`,
              `Token: ${tok}`,
              `Side: ${alert.side ?? 'unknown'}`,
              alert.amount_token != null
                ? `Amount (token): ${alert.amount_token} ${alert.token_symbol ?? ''}`.trim()
                : null,
              alert.amount_usd != null
                ? `Amount (USD): $${alert.amount_usd.toFixed(2)}`
                : 'Amount (USD): unverified',
              `Legs: ${alert.legs ?? 1}`,
              (alert.repeats ?? 1) > 1 ? `Repeats: ${alert.repeats} times in 5 min` : null,
              alert.summary ? `Summary: ${alert.summary}` : null,
              alert.tx_hash ? `TX: ${alert.tx_hash}` : null,
              `Time: ${alert.occurred_at ?? 'unknown'}`,
              'What does this whale alert mean, how strong is it, and what should I watch next? Do not invent data.',
            ].filter(Boolean).join('\n')
            const goRowClark = () => { window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(rowPrompt)}&autosend=1` }

            const scanHref = alert.tx_hash ? `https://basescan.org/tx/${alert.tx_hash}` : null

            return (
              <div key={alert.id ?? `${alert.tx_hash ?? ''}-${i}`}
                className="transition-opacity hover:opacity-90"
                style={{ borderBottom: bdrInner, borderLeft: `3px solid ${sideStyle.line}` }}>
                <div className="flex items-start" style={{ gap: 12, padding: '14px 20px' }}>

                  <TokenAvatar tok={tok} logoUrl={logoUrl} avatarBg={sideStyle.avatarBg} line={sideStyle.line} />

                  {/* Content */}
                  <div className="flex-1" style={{ minWidth: 0 }}>

                    {/* Primary line */}
                    <div className="flex flex-wrap items-center" style={{ gap: '0 6px' }}>
                      <span className="rounded-[4px]"
                        style={{ padding: '2px 8px', fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', background: sideStyle.chipBg, border: `1px solid ${sideStyle.chipBd}`, color: sideStyle.chipTx }}>
                        {chipLabel}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#f8fafc' }}>
                        {walletName}{' '}
                        <span style={{ color: '#64748b' }}>{baseVerb}</span>
                        {amtShow
                          ? <>{' '}<span style={{ fontWeight: 700, color: '#5eead4' }}>{amtShow}</span>{isSwap ? <span style={{ color: '#64748b' }}>{' '}into</span> : null}</>
                          : isSwap ? <span style={{ color: '#64748b' }}>{' '}into</span> : null}
                        {' '}<span style={{ fontWeight: 700, color: '#f8fafc' }}>{tok}</span>
                      </span>
                    </div>

                    {/* Subline: plain-text metadata */}
                    <p style={{ marginTop: 5, fontSize: 11, color: '#475569' }}>
                      Tracked wallet · Base
                      {(alert.legs ?? 1) > 1 ? ` · ${alert.legs} legs` : ''}
                      {(alert.repeats ?? 1) > 1 ? ` · ×${alert.repeats} in 5m` : ''}
                      {' · '}{timeAgo(alert.occurred_at)}
                    </p>
                  </div>

                  {/* Right column */}
                  <div className="shrink-0 flex flex-col items-end" style={{ marginTop: 2, gap: 6 }}>
                    <span className="rounded-full"
                      style={{ padding: '2px 10px', fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', ...signalStyle(signal) }}>
                      {signal === 'HIGH' ? 'HIGH SIGNAL' : signal}
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
            <div className="flex items-center justify-between" style={{ padding: '12px 20px', borderTop: bdrInner }}>
              <span style={{ fontFamily: 'var(--font-plex-mono,monospace)', fontSize: 10, color: '#334155' }}>stream · base.alerts.v2</span>
              <div className="flex items-center" style={{ gap: 16, fontSize: 11 }}>
                {[{ c: '#2dd4bf', l: 'BUY' }, { c: '#f43f5e', l: 'SELL' }, { c: '#8b5cf6', l: 'TRANSFER' }].map(({ c, l }) => (
                  <span key={l} className="flex items-center" style={{ gap: 6 }}>
                    <span className="inline-block rounded-full" style={{ width: 6, height: 6, background: c }}/>
                    <span style={{ color: '#475569' }}>{l}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

        </div>

      </div>
    </div>
  )
}
            <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12, color: '#94a3b8' }}>
              Whale Alerts refreshes on demand during beta to reduce infrastructure waste.
            </p>
