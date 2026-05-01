'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type AlertItem = {
  id?: string
  wallet_address?: string | null
  wallet_label?: string | null
  token_address?: string | null
  token_symbol?: string | null
  token_name?: string | null
  alert_type?: string | null
  side?: string | null
  amount_usd?: number | null
  amount_token?: number | null
  tx_hash?: string | null
  severity?: string | null
  occurred_at?: string | null
}
type AlertStats = { alerts15m: number; alerts1h: number; alerts24h: number; trackedWallets: number }
type SyncResponse = { processed?: number; inserted?: number; nextOffset?: number | null; providerErrors?: number; trackedWalletsTotal?: number; offset?: number }

const MIN_OPTIONS = [
  { label: 'All', value: 0 }, { label: '$100+', value: 100 }, { label: '$500+', value: 500 },
  { label: '$1k+', value: 1000 }, { label: '$5k+', value: 5000 }, { label: '$10k+', value: 10000 },
]
const WINDOWS = ['15m', '1h', '6h', '24h'] as const

const short = (v?: string | null) => !v ? '0x????…????' : `${v.slice(0, 6)}…${v.slice(-4)}`

const timeAgo = (iso?: string | null): string => {
  if (!iso) return '–'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
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

const getSide = (s: string | null | undefined) => {
  const k = (s ?? '').toLowerCase()
  if (k === 'buy')  return { line: '#2dd4bf', avatarBg: '#134e4a', chipBg: 'rgba(34,197,94,0.12)',  chipBd: 'rgba(34,197,94,0.30)',  chipTx: '#86efac', label: 'BUY'      }
  if (k === 'sell') return { line: '#f43f5e', avatarBg: '#4c0519', chipBg: 'rgba(244,63,94,0.12)',  chipBd: 'rgba(244,63,94,0.30)',  chipTx: '#fda4af', label: 'SELL'     }
  return               { line: '#8b5cf6', avatarBg: '#2e1065', chipBg: 'rgba(139,92,246,0.12)', chipBd: 'rgba(139,92,246,0.30)', chipTx: '#c4b5fd', label: 'TRANSFER' }
}

const sevLabel = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return 'HIGH'
  if (sev === 'medium') return 'MEDIUM'
  if (sev === 'low') return 'LOW'
  return sev?.toUpperCase() ?? null
}

const sevStyle = (sev: string | null | undefined): React.CSSProperties => {
  if (sev === 'major' || sev === 'large') return { background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.30)', color: '#fda4af' }
  if (sev === 'medium') return { background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.28)', color: '#fcd34d' }
  return { background: 'rgba(100,116,139,0.10)', border: '1px solid rgba(100,116,139,0.25)', color: '#94a3b8' }
}

const rowDesc = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return '• High value movement'
  if (sev === 'medium') return '• Fresh tracked-wallet move'
  if (sev === 'low') return '• Below whale threshold'
  return null
}

/* ── Shared UI atoms ── */

const C = '#0b1220'   // card bg
const CI = '#060c18'  // inner card bg
const B  = 'rgba(255,255,255,0.09)' // border
const BI = 'rgba(255,255,255,0.06)' // inner border

function StatusPill({ children, color='slate', dot }: { children: React.ReactNode; color?: 'slate'|'teal'|'purple'|'cyan'|'amber'|'green'; dot?: boolean }) {
  const p: Record<string, {bg:string;bd:string;tx:string;dt:string}> = {
    slate:  {bg:'rgba(148,163,184,0.08)',bd:'rgba(148,163,184,0.18)',tx:'#94a3b8',dt:'#64748b'},
    teal:   {bg:'rgba(45,212,191,0.09)', bd:'rgba(45,212,191,0.26)', tx:'#5eead4',dt:'#2dd4bf'},
    purple: {bg:'rgba(139,92,246,0.09)', bd:'rgba(139,92,246,0.26)', tx:'#c4b5fd',dt:'#8b5cf6'},
    cyan:   {bg:'rgba(34,211,238,0.09)', bd:'rgba(34,211,238,0.26)', tx:'#67e8f9',dt:'#22d3ee'},
    amber:  {bg:'rgba(251,191,36,0.09)', bd:'rgba(251,191,36,0.26)', tx:'#fcd34d',dt:'#f59e0b'},
    green:  {bg:'rgba(34,197,94,0.09)',  bd:'rgba(34,197,94,0.26)',  tx:'#86efac',dt:'#22c55e'},
  }
  const c = p[color]
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[11px] font-medium"
      style={{background:c.bg,border:`1px solid ${c.bd}`,color:c.tx}}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{background:c.dt}} />}
      {children}
    </span>
  )
}

function IconBox({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
      style={{background:`${color}18`,border:`1px solid ${color}30`}}>
      {children}
    </div>
  )
}

function WBtn({ active, onClick, ch }: { active: boolean; onClick: () => void; ch: string }) {
  return (
    <button onClick={onClick} className="rounded-xl px-4 py-1.5 text-xs font-semibold transition-all"
      style={active
        ? {background:'rgba(45,212,191,0.16)',border:'1px solid rgba(45,212,191,0.45)',color:'#2dd4bf',boxShadow:'0 0 10px rgba(45,212,191,0.15)'}
        : {background:'transparent',border:'1px solid transparent',color:'#475569'}}>
      {ch}
    </button>
  )
}

function VBtn({ active, onClick, ch }: { active: boolean; onClick: () => void; ch: string }) {
  return (
    <button onClick={onClick} className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
      style={active
        ? {background:'rgba(45,212,191,0.16)',border:'1px solid rgba(45,212,191,0.45)',color:'#2dd4bf'}
        : {background:'rgba(255,255,255,0.04)',border:`1px solid ${BI}`,color:'#64748b'}}>
      {ch}
    </button>
  )
}

function DkSel({ label, value, onChange, opts }: { label: string; value: string; onChange: (v: string) => void; opts: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-widest" style={{color:'#475569'}}>{label}</span>
      <div className="relative">
        <select value={value} onChange={e => onChange(e.target.value)}
          className="wa-select w-full cursor-pointer appearance-none rounded-xl px-3 py-2.5 text-sm outline-none"
          style={{background:CI, border:`1px solid ${B}`, color:'#e2e8f0'}}>
          {opts.map(o => <option key={o} value={o === 'all' ? 'all' : o}>{o === 'all' ? label.replace(' Type','').replace('Alert ','All ') : o}</option>)}
        </select>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" style={{color:'#475569'}}>
          <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M0 0l4.5 5L9 0z"/></svg>
        </span>
      </div>
    </div>
  )
}

/* Mini sparkline for metric cards */
function MiniSpark({ color }: { color: string }) {
  const pts = 'M0 26 L12 20 L24 14 L36 18 L48 10 L60 12 L72 6 L84 8 L96 4 L108 6 L120 2'
  return (
    <svg width="120" height="32" viewBox="0 0 120 32" fill="none" className="absolute bottom-3 right-3 opacity-40">
      <defs>
        <linearGradient id={`msp-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={pts+' L120 32 L0 32Z'} fill={`url(#msp-${color.replace('#','')})`}/>
      <path d={pts} stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none"/>
    </svg>
  )
}

/* ── Page ── */

export default function WhaleAlertsPage() {
  const [windowValue,    setWindowValue]    = useState<(typeof WINDOWS)[number]>('1h')
  const [minUsd,         setMinUsd]         = useState(100)
  const [typeFilter,     setTypeFilter]     = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [sideFilter,     setSideFilter]     = useState('all')

  const [alerts,    setAlerts]    = useState<AlertItem[]>([])
  const [stats,     setStats]     = useState<AlertStats>({alerts15m:0,alerts1h:0,alerts24h:0,trackedWallets:0})
  const [loading,   setLoading]   = useState(false)
  const [syncing,   setSyncing]   = useState(false)
  const [syncState, setSyncState] = useState<SyncResponse | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)

  const loadAlerts = useCallback(async () => {
    setLoading(true); setFeedError(null)
    try {
      const p = new URLSearchParams({window:windowValue,minUsd:String(minUsd),limit:'100'})
      if (typeFilter     !== 'all') p.set('type',     typeFilter)
      if (severityFilter !== 'all') p.set('severity', severityFilter)
      if (sideFilter     !== 'all') p.set('side',     sideFilter)
      const res  = await fetch(`/api/whale-alerts?${p}`, {cache:'no-store'})
      const json = await res.json()
      if (!res.ok) throw new Error('feed_unavailable')
      setAlerts(Array.isArray(json?.alerts) ? json.alerts : [])
      setStats(json?.stats ?? {alerts15m:0,alerts1h:0,alerts24h:0,trackedWallets:0})
    } catch { setFeedError('Feed request failed.') }
    finally  { setLoading(false) }
  }, [windowValue, minUsd, typeFilter, severityFilter, sideFilter])

  useEffect(() => { void loadAlerts() }, [loadAlerts])

  const runSync = async (offset: number) => {
    setSyncing(true)
    try {
      const res  = await fetch(`/api/whale-alerts/sync?window=7d&limit=5&offset=${offset}&minUsd=${minUsd}`,{method:'POST'})
      const json = (await res.json()) as SyncResponse
      setSyncState(json); await loadAlerts()
    } finally { setSyncing(false) }
  }

  const resetFilters = () => {
    setWindowValue('1h'); setMinUsd(100)
    setTypeFilter('all'); setSeverityFilter('all'); setSideFilter('all')
    setSyncState(null)
  }

  const types      = useMemo(() => ['all',...Array.from(new Set(alerts.map(a=>a.alert_type).filter(Boolean) as string[]))],[alerts])
  const severities = useMemo(() => ['all',...Array.from(new Set(alerts.map(a=>a.severity).filter(Boolean)   as string[]))],[alerts])
  const sides      = useMemo(() => ['all',...Array.from(new Set(alerts.map(a=>a.side).filter(Boolean)       as string[]))],[alerts])

  // Clark prompt helpers - single source of truth
  const lastSyncSummary = syncState ? `${syncState.processed??0} scanned / ${syncState.inserted??0} inserted` : 'Unavailable'
  const providerSummary = syncState ? ((syncState.providerErrors??0)>0 ? `Degraded (${syncState.providerErrors} errors)` : 'Healthy') : 'Unavailable'
  const buildClarkPrompt = () => {
    if (alerts.length > 0) return `Review my Whale Alerts feed. Visible alerts: ${alerts.length}. Tracked wallets: ${stats.trackedWallets||'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain signals. Do not invent data.`
    return `Review my Whale Alerts setup. No alerts visible. Tracked wallets: ${stats.trackedWallets||'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain what this means. Do not invent alerts.`
  }
  const goClark = () => { window.location.href=`/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1` }

  const covPct = syncState&&(syncState.trackedWalletsTotal??0)>0
    ? Math.min(100,Math.round(((syncState.processed??0)/(syncState.trackedWalletsTotal??1))*100)) : null

  const metrics = [
    {label:'ALERTS · 15M', val:stats.alerts15m, sub:'Last quarter hour',  color:'#2dd4bf'},
    {label:'ALERTS · 1H',  val:stats.alerts1h,  sub:'Past 60 minutes',    color:'#2dd4bf'},
    {label:'ALERTS · 24H', val:stats.alerts24h, sub:'Rolling day window',  color:'#8b5cf6'},
    {label:'TRACKED WALLETS', val:stats.trackedWallets, sub:'Smart money + manual', color:'#ec4899'},
  ]

  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden text-white"
      style={{background:'radial-gradient(ellipse 80% 50% at 50% -10%,rgba(45,212,191,0.08),transparent 55%),radial-gradient(ellipse 60% 40% at 90% 5%,rgba(139,92,246,0.07),transparent 50%),#07080f'}}>

      <div className="mx-auto max-w-[1280px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">

        {/* ── HERO ── */}
        <div className="rounded-[28px] p-6" style={{background:C,border:`1px solid ${B}`,boxShadow:'0 0 80px rgba(45,212,191,0.06),0 20px 50px rgba(0,0,0,0.5)'}}>
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">

            {/* Left */}
            <div className="min-w-0 flex-1">
              <div className="mb-3 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{color:'#2dd4bf'}}>Whale Alerts</p>
                <span style={{color:'#1e3a4a',fontSize:11}}>·</span>
                <p className="text-[11px] uppercase tracking-[0.12em]" style={{color:'#334155'}}>base mainnet</p>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-white">Whale Alerts</h1>
              <p className="mt-2 max-w-lg text-sm" style={{color:'#64748b'}}>Track selected Base wallets for meaningful token movement.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <StatusPill color="cyan" dot>Base Mainnet</StatusPill>
                <StatusPill color="slate">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-0.5"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                  {stats.trackedWallets > 0 ? `${stats.trackedWallets} tracked wallets` : 'Wallets loading'}
                </StatusPill>
                <StatusPill color="teal" dot>{syncing ? 'Syncing…' : 'Batch Sync Online'}</StatusPill>
                <StatusPill color="purple" dot>CORTEX Watching</StatusPill>
              </div>
            </div>

            {/* Right: compact radar panel */}
            <div className="w-full shrink-0 rounded-2xl p-4 lg:w-[360px]"
              style={{background:CI,border:`1px solid ${BI}`}}>
              <div className="flex items-start gap-4">
                {/* CSS radar rings */}
                <div className="relative mt-1 h-[72px] w-[72px] shrink-0">
                  <div className="absolute inset-0 rounded-full" style={{border:'1px solid rgba(45,212,191,0.14)'}}/>
                  <div className="absolute inset-[10px] rounded-full" style={{border:'1px solid rgba(45,212,191,0.11)'}}/>
                  <div className="absolute inset-[20px] rounded-full" style={{background:'rgba(45,212,191,0.10)',border:'1px solid rgba(45,212,191,0.28)'}}/>
                  <div className="absolute inset-[28px] rounded-full" style={{background:'rgba(45,212,191,0.65)'}}/>
                  {/* sweep dot */}
                  <div className="absolute left-[50%] top-[14px] h-1.5 w-1.5 -translate-x-1/2 rounded-full" style={{background:'#f43f5e',boxShadow:'0 0 6px #f43f5e'}}/>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{color:'#2dd4bf'}}>● Live Wallet Movement</p>
                  <p className="mt-1 text-xs leading-relaxed" style={{color:'#475569'}}>Listening for high-signal wallet moves on Base.</p>
                  {/* sparkline */}
                  <div className="mt-3">
                    <svg width="100%" height="36" viewBox="0 0 200 36" preserveAspectRatio="none" fill="none">
                      <defs>
                        <linearGradient id="hsp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.22"/>
                          <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      <path d="M0 28 L20 22 L40 16 L60 20 L80 11 L100 14 L120 7 L140 11 L160 4 L180 8 L200 2" stroke="#2dd4bf" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.75"/>
                      <path d="M0 28 L20 22 L40 16 L60 20 L80 11 L100 14 L120 7 L140 11 L160 4 L180 8 L200 2 L200 36 L0 36Z" fill="url(#hsp)"/>
                      <circle cx="200" cy="2" r="2.5" fill="#2dd4bf" opacity="0.9"/>
                    </svg>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ── METRICS ── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map(m => (
            <div key={m.label} className="relative min-h-[124px] overflow-hidden rounded-2xl p-5"
              style={{background:C,border:`1px solid ${B}`}}>
              <div className="flex items-start justify-between">
                <IconBox color={m.color}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={m.color} strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                </IconBox>
              </div>
              <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.14em]" style={{color:'#334155'}}>{m.label}</p>
              <p className="mt-1 text-4xl font-bold tabular-nums text-white">{m.val}</p>
              <p className="mt-1 text-xs" style={{color:'#475569'}}>{m.sub}</p>
              <MiniSpark color={m.color}/>
              <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{background:`linear-gradient(90deg,${m.color},transparent)`,opacity:0.4}}/>
            </div>
          ))}
        </div>

        {/* ── CONTROLS + SYNC ── */}
        <div className="rounded-[24px] p-5" style={{background:C,border:`1px solid ${B}`}}>
          <div className="flex flex-col gap-4 lg:flex-row">

            {/* Left: Filters — takes ~60% */}
            <div className="flex flex-col gap-5 lg:w-3/5">
              <div>
                <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.18em]" style={{color:'#334155'}}>Time Window</p>
                <div className="flex gap-1 rounded-xl p-1" style={{background:'rgba(255,255,255,0.02)',border:`1px solid ${BI}`,width:'fit-content'}}>
                  {WINDOWS.map(w => <WBtn key={w} active={windowValue===w} onClick={()=>setWindowValue(w)} ch={w}/>)}
                </div>
              </div>

              <div>
                <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.18em]" style={{color:'#334155'}}>Minimum Value</p>
                <div className="flex flex-wrap gap-2">
                  {MIN_OPTIONS.map(m => <VBtn key={m.value} active={minUsd===m.value} onClick={()=>setMinUsd(m.value)} ch={m.label}/>)}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <DkSel label="Alert Type" value={typeFilter} onChange={setTypeFilter} opts={types}/>
                <DkSel label="Severity"   value={severityFilter} onChange={setSeverityFilter} opts={severities}/>
                <DkSel label="Side"       value={sideFilter}     onChange={setSideFilter}     opts={sides}/>
              </div>
            </div>

            {/* Right: Wallet Sync — takes ~40% */}
            <div className="flex flex-col gap-3 rounded-2xl p-4 lg:w-2/5"
              style={{background:'linear-gradient(135deg,rgba(139,92,246,0.09) 0%,rgba(45,212,191,0.04) 100%)',border:'1px solid rgba(139,92,246,0.22)'}}>

              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{background:'rgba(139,92,246,0.14)',border:'1px solid rgba(139,92,246,0.28)'}}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Wallet scan</p>
                    <p className="text-[11px]" style={{color:'#475569'}}>
                      {syncState ? `Last scan ${timeAgo(undefined)}` : 'No scan yet'}
                    </p>
                  </div>
                </div>
                <StatusPill color={syncing?'amber':'teal'} dot>{syncing?'Syncing…':'Sync Healthy'}</StatusPill>
              </div>

              {/* Stat boxes */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl p-3" style={{background:CI,border:`1px solid ${BI}`}}>
                  <p className="text-[10px] font-bold uppercase tracking-widest" style={{color:'#334155'}}>Wallets Scanned</p>
                  <p className="mt-1.5 text-2xl font-bold tabular-nums text-white">
                    {syncState ? <>{syncState.processed??0} <span className="text-base font-normal" style={{color:'#334155'}}>/ {syncState.trackedWalletsTotal??stats.trackedWallets}</span></> : '—'}
                  </p>
                </div>
                <div className="rounded-xl p-3" style={{background:CI,border:`1px solid ${BI}`}}>
                  <p className="text-[10px] font-bold uppercase tracking-widest" style={{color:'#334155'}}>Alerts Found</p>
                  <p className="mt-1.5 text-2xl font-bold tabular-nums text-white">{syncState?.inserted??'—'}</p>
                </div>
              </div>

              {/* Coverage bar */}
              {covPct !== null ? (
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest" style={{color:'#334155'}}>
                    <span>Scan Coverage</span><span style={{color:'#94a3b8'}}>{covPct}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{background:'rgba(255,255,255,0.06)'}}>
                    <div className="h-full rounded-full" style={{width:`${covPct}%`,background:'linear-gradient(90deg,#2dd4bf,#8b5cf6)'}}/>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest" style={{color:'#334155'}}>Scan Coverage</p>
                  <p className="mt-1 text-xs" style={{color:'#475569'}}>Available after first sync</p>
                </div>
              )}

              {(syncState?.providerErrors??0)>0 && (
                <p className="rounded-xl px-3 py-2 text-xs" style={{background:'rgba(251,191,36,0.07)',border:'1px solid rgba(251,191,36,0.18)',color:'#fcd34d'}}>
                  {syncState?.providerErrors} provider error{(syncState?.providerErrors??0)>1?'s':''} — some alerts may be delayed.
                </p>
              )}

              {loading && <p className="text-center text-[11px]" style={{color:'#475569'}}>Refreshing…</p>}

              {/* Buttons */}
              <div className="flex gap-2">
                <button onClick={()=>{ void runSync(syncState?.nextOffset??0) }} disabled={syncing}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold transition-opacity disabled:opacity-50"
                  style={{background:'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)',color:'#030712'}}>
                  <span>→</span>{syncing?'Scanning…':syncState?.nextOffset!=null?'Sync next batch':'Run sync'}
                </button>
                <button onClick={resetFilters} disabled={syncing}
                  className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-40"
                  style={{background:'rgba(255,255,255,0.05)',border:`1px solid ${B}`,color:'#94a3b8'}}>
                  <span>×</span>Reset
                </button>
              </div>

              <button className="mt-1 text-left text-[10px] font-bold uppercase tracking-widest transition-colors hover:opacity-80"
                style={{color:'#334155'}}>
                + Advanced Diagnostics
              </button>
            </div>

          </div>
        </div>

        {/* ── ALERT FEED ── */}
        <div className="overflow-hidden rounded-[24px]" style={{background:C,border:`1px solid ${B}`}}>

          {/* Feed header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" style={{borderBottom:`1px solid ${BI}`}}>
            <div className="flex items-center gap-3">
              <h2 className="text-base font-bold text-white">Alert feed</h2>
              <StatusPill color="green" dot>Auto-update</StatusPill>
              {alerts.length > 0 && (
                <span className="text-xs" style={{color:'#475569'}}>{alerts.length} of {alerts.length} matching</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button className="flex h-8 w-8 items-center justify-center rounded-xl" style={{background:'rgba(255,255,255,0.04)',border:`1px solid ${BI}`,color:'#475569'}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              </button>
              <button className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium" style={{background:'rgba(255,255,255,0.04)',border:`1px solid ${BI}`,color:'#64748b'}}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                Pause
              </button>
              <button onClick={goClark} className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium"
                style={{background:'rgba(139,92,246,0.12)',border:'1px solid rgba(139,92,246,0.28)',color:'#c4b5fd'}}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Ask Clark
              </button>
            </div>
          </div>

          {/* Skeleton */}
          {loading && Array.from({length:4}).map((_,i)=>(
            <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse" style={{borderBottom:`1px solid ${BI}`}}>
              <div className="h-9 w-9 rounded-xl shrink-0" style={{background:'rgba(255,255,255,0.05)'}}/>
              <div className="flex-1 space-y-2">
                <div className="h-3 w-2/3 rounded" style={{background:'rgba(255,255,255,0.05)'}}/>
                <div className="h-2.5 w-1/2 rounded" style={{background:'rgba(255,255,255,0.04)'}}/>
              </div>
              <div className="h-6 w-16 rounded-full" style={{background:'rgba(255,255,255,0.05)'}}/>
            </div>
          ))}

          {/* Error */}
          {feedError && !loading && (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-semibold" style={{color:'#fda4af'}}>Feed unavailable</p>
              <p className="mt-1 text-xs" style={{color:'#475569'}}>The feed request failed. Sync may still be online.</p>
              <button onClick={()=>void loadAlerts()} className="mt-4 rounded-xl px-4 py-2 text-xs font-medium text-white"
                style={{background:'rgba(255,255,255,0.05)',border:`1px solid ${B}`}}>Retry</button>
            </div>
          )}

          {/* Empty */}
          {!feedError && !loading && alerts.length === 0 && (
            <div className="px-5 py-16 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl"
                style={{background:'rgba(45,212,191,0.07)',border:'1px solid rgba(45,212,191,0.15)'}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
              </div>
              <p className="text-base font-bold text-white">No whale alerts yet</p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed" style={{color:'#475569'}}>
                ChainLens is tracking selected Base wallets, but no qualifying movements have been indexed yet.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <StatusPill color="slate">{stats.trackedWallets?`${stats.trackedWallets} tracked wallets`:'Wallets unavailable'}</StatusPill>
                <StatusPill color="teal">{syncState?'Sync active':'No sync yet'}</StatusPill>
                <StatusPill color={(syncState?.providerErrors??0)>0?'amber':'purple'}>{(syncState?.providerErrors??0)>0?'Provider degraded':'Provider stable'}</StatusPill>
              </div>
            </div>
          )}

          {/* Alert rows */}
          {!feedError && !loading && alerts.length > 0 && alerts.map((alert, i) => {
            const side  = getSide(alert.side)
            const tok   = alert.token_symbol || alert.token_name || '???'
            const avatarLabel = tok.slice(0,3).toUpperCase()
            const walletLabel = alert.wallet_label || short(alert.wallet_address)
            const amtUsd  = fmtUsd(alert.amount_usd)
            const amtTok  = fmtToken(alert.amount_token, alert.token_symbol)
            const desc    = rowDesc(alert.severity)
            const sevL    = sevLabel(alert.severity)
            const s = alert.side?.toLowerCase() ?? ''
            const action  = s==='buy' ? 'bought' : s==='sell' ? 'sold' : 'transferred'

            return (
              <div key={alert.id??`${alert.tx_hash??''}-${i}`}
                className="group transition-colors hover:bg-white/[0.018]"
                style={{borderBottom:`1px solid ${BI}`,borderLeft:`3px solid ${side.line}`}}>
                <div className="flex items-start gap-3 px-4 py-3.5">

                  {/* Avatar */}
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold text-white mt-0.5"
                    style={{background:side.avatarBg,border:`1px solid ${side.line}22`}}>
                    {avatarLabel}
                  </div>

                  {/* Main content */}
                  <div className="min-w-0 flex-1">
                    {/* Line 1: summary */}
                    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                      <span
                        className="rounded-lg px-2 py-0.5 text-[10px] font-bold tracking-wider"
                        style={{background:side.chipBg,border:`1px solid ${side.chipBd}`,color:side.chipTx}}>
                        {side.label}
                      </span>
                      <span className="text-sm font-semibold text-white truncate">
                        {short(alert.wallet_address)} {action}{' '}
                        <span style={{color: amtUsd === '—' ? '#94a3b8' : '#2dd4bf'}}>{amtUsd}</span>
                        {' '}of <span className="font-bold">{tok}</span>
                      </span>
                    </div>

                    {/* Line 2: metadata chips */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{color:'#475569'}}>
                      <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{background:'rgba(45,212,191,0.08)',border:'1px solid rgba(45,212,191,0.18)',color:'#2dd4bf'}}>• TRACKED WALLET</span>
                      <span className="font-mono">{short(alert.wallet_address)}</span>
                      {alert.token_name && <span>· {alert.token_name}</span>}
                      {amtTok && <span>· {amtTok}</span>}
                    </div>

                    {/* Line 3: description */}
                    {desc && <p className="mt-1 text-[11px]" style={{color:'#334155'}}>{desc}</p>}
                  </div>

                  {/* Right: severity + time + link + clark */}
                  <div className="flex shrink-0 items-center gap-2 mt-0.5">
                    {sevL && (
                      <span className="hidden sm:inline rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wider" style={sevStyle(alert.severity)}>
                        • {sevL}
                      </span>
                    )}
                    <span className="tabular-nums text-[11px]" style={{color:'#475569'}}>{timeAgo(alert.occurred_at)}</span>
                    {alert.tx_hash && (
                      <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer"
                        className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:text-teal-300"
                        style={{background:'rgba(255,255,255,0.04)',border:`1px solid ${BI}`,color:'#475569'}}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      </a>
                    )}
                    <button onClick={goClark}
                      className="hidden sm:flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold transition-colors"
                      style={{background:'rgba(139,92,246,0.10)',border:'1px solid rgba(139,92,246,0.24)',color:'#c4b5fd'}}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                      Ask Clark
                    </button>
                  </div>

                </div>
              </div>
            )
          })}

          {/* Feed footer */}
          {alerts.length > 0 && (
            <div className="flex items-center justify-between px-5 py-3" style={{borderTop:`1px solid ${BI}`}}>
              <span className="font-mono text-[11px]" style={{color:'#334155'}}>stream · base.alerts.v2</span>
              <div className="flex items-center gap-3 text-[11px]">
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full inline-block" style={{background:'#2dd4bf'}}/><span style={{color:'#475569'}}>BUY</span></span>
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full inline-block" style={{background:'#f43f5e'}}/><span style={{color:'#475569'}}>SELL</span></span>
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full inline-block" style={{background:'#8b5cf6'}}/><span style={{color:'#475569'}}>TRANSFER</span></span>
              </div>
            </div>
          )}

        </div>

      </div>
    </div>
  )
}
