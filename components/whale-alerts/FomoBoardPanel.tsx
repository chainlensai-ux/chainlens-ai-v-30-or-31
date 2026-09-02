'use client'

// FOMO board — a second, separate section on the Whale Alerts page (behind the "FOMO board" tab
// next to "Activity"). This is a SCOREBOARD: ranked FOMO social traders, used only to discover
// wallets worth adding to ChainLens's own Base whale tracker. It intentionally never touches the
// existing Activity feed's state — no leaderboard row is ever merged into an alert, and adding a
// wallet here only makes it eligible for the existing Sync pipeline to pick up on its own schedule.

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { usePlanWithLoading, canAccessFomoBoard } from '@/lib/usePlan'

type FomoWindow = '24h' | '7d' | '30d' | 'all'

type FomoTraderRow = {
  rank: number
  handle: string
  displayName: string | null
  pnlUsd: number | null
  volumeUsd: number | null
  trades: number | null
  followers: number | null
  holdingsCount: number | null
  solanaWallet: string | null
  evmWallet: string | null
  walletStatus: 'resolved' | 'sol_only' | 'pending' | 'unresolved'
  verified: boolean
  topTokens: string[]
  canAddToBaseTracker: boolean
}

type FomoLeaderboardAudit = {
  window: FomoWindow
  limit: number
  cacheHit: boolean
  cacheAgeMs: number | null
  apiCalled: boolean
  status: number | null
  rateLimit: number | null
  rateRemaining: number | null
  tradersReturned: number
  evmResolvedCount: number
  solOnlyCount: number
  walletPendingCount: number
  durationMs: number
  errorReason: string | null
}

type AddState = 'idle' | 'adding' | 'added' | 'duplicate' | 'error'
type AddErrorInfo = { reason: string; message: string }

const cardBg = 'rgba(9,14,24,0.90)'
const innerBg = 'rgba(5,9,17,0.80)'
const bdr = '1px solid rgba(148,163,184,0.12)'
const bdrInner = '1px solid rgba(148,163,184,0.07)'

const WINDOWS: { value: FomoWindow; label: string }[] = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: 'all', label: 'ALL' },
]

function fmtUsd(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function fmtNum(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(Math.round(v))
}

function fmtAddr(addr: string): string {
  return addr.length >= 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function fmtAgo(ms: number | null): string {
  if (ms == null) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return `${m}m ago`
}

export function FomoBoardLockedCard() {
  return (
    <div
      data-testid="fomo-board-locked"
      style={{
        background: cardBg,
        border: bdr,
        borderRadius: 14,
        padding: '22px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: '#f1f5f9' }}>FOMO Board</p>
        <span style={pillStyle('#facc15', 'rgba(250,204,21,0.12)', 'rgba(250,204,21,0.40)')}>Elite only</span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: '#cbd5e1', lineHeight: 1.55 }}>
        Track high-velocity whale and momentum activity from one premium board.
      </p>
      <p style={{ margin: 0, fontSize: 12, color: '#94a3b8', lineHeight: 1.55 }}>
        FOMO Board is an Elite-only feed for high-velocity whale and momentum activity.
      </p>
      <a
        href="/pricing"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          alignSelf: 'flex-start',
          width: '100%',
          maxWidth: 320,
          minHeight: 44,
          padding: '10px 16px',
          borderRadius: 10,
          background: 'linear-gradient(135deg,#d4a017,#facc15)',
          color: '#1c1917',
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: '0.02em',
          textDecoration: 'none',
          boxSizing: 'border-box',
        }}
      >
        Upgrade to Elite
      </a>
    </div>
  )
}

export default function FomoBoardPanel() {
  const { plan, loading: planLoading, betaEliteActive, elitePass } = usePlanWithLoading()
  const unlockedByPass = Boolean(elitePass?.active && elitePass.unlocks.includes('whale-alerts'))
  const hasAccess = canAccessFomoBoard(plan) || betaEliteActive || unlockedByPass
  const [window_, setWindow] = useState<FomoWindow>('24h')
  const [traders, setTraders] = useState<FomoTraderRow[]>([])
  const [audit, setAudit] = useState<FomoLeaderboardAudit | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [trackedAddresses, setTrackedAddresses] = useState<Set<string>>(new Set())
  const [trackedCount, setTrackedCount] = useState<number | null>(null)
  const [addStates, setAddStates] = useState<Record<string, AddState>>({})
  const [addErrors, setAddErrors] = useState<Record<string, AddErrorInfo>>({})
  const [toast, setToast] = useState<string | null>(null)
  // fomoApiUsageAudit's requestCountThisPageLoad, DISCLOSED (live report: "one leaderboard load
  // appears to cost multiple credits/requests"). Counts only requests the server actually reports
  // as apiCalled:true (a real external FOMO API call) — a cache hit against our own route never
  // increments this, so "100 traders shown" never silently implies "100 API calls" or even
  // "N tab-switches = N API calls". Kept in a ref (not state) since it's audit-only, never rendered
  // reactively, and must survive re-renders without triggering its own render.
  const requestCountThisPageLoad = useRef(0)

  const loadTrackedAddresses = useCallback(async () => {
    if (!hasAccess) return
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch('/api/whale-alerts/tracked-wallets', {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const json = await res.json().catch(() => null)
      if (res.ok && Array.isArray(json?.addresses)) {
        setTrackedAddresses(new Set((json.addresses as string[]).map((a) => a.toLowerCase())))
        setTrackedCount(typeof json.count === 'number' ? json.count : json.addresses.length)
      }
    } catch {
      // Best-effort — Add buttons just won't pre-show "Tracked" for already-tracked wallets.
    }
  }, [hasAccess])

  const loadLeaderboard = useCallback(async (w: FomoWindow, reason: 'initial_load' | 'window_change' | 'manual_refresh') => {
    if (!hasAccess) return
    setLoading(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch(`/api/fomo/leaderboard?window=${w}&limit=100`, {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const json = await res.json().catch(() => null)
      const a = json?.fomoLeaderboardAudit as FomoLeaderboardAudit | undefined
      if (a?.apiCalled) requestCountThisPageLoad.current += 1
      if (process.env.NODE_ENV === 'development' && a) {
        console.log('[fomo] fomoApiUsageAudit', { ...a, requestCountThisPageLoad: requestCountThisPageLoad.current, reasonForFetch: reason })
      }
      if (!res.ok || !json?.ok) {
        setTraders([])
        setAudit(a ?? null)
        setError(json?.error ?? 'Could not load the FOMO board.')
        return
      }
      setTraders(Array.isArray(json.traders) ? json.traders : [])
      setAudit(a ?? null)
    } catch {
      setTraders([])
      setError('Could not load the FOMO board.')
    } finally {
      setLoading(false)
    }
  }, [hasAccess])

  const isFirstLoadRef = useRef(true)
  useEffect(() => {
    if (!hasAccess || planLoading) return
    queueMicrotask(() => { void loadTrackedAddresses() })
  }, [hasAccess, planLoading, loadTrackedAddresses])

  useEffect(() => {
    if (!hasAccess || planLoading) return
    const reason = isFirstLoadRef.current ? 'initial_load' : 'window_change'
    isFirstLoadRef.current = false
    queueMicrotask(() => { void loadLeaderboard(window_, reason) })
    // Only window_ should ever re-trigger a fetch — loadLeaderboard is a stable useCallback with no
    // deps, so this effect fires exactly once per real window change, never on remount alone once
    // the panel is kept mounted across tab switches (see the parent page's fomoBoardMounted).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, planLoading, window_])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(t)
  }, [toast])

  async function handleAdd(row: FomoTraderRow) {
    if (!hasAccess) return
    if (!row.evmWallet) return
    const addr = row.evmWallet
    setAddStates((prev) => ({ ...prev, [addr]: 'adding' }))
    setAddErrors((prev) => { const next = { ...prev }; delete next[addr]; return next })
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const countBefore = trackedCount
      const res = await fetch('/api/whale-alerts/tracked-wallets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        // FOMO-ADD METADATA, DISCLOSED: row.evmWallet only — never row.handle — is sent as the
        // address (hard rule: never add a FOMO handle as a wallet, never add a Solana wallet here).
        // The rest is provenance so a tracked wallet is traceable back to the exact FOMO board rank/
        // window it was discovered from.
        body: JSON.stringify({
          address: addr,
          chainSlug: 'base',
          source: 'fomo',
          fomoHandle: row.handle,
          fomoRank: row.rank,
          fomoWindow: window_,
          label: row.displayName || row.handle,
          tags: ['fomo', 'social_trader'],
        }),
      })
      const json = await res.json().catch(() => null)
      if (process.env.NODE_ENV === 'development') {
        console.log('[fomo] fomoAddTrackerAudit', json?.fomoAddTrackerAudit)
      }
      if (!res.ok || !json?.ok) {
        const reason = json?.fomoAddTrackerAudit?.errorReason ?? (res.status === 403 ? 'plan_blocked' : 'add_failed')
        const message =
          reason === 'plan_blocked' ? 'Whale Alerts tracking requires Pro or Elite.'
          : reason === 'rls_blocked_on_write' || reason === 'rls_blocked_on_lookup' ? 'Permission denied writing to the tracker.'
          : reason === 'invalid_evm_address' ? 'That wallet is not a valid Base (EVM) address.'
          : (typeof json?.error === 'string' && json.error) || 'Could not add this wallet. Try again.'
        setAddStates((prev) => ({ ...prev, [addr]: 'error' }))
        setAddErrors((prev) => ({ ...prev, [addr]: { reason, message } }))
        return
      }
      const alreadyTracked = json.status === 'duplicate' || json.alreadyTracked === true
      setAddStates((prev) => ({ ...prev, [addr]: alreadyTracked ? 'duplicate' : 'added' }))
      setTrackedAddresses((prev) => new Set(prev).add(addr))
      const countAfter = json?.fomoAddTrackerAudit?.trackedWalletCountAfter
      setTrackedCount(typeof countAfter === 'number' ? countAfter : (countBefore != null ? countBefore + (alreadyTracked ? 0 : 1) : null))
      if (!alreadyTracked) {
        setToast(`Added ${fmtAddr(addr)} to Base Whale Alerts tracker.`)
      }
    } catch {
      setAddStates((prev) => ({ ...prev, [addr]: 'error' }))
      setAddErrors((prev) => ({ ...prev, [addr]: { reason: 'network_error', message: 'Network error — check your connection and retry.' } }))
    }
  }

  function renderAddButton(row: FomoTraderRow) {
    const addr = row.evmWallet
    const state = addr ? (addStates[addr] ?? 'idle') : 'idle'
    const alreadyTracked = addr != null && (trackedAddresses.has(addr) || state === 'duplicate' || state === 'added')

    if (row.walletStatus === 'sol_only') {
      return <span title="This trader only has a Solana wallet on file — Base Whale Alerts tracks EVM wallets only." style={pillStyle('#94a3b8', 'rgba(148,163,184,0.10)', 'rgba(148,163,184,0.28)')}>SOL only</span>
    }
    if (!addr) {
      return <span title="FOMO hasn't resolved an EVM wallet for this trader yet." style={pillStyle('#94a3b8', 'rgba(148,163,184,0.10)', 'rgba(148,163,184,0.28)')}>Wallet pending</span>
    }
    if (alreadyTracked) {
      return <span title="Already in the Base Whale Alerts tracker — Sync wallets will watch it." style={pillStyle('#5eead4', 'rgba(45,212,191,0.10)', 'rgba(45,212,191,0.30)')}>Tracked</span>
    }
    if (state === 'error') {
      const info = addErrors[addr]
      return (
        <button type="button" onClick={() => void handleAdd(row)} title={info?.message ?? 'Add failed — click to retry.'} style={{ ...addBtnStyle, borderColor: 'rgba(244,63,94,0.45)', color: '#fda4af' }}>
          Retry
        </button>
      )
    }
    return (
      <button type="button" onClick={() => void handleAdd(row)} disabled={state === 'adding'} title="Store this trader's EVM wallet in the Base Whale Alerts tracker." style={addBtnStyle}>
        {state === 'adding' ? 'Adding…' : '+ Add'}
      </button>
    )
  }

  if (planLoading) {
    return (
      <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <div className="cl-skeleton" style={{ height: 22, width: 'min(220px, 55%)', borderRadius: 8 }} />
        <div className="cl-skeleton" style={{ height: 160, borderRadius: 14 }} />
      </div>
    )
  }

  if (!hasAccess) return <FomoBoardLockedCard />

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, maxWidth: '100%' }}>
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 50, padding: '10px 16px', borderRadius: 10, background: 'rgba(15,23,32,0.96)', border: '1px solid rgba(45,212,191,0.35)', color: '#5eead4', fontSize: 12, fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
          {toast}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: '#f1f5f9' }}>FOMO Board</p>
            {trackedCount != null && (
              <span style={pillStyle('#7c8ba1', 'rgba(148,163,184,0.08)', 'rgba(148,163,184,0.22)')}>{trackedCount} tracked</span>
            )}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 11.5, color: '#7c8ba1', lineHeight: 1.5 }} title="FOMO board discovers traders. Add stores the trader's EVM wallet into ChainLens Whale Alerts so Sync wallets can monitor Base swaps.">
            FOMO board discovers traders. Add stores the trader&rsquo;s EVM wallet into ChainLens Whale Alerts so Sync wallets can monitor Base swaps.
          </p>
        </div>
        <div role="tablist" aria-label="FOMO board window" style={{ display: 'flex', gap: 4, background: innerBg, border: bdrInner, borderRadius: 9, padding: 3 }}>
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              role="tab"
              aria-selected={window_ === w.value}
              onClick={() => setWindow(w.value)}
              style={{
                padding: '6px 12px',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.06em',
                borderRadius: 7,
                border: 'none',
                cursor: 'pointer',
                background: window_ === w.value ? 'rgba(45,212,191,0.16)' : 'transparent',
                color: window_ === w.value ? '#5eead4' : '#7c8ba1',
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {audit && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10.5, color: '#55647d', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          <span>{audit.tradersReturned} traders</span>
          <span>·</span>
          <span>{audit.cacheHit ? `cached ${fmtAgo(audit.cacheAgeMs)}` : 'fresh fetch'}</span>
          {audit.rateRemaining != null && audit.rateLimit != null && (
            <>
              <span>·</span>
              <span>API rate remaining: {audit.rateRemaining}/{audit.rateLimit}</span>
            </>
          )}
          {audit.errorReason && (
            <>
              <span>·</span>
              <span style={{ color: '#fbbf24' }}>showing cached data ({audit.errorReason.replace(/_/g, ' ')})</span>
            </>
          )}
        </div>
      )}

      <div style={{ background: cardBg, border: bdr, borderRadius: 12, overflow: 'hidden' }}>
        {loading && traders.length === 0 && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: '#7c8ba1', fontSize: 12.5 }}>
            Loading FOMO board…
          </div>
        )}

        {!loading && error && traders.length === 0 && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: '#fda4af', fontSize: 12.5 }}>
            {error}
          </div>
        )}

        {!loading && !error && traders.length === 0 && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: '#7c8ba1', fontSize: 12.5 }}>
            No FOMO traders returned for this window.
          </div>
        )}

        {traders.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: bdrInner }}>
                  {['Rank', 'Handle', `${WINDOWS.find((w) => w.value === window_)?.label ?? '24H'} PnL`, 'Volume', 'Trades', 'Followers', 'SOL wallet', 'EVM wallet', 'Add'].map((h) => (
                    <th key={h} style={{ textAlign: h === 'Handle' ? 'left' : 'right', padding: '10px 12px', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#55647d', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {traders.map((row) => (
                  <tr key={`${row.rank}-${row.handle}`} style={{ borderBottom: bdrInner }}>
                    <td style={{ padding: '10px 12px', color: '#7c8ba1', textAlign: 'right' }}>#{row.rank}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: '#f1f5f9', fontWeight: 700 }}>{row.displayName ?? row.handle}</span>
                        <span style={{ color: '#55647d', fontSize: 11 }}>@{row.handle}</span>
                        {row.verified && (
                          <span style={pillStyle('#67e8f9', 'rgba(34,211,238,0.10)', 'rgba(34,211,238,0.28)')}>Verified</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: (row.pnlUsd ?? 0) >= 0 ? '#5eead4' : '#fda4af', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      {fmtUsd(row.pnlUsd)}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{fmtUsd(row.volumeUsd)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#cbd5e1' }}>{fmtNum(row.trades)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#cbd5e1' }}>{fmtNum(row.followers)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: row.solanaWallet ? '#cbd5e1' : '#3f4a5c', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      {row.solanaWallet ? fmtAddr(row.solanaWallet) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: row.evmWallet ? '#cbd5e1' : '#3f4a5c', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                      {row.evmWallet ? fmtAddr(row.evmWallet) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>{renderAddButton(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 10, color: '#3f4a5c', lineHeight: 1.5 }}>
        Research only — not financial advice. FOMO board ranks social trading activity reported by the FOMO API; it is not a ChainLens on-chain verification of these wallets.
      </p>
    </div>
  )
}

function pillStyle(color: string, bg: string, border: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: '0.05em',
    color,
    background: bg,
    border: `1px solid ${border}`,
    whiteSpace: 'nowrap',
  }
}

const addBtnStyle: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: 7,
  border: '1px solid rgba(45,212,191,0.35)',
  background: 'rgba(45,212,191,0.09)',
  color: '#5eead4',
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.06em',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
