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
  if (k === 'buy')  return { line: '#2dd4bf', avatarBg: 'linear-gradient(135deg,#0d3b35,#134e4a)', chipBg: 'rgba(34,197,94,0.10)',  chipBd: 'rgba(45,212,191,0.28)',  chipTx: '#5eead4', label: 'BUY'      }
  if (k === 'sell') return { line: '#f43f5e', avatarBg: 'linear-gradient(135deg,#3b0d1a,#4c0519)', chipBg: 'rgba(244,63,94,0.12)',  chipBd: 'rgba(244,63,94,0.32)',  chipTx: '#fda4af', label: 'SELL'     }
  return               { line: '#8b5cf6', avatarBg: 'linear-gradient(135deg,#1e0d3b,#2e1065)', chipBg: 'rgba(139,92,246,0.12)', chipBd: 'rgba(139,92,246,0.32)', chipTx: '#c4b5fd', label: 'TRANSFER' }
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
  return { background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.20)', color: '#64748b' }
}

const rowDesc = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return 'High value movement detected'
  if (sev === 'medium') return 'Fresh tracked-wallet activity'
  if (sev === 'low') return 'Below primary whale threshold'
  return null
}

/* ─── Design tokens ─────────────────────────────────────── */
const BG   = '#020714'
const CARD = '#0c1427'
const CARD2 = '#080f1e'
const BD   = 'rgba(255,255,255,0.08)'
const BD2  = 'rgba(255,255,255,0.05)'

/* ─── Atoms ─────────────────────────────────────────────── */

function Chip({ children, color='slate', dot }: { children: React.ReactNode; color?: 'slate'|'teal'|'purple'|'cyan'|'amber'|'green'|'rose'; dot?: boolean }) {
  const map: Record<string, {bg:string;bd:string;tx:string;dt:string}> = {
    slate:  {bg:'rgba(148,163,184,0.07)',bd:'rgba(148,163,184,0.15)',tx:'#94a3b8',dt:'#64748b'},
    teal:   {bg:'rgba(45,212,191,0.08)', bd:'rgba(45,212,191,0.22)', tx:'#5eead4',dt:'#2dd4bf'},
    purple: {bg:'rgba(139,92,246,0.08)', bd:'rgba(139,92,246,0.22)', tx:'#c4b5fd',dt:'#8b5cf6'},
    cyan:   {bg:'rgba(34,211,238,0.08)', bd:'rgba(34,211,238,0.22)', tx:'#67e8f9',dt:'#22d3ee'},
    amber:  {bg:'rgba(251,191,36,0.08)', bd:'rgba(251,191,36,0.22)', tx:'#fcd34d',dt:'#f59e0b'},
    green:  {bg:'rgba(34,197,94,0.08)',  bd:'rgba(34,197,94,0.22)',  tx:'#86efac',dt:'#22c55e'},
    rose:   {bg:'rgba(244,63,94,0.08)',  bd:'rgba(244,63,94,0.22)',  tx:'#fda4af',dt:'#f43f5e'},
  }
  const c = map[color]
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{background:c.bg,border:`1px solid ${c.bd}`,color:c.tx}}>
      {dot && <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{background:c.dt}}/>}
      {children}
    </span>
  )
}

function WBtn({ active, onClick, ch }: { active: boolean; onClick: () => void; ch: string }) {
  return (
    <button onClick={onClick}
      className="rounded-lg px-4 py-1.5 text-xs font-semibold transition-all"
      style={active
        ? {background:'rgba(45,212,191,0.14)',border:'1px solid rgba(45,212,191,0.40)',color:'#2dd4bf',boxShadow:'0 0 16px rgba(45,212,191,0.12)'}
        : {background:'transparent',border:'1px solid transparent',color:'#3d5068'}}>
      {ch}
    </button>
  )
}

function VBtn({ active, onClick, ch }: { active: boolean; onClick: () => void; ch: string }) {
  return (
    <button onClick={onClick}
      className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
      style={active
        ? {background:'rgba(45,212,191,0.14)',border:'1px solid rgba(45,212,191,0.40)',color:'#2dd4bf',boxShadow:'0 0 12px rgba(45,212,191,0.10)'}
        : {background:'rgba(255,255,255,0.03)',border:`1px solid ${BD2}`,color:'#3d5068'}}>
      {ch}
    </button>
  )
}

function DkSel({ label, value, onChange, opts }: { label: string; value: string; onChange: (v: string) => void; opts: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{color:'#2d3f55'}}>{label}</span>
      <div className="relative">
        <select value={value} onChange={e => onChange(e.target.value)}
          className="wa-select w-full cursor-pointer appearance-none rounded-xl px-3 py-2.5 text-xs outline-none"
          style={{background:CARD2,border:`1px solid ${BD}`,color:'#94a3b8'}}>
          {opts.map(o => <option key={o} value={o}>{o === 'all' ? `All ${label}s` : o}</option>)}
        </select>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" style={{color:'#2d3f55'}}>
          <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M0 0l4.5 5L9 0z"/></svg>
        </span>
      </div>
    </div>
  )
}

/* Gradient border card wrapper */
function GlowCard({ children, glow='teal', className='' }: { children: React.ReactNode; glow?: string; className?: string }) {
  const glowColor = glow === 'teal' ? 'rgba(45,212,191,0.25)' : glow === 'purple' ? 'rgba(139,92,246,0.25)' : 'rgba(255,255,255,0.10)'
  return (
    <div className={`relative rounded-2xl p-px ${className}`}
      style={{background:`linear-gradient(135deg,${glowColor},rgba(255,255,255,0.04) 60%,transparent)`}}>
      <div className="relative h-full w-full rounded-2xl" style={{background:CARD}}>
        {children}
      </div>
    </div>
  )
}

/* Sparkline for metric cards */
function MiniSpark({ color, idx=0 }: { color: string; idx?: number }) {
  const paths = [
    'M0 26 L15 20 L30 14 L45 18 L60 10 L75 12 L90 6 L105 8 L120 2',
    'M0 28 L15 22 L30 18 L45 12 L60 16 L75 8 L90 10 L105 4 L120 6',
    'M0 24 L15 18 L30 22 L45 14 L60 10 L75 14 L90 6 L105 10 L120 2',
    'M0 20 L15 26 L30 18 L45 22 L60 12 L75 16 L90 8 L105 12 L120 4',
  ]
  const d = paths[idx % paths.length]
  const id = `sp${idx}${color.replace('#','')}`
  return (
    <svg width="120" height="32" viewBox="0 0 120 32" fill="none" className="absolute bottom-4 right-4 opacity-50">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.30"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={`${d} L120 32 L0 32Z`} fill={`url(#${id})`}/>
      <path d={d} stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none"/>
      <circle cx="120" cy="2" r="2" fill={color} opacity="0.8"/>
    </svg>
  )
}

/* Live ping dot */
function PingDot({ color='#2dd4bf' }: { color?: string }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping" style={{background:color}}/>
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{background:color}}/>
    </span>
  )
}

/* ─── Page ───────────────────────────────────────────────── */

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
    {label:'ALERTS',  sub:'15M',  val:stats.alerts15m,      desc:'Last quarter hour',  color:'#2dd4bf', glow:'rgba(45,212,191,0.18)'},
    {label:'ALERTS',  sub:'1H',   val:stats.alerts1h,       desc:'Past 60 minutes',    color:'#2dd4bf', glow:'rgba(45,212,191,0.18)'},
    {label:'ALERTS',  sub:'24H',  val:stats.alerts24h,      desc:'Rolling day window', color:'#8b5cf6', glow:'rgba(139,92,246,0.18)'},
    {label:'WALLETS', sub:'LIVE', val:stats.trackedWallets, desc:'Smart money tracked', color:'#ec4899', glow:'rgba(236,72,153,0.18)'},
  ]

  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden"
      style={{background:`radial-gradient(ellipse 90% 60% at 50% -5%,rgba(45,212,191,0.10) 0%,transparent 55%),radial-gradient(ellipse 50% 40% at 85% 10%,rgba(139,92,246,0.08) 0%,transparent 45%),${BG}`}}>

      <div className="mx-auto max-w-[1280px] space-y-4 px-4 py-6 sm:px-6 lg:px-8">

        {/* ══ HERO ══════════════════════════════════════════════════════ */}
        <div className="relative overflow-hidden rounded-3xl p-px"
          style={{background:'linear-gradient(135deg,rgba(45,212,191,0.22) 0%,rgba(139,92,246,0.12) 50%,rgba(255,255,255,0.04) 100%)'}}>
          {/* inner bg */}
          <div className="relative overflow-hidden rounded-[23px] px-6 py-6 sm:px-8 sm:py-7"
            style={{background:'linear-gradient(135deg,#0a1628 0%,#060e1c 60%,#08101f 100%)'}}>

            {/* ambient glow */}
            <div className="pointer-events-none absolute -top-20 left-1/4 h-64 w-64 rounded-full opacity-20"
              style={{background:'radial-gradient(circle,rgba(45,212,191,0.5),transparent 70%)',filter:'blur(40px)'}}/>
            <div className="pointer-events-none absolute -top-10 right-10 h-48 w-48 rounded-full opacity-15"
              style={{background:'radial-gradient(circle,rgba(139,92,246,0.6),transparent 70%)',filter:'blur(36px)'}}/>

            <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center">

              {/* Left ─ title block */}
              <div className="min-w-0 flex-1">
                <div className="mb-3 flex items-center gap-2.5">
                  <PingDot color="#2dd4bf"/>
                  <span className="text-[11px] font-bold uppercase tracking-[0.20em]" style={{color:'#2dd4bf'}}>Live · Base Mainnet</span>
                  <span className="text-[11px]" style={{color:'#1a2d40'}}>·</span>
                  <span className="font-mono text-[11px]" style={{color:'#1a3040'}}>alerts.v2</span>
                </div>

                <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl"
                  style={{background:'linear-gradient(90deg,#ffffff 0%,#94d8d1 60%,#5eead4 100%)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text'}}>
                  Whale Alerts
                </h1>
                <p className="mt-2.5 max-w-md text-sm leading-relaxed" style={{color:'#3d5470'}}>
                  Track smart-money wallets on Base. Surface high-signal moves before the crowd.
                </p>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Chip color="cyan" dot>Base Mainnet</Chip>
                  <Chip color="slate">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-60"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                    {stats.trackedWallets > 0 ? `${stats.trackedWallets} wallets` : 'Loading wallets'}
                  </Chip>
                  <Chip color="teal" dot>{syncing ? 'Syncing…' : 'Batch Sync Online'}</Chip>
                  <Chip color="purple" dot>CORTEX Active</Chip>
                </div>
              </div>

              {/* Right ─ radar panel */}
              <div className="w-full shrink-0 rounded-2xl p-px lg:w-[340px]"
                style={{background:'linear-gradient(135deg,rgba(45,212,191,0.15),rgba(139,92,246,0.08),rgba(255,255,255,0.03))'}}>
                <div className="rounded-2xl p-4" style={{background:'rgba(4,10,22,0.95)'}}>

                  <div className="flex items-center gap-4">
                    {/* Radar rings */}
                    <div className="relative h-[68px] w-[68px] shrink-0">
                      {[0,8,16,24,30].map((inset,ri) => (
                        <div key={ri} className="absolute rounded-full"
                          style={{
                            inset,
                            border:`1px solid rgba(45,212,191,${[0.10,0.12,0.16,0.26,0].at(ri)})`,
                            background: ri===4 ? 'rgba(45,212,191,0.75)' : ri===3 ? 'rgba(45,212,191,0.12)' : 'transparent',
                            boxShadow: ri===4 ? '0 0 10px rgba(45,212,191,0.8)' : 'none',
                          }}/>
                      ))}
                      {/* sweep dot */}
                      <div className="absolute animate-ping h-1.5 w-1.5 rounded-full"
                        style={{top:10,left:'50%',transform:'translateX(-50%)',background:'#f43f5e',opacity:0.7}}/>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <PingDot color="#2dd4bf"/>
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{color:'#2dd4bf'}}>Live Wallet Movement</p>
                      </div>
                      <p className="text-xs leading-relaxed" style={{color:'#2d4460'}}>
                        Scanning high-signal Base wallets in real time.
                      </p>
                    </div>
                  </div>

                  {/* Sparkline */}
                  <div className="mt-3">
                    <svg width="100%" height="32" viewBox="0 0 280 32" preserveAspectRatio="none" fill="none">
                      <defs>
                        <linearGradient id="hero-sp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.20"/>
                          <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      <path d="M0 28 L30 22 L60 17 L90 21 L120 11 L150 14 L180 7 L210 11 L240 4 L270 7 L280 2"
                        stroke="#2dd4bf" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.65"/>
                      <path d="M0 28 L30 22 L60 17 L90 21 L120 11 L150 14 L180 7 L210 11 L240 4 L270 7 L280 2 L280 32 L0 32Z"
                        fill="url(#hero-sp)"/>
                      <circle cx="280" cy="2" r="2.5" fill="#2dd4bf" opacity="0.9"/>
                    </svg>
                  </div>

                </div>
              </div>

            </div>
          </div>
        </div>

        {/* ══ METRICS ══════════════════════════════════════════════════ */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {metrics.map((m, idx) => (
            <div key={m.label+m.sub} className="relative overflow-hidden rounded-2xl p-px"
              style={{background:`linear-gradient(135deg,${m.glow},rgba(255,255,255,0.04) 60%,transparent)`}}>
              <div className="relative overflow-hidden rounded-[15px] p-5" style={{background:CARD,minHeight:130}}>

                {/* Top accent line */}
                <div className="absolute top-0 left-0 right-0 h-[2px]"
                  style={{background:`linear-gradient(90deg,${m.color},transparent 70%)`,opacity:0.7}}/>

                {/* Corner glow */}
                <div className="pointer-events-none absolute top-0 right-0 h-20 w-20 opacity-20"
                  style={{background:`radial-gradient(circle at 100% 0%,${m.color},transparent 70%)`}}/>

                <div className="flex items-start justify-between">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg"
                    style={{background:`${m.color}14`,border:`1px solid ${m.color}28`}}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={m.color} strokeWidth="2.2">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                  </div>
                  <span className="rounded-full px-2 py-0.5 text-[9px] font-bold tracking-widest"
                    style={{background:`${m.color}12`,border:`1px solid ${m.color}24`,color:m.color}}>
                    {m.sub}
                  </span>
                </div>

                <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.18em]" style={{color:'#2d3f55'}}>{m.label}</p>
                <p className="mt-0.5 text-[2.4rem] font-extrabold leading-none tabular-nums text-white">{m.val}</p>
                <p className="mt-1.5 text-[11px]" style={{color:'#2d4060'}}>{m.desc}</p>

                <MiniSpark color={m.color} idx={idx}/>
              </div>
            </div>
          ))}
        </div>

        {/* ══ CONTROLS + SYNC ══════════════════════════════════════════ */}
        <div className="rounded-2xl p-px"
          style={{background:'linear-gradient(135deg,rgba(45,212,191,0.10),rgba(255,255,255,0.04) 50%,rgba(139,92,246,0.08))'}}>
          <div className="rounded-[15px] p-5 sm:p-6" style={{background:CARD}}>
            <div className="flex flex-col gap-6 lg:flex-row">

              {/* Left: Filters */}
              <div className="flex flex-col gap-5 lg:w-[58%]">

                {/* Time window */}
                <div>
                  <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.20em]" style={{color:'#2d3f55'}}>Time Window</p>
                  <div className="inline-flex gap-0.5 rounded-xl p-1"
                    style={{background:'rgba(255,255,255,0.025)',border:`1px solid ${BD2}`}}>
                    {WINDOWS.map(w => <WBtn key={w} active={windowValue===w} onClick={()=>setWindowValue(w)} ch={w}/>)}
                  </div>
                </div>

                {/* Min value */}
                <div>
                  <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.20em]" style={{color:'#2d3f55'}}>Minimum Value</p>
                  <div className="flex flex-wrap gap-2">
                    {MIN_OPTIONS.map(m => <VBtn key={m.value} active={minUsd===m.value} onClick={()=>setMinUsd(m.value)} ch={m.label}/>)}
                  </div>
                </div>

                {/* Dropdowns */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <DkSel label="Alert Type" value={typeFilter}     onChange={setTypeFilter}     opts={types}/>
                  <DkSel label="Severity"   value={severityFilter} onChange={setSeverityFilter} opts={severities}/>
                  <DkSel label="Side"       value={sideFilter}     onChange={setSideFilter}     opts={sides}/>
                </div>
              </div>

              {/* Divider */}
              <div className="hidden w-px lg:block" style={{background:'rgba(255,255,255,0.05)'}}/>

              {/* Right: Wallet Sync */}
              <div className="flex flex-col gap-3.5 lg:flex-1">

                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl"
                      style={{background:'rgba(139,92,246,0.12)',border:'1px solid rgba(139,92,246,0.24)'}}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2">
                        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-white">Wallet Sync</p>
                      <p className="text-[11px]" style={{color:'#2d4060'}}>{syncState ? 'Last scan completed' : 'No scan yet'}</p>
                    </div>
                  </div>
                  <Chip color={syncing?'amber':'teal'} dot>{syncing?'Syncing…':'Online'}</Chip>
                </div>

                {/* Stat boxes */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl p-3" style={{background:CARD2,border:`1px solid ${BD2}`}}>
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{color:'#2d3f55'}}>Wallets Scanned</p>
                    <p className="mt-1.5 text-xl font-bold tabular-nums text-white">
                      {syncState
                        ? <>{syncState.processed??0}<span className="text-sm font-normal" style={{color:'#2d3f55'}}> / {syncState.trackedWalletsTotal??stats.trackedWallets}</span></>
                        : <span style={{color:'#2d3f55'}}>—</span>}
                    </p>
                  </div>
                  <div className="rounded-xl p-3" style={{background:CARD2,border:`1px solid ${BD2}`}}>
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{color:'#2d3f55'}}>Alerts Found</p>
                    <p className="mt-1.5 text-xl font-bold tabular-nums text-white">
                      {syncState?.inserted != null ? syncState.inserted : <span style={{color:'#2d3f55'}}>—</span>}
                    </p>
                  </div>
                </div>

                {/* Coverage bar */}
                {covPct !== null ? (
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest" style={{color:'#2d3f55'}}>
                      <span>Coverage</span>
                      <span style={{color:'#5eead4'}}>{covPct}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{background:'rgba(255,255,255,0.05)'}}>
                      <div className="h-full rounded-full transition-all" style={{width:`${covPct}%`,background:'linear-gradient(90deg,#2dd4bf,#8b5cf6)'}}/>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px]" style={{color:'#2d3f55'}}>Coverage available after first sync</p>
                )}

                {(syncState?.providerErrors??0)>0 && (
                  <p className="rounded-xl px-3 py-2 text-[11px]"
                    style={{background:'rgba(251,191,36,0.06)',border:'1px solid rgba(251,191,36,0.16)',color:'#fcd34d'}}>
                    ⚠ {syncState?.providerErrors} provider error{(syncState?.providerErrors??0)>1?'s':''} — some data may be delayed.
                  </p>
                )}

                {/* Buttons */}
                <div className="flex gap-2">
                  <button onClick={()=>{ void runSync(syncState?.nextOffset??0) }} disabled={syncing}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition-all disabled:opacity-40"
                    style={{background:'linear-gradient(135deg,#1da89a 0%,#7c3aed 100%)',color:'#ffffff',boxShadow:'0 0 24px rgba(45,212,191,0.18)'}}>
                    {syncing
                      ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin"><path d="M21 12a9 9 0 1 1-2.64-6.36"/></svg>Scanning…</>
                      : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>{syncState?.nextOffset!=null?'Next batch':'Run sync'}</>}
                  </button>
                  <button onClick={resetFilters} disabled={syncing}
                    className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-40"
                    style={{background:'rgba(255,255,255,0.04)',border:`1px solid ${BD}`,color:'#475569'}}>
                    Reset
                  </button>
                </div>

              </div>
            </div>
          </div>
        </div>

        {/* ══ ALERT FEED ═══════════════════════════════════════════════ */}
        <div className="overflow-hidden rounded-2xl"
          style={{background:CARD,border:`1px solid ${BD}`}}>

          {/* Feed header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
            style={{borderBottom:`1px solid ${BD2}`,background:'rgba(255,255,255,0.015)'}}>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <PingDot color="#22c55e"/>
                <h2 className="text-sm font-bold text-white">Alert Feed</h2>
              </div>
              {alerts.length > 0 && (
                <span className="rounded-full px-2.5 py-0.5 text-[11px] font-bold"
                  style={{background:'rgba(255,255,255,0.05)',border:`1px solid ${BD2}`,color:'#475569'}}>
                  {alerts.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:opacity-80"
                style={{background:'rgba(255,255,255,0.04)',border:`1px solid ${BD2}`,color:'#3d5068'}}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
              </button>
              <button className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors hover:opacity-80"
                style={{background:'rgba(255,255,255,0.04)',border:`1px solid ${BD2}`,color:'#3d5068'}}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                Pause
              </button>
              <button onClick={goClark}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-all hover:opacity-90"
                style={{background:'linear-gradient(135deg,rgba(139,92,246,0.18),rgba(139,92,246,0.08))',border:'1px solid rgba(139,92,246,0.30)',color:'#c4b5fd',boxShadow:'0 0 14px rgba(139,92,246,0.10)'}}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Ask Clark
              </button>
            </div>
          </div>

          {/* Skeleton */}
          {loading && Array.from({length:5}).map((_,i)=>(
            <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse"
              style={{borderBottom:`1px solid ${BD2}`,borderLeft:'3px solid rgba(255,255,255,0.04)'}}>
              <div className="h-9 w-9 shrink-0 rounded-xl" style={{background:'rgba(255,255,255,0.04)'}}/>
              <div className="flex-1 space-y-2">
                <div className="h-3 w-3/5 rounded-full" style={{background:'rgba(255,255,255,0.05)'}}/>
                <div className="h-2.5 w-2/5 rounded-full" style={{background:'rgba(255,255,255,0.03)'}}/>
              </div>
              <div className="h-6 w-14 rounded-full" style={{background:'rgba(255,255,255,0.04)'}}/>
            </div>
          ))}

          {/* Error */}
          {feedError && !loading && (
            <div className="px-5 py-12 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl"
                style={{background:'rgba(244,63,94,0.08)',border:'1px solid rgba(244,63,94,0.18)'}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <p className="text-sm font-bold" style={{color:'#fda4af'}}>Feed unavailable</p>
              <p className="mt-1 text-xs" style={{color:'#2d4060'}}>The request failed. Sync may still be active.</p>
              <button onClick={()=>void loadAlerts()}
                className="mt-4 rounded-xl px-5 py-2 text-xs font-semibold text-white"
                style={{background:'rgba(255,255,255,0.06)',border:`1px solid ${BD}`}}>
                Retry
              </button>
            </div>
          )}

          {/* Empty */}
          {!feedError && !loading && alerts.length === 0 && (
            <div className="px-5 py-16 text-center">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl"
                style={{background:'rgba(45,212,191,0.07)',border:'1px solid rgba(45,212,191,0.15)',boxShadow:'0 0 30px rgba(45,212,191,0.08)'}}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
              </div>
              <p className="text-base font-bold text-white">No whale alerts yet</p>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed" style={{color:'#2d4060'}}>
                ChainLens is watching selected Base wallets. No qualifying movements indexed yet.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <Chip color="slate">{stats.trackedWallets?`${stats.trackedWallets} tracked`:'Wallets unavailable'}</Chip>
                <Chip color="teal">{syncState?'Sync active':'No sync yet'}</Chip>
                <Chip color={(syncState?.providerErrors??0)>0?'amber':'purple'}>
                  {(syncState?.providerErrors??0)>0?'Provider degraded':'Provider healthy'}
                </Chip>
              </div>
            </div>
          )}

          {/* Alert rows */}
          {!feedError && !loading && alerts.length > 0 && alerts.map((alert, i) => {
            const side  = getSide(alert.side)
            const tok   = alert.token_symbol || alert.token_name || '???'
            const avatarLabel = tok.slice(0,3).toUpperCase()
            const amtUsd  = fmtUsd(alert.amount_usd)
            const amtTok  = fmtToken(alert.amount_token, alert.token_symbol)
            const desc    = rowDesc(alert.severity)
            const sevL    = sevLabel(alert.severity)
            const s       = alert.side?.toLowerCase() ?? ''
            const action  = s==='buy' ? 'bought' : s==='sell' ? 'sold' : 'transferred'

            return (
              <div key={alert.id??`${alert.tx_hash??''}-${i}`}
                className="group transition-all"
                style={{borderBottom:`1px solid ${BD2}`,borderLeft:`3px solid ${side.line}`,background:'transparent'}}
                onMouseEnter={e=>{(e.currentTarget as HTMLDivElement).style.background='rgba(255,255,255,0.018)'}}
                onMouseLeave={e=>{(e.currentTarget as HTMLDivElement).style.background='transparent'}}>

                <div className="flex items-start gap-3 px-4 py-3.5 sm:gap-4">

                  {/* Avatar */}
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[10px] font-extrabold text-white"
                    style={{background:side.avatarBg,boxShadow:`0 0 12px ${side.line}20`,border:`1px solid ${side.line}25`}}>
                    {avatarLabel}
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">

                    {/* Line 1 */}
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="rounded-md px-2 py-0.5 text-[10px] font-extrabold tracking-wider"
                        style={{background:side.chipBg,border:`1px solid ${side.chipBd}`,color:side.chipTx}}>
                        {side.label}
                      </span>
                      <span className="text-sm font-semibold text-white">
                        {short(alert.wallet_address)}{' '}
                        <span style={{color:'#3d5470'}}>{action}</span>{' '}
                        <span className="font-bold" style={{color:amtUsd==='—'?'#3d5470':'#5eead4'}}>{amtUsd}</span>
                        <span style={{color:'#3d5470'}}> of </span>
                        <span className="font-bold text-white">{tok}</span>
                      </span>
                    </div>

                    {/* Line 2 */}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]" style={{color:'#2d4060'}}>
                      <span className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-widest"
                        style={{background:'rgba(45,212,191,0.07)',border:'1px solid rgba(45,212,191,0.15)',color:'#2dd4bf'}}>
                        TRACKED
                      </span>
                      <span className="font-mono" style={{color:'#3d5470'}}>{short(alert.wallet_address)}</span>
                      {alert.token_name && <span style={{color:'#2d3f55'}}>· {alert.token_name}</span>}
                      {amtTok && <span style={{color:'#2d3f55'}}>· {amtTok}</span>}
                    </div>

                    {/* Line 3 */}
                    {desc && (
                      <p className="mt-0.5 text-[11px]" style={{color:'#1e3050'}}>{desc}</p>
                    )}
                  </div>

                  {/* Right side */}
                  <div className="flex shrink-0 flex-col items-end gap-1.5 mt-0.5">
                    {sevL && (
                      <span className="rounded-full px-2.5 py-0.5 text-[9px] font-extrabold tracking-wider"
                        style={sevStyle(alert.severity)}>
                        {sevL}
                      </span>
                    )}
                    <span className="font-mono text-[11px]" style={{color:'#1e3050'}}>{timeAgo(alert.occurred_at)}</span>
                    <div className="flex items-center gap-1.5">
                      {alert.tx_hash && (
                        <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer"
                          className="flex h-6 w-6 items-center justify-center rounded-lg transition-colors hover:opacity-80"
                          style={{background:'rgba(255,255,255,0.04)',border:`1px solid ${BD2}`,color:'#2d4060'}}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                            <polyline points="15 3 21 3 21 9"/>
                            <line x1="10" y1="14" x2="21" y2="3"/>
                          </svg>
                        </a>
                      )}
                      <button onClick={goClark}
                        className="hidden items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] font-bold sm:flex transition-all hover:opacity-90"
                        style={{background:'rgba(139,92,246,0.10)',border:'1px solid rgba(139,92,246,0.22)',color:'#a78bfa'}}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        Clark
                      </button>
                    </div>
                  </div>

                </div>
              </div>
            )
          })}

          {/* Feed footer */}
          {alerts.length > 0 && (
            <div className="flex items-center justify-between px-5 py-3" style={{borderTop:`1px solid ${BD2}`}}>
              <div className="flex items-center gap-2">
                <PingDot color="#22c55e"/>
                <span className="font-mono text-[10px]" style={{color:'#1e3050'}}>stream · base.alerts.v2</span>
              </div>
              <div className="flex items-center gap-4 text-[11px]">
                {[{c:'#2dd4bf',l:'BUY'},{c:'#f43f5e',l:'SELL'},{c:'#8b5cf6',l:'TRANSFER'}].map(({c,l})=>(
                  <span key={l} className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full" style={{background:c}}/>
                    <span style={{color:'#1e3050'}}>{l}</span>
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
