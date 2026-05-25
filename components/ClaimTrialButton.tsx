'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { writeCachedPlan } from '@/lib/usePlan'

type TrialState =
  | 'idle' | 'claiming' | 'claimed' | 'already_claimed' | 'already_claimed_email' | 'already_active' | 'already_elite' | 'login_required' | 'rate_limited' | 'error'

function remainingLabel(endsAt: string | null): string | null {
  if (!endsAt) return null
  const ms = Date.parse(endsAt) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const totalMins = Math.floor(ms / 60_000)
  const days = Math.floor(totalMins / 1440)
  const hours = Math.floor((totalMins % 1440) / 60)
  const mins = totalMins % 60
  return `${days}d ${hours}h ${mins}m`
}

export default function ClaimTrialButton() {
  const [state, setState] = useState<TrialState>('idle')
  const [daysLeft, setDaysLeft] = useState<number | null>(null)
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null)
  const [countdown, setCountdown] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    const tick = () => setCountdown(remainingLabel(trialEndsAt))
    tick()
    const t = window.setInterval(tick, 60_000)
    return () => window.clearInterval(t)
  }, [trialEndsAt])

  const buttonLabel = useMemo(() => state === 'claiming' ? 'Claiming...' : state === 'claimed' ? 'Open Token Scanner' : 'Claim 7-Day Elite Pass', [state])

  const infoLabel = useMemo(() => {
    if (state === 'claimed') return countdown ? `Elite pass activated · ${countdown} left` : 'Elite pass activated'
    if (state === 'already_active') return countdown ? `Elite pass active · ${countdown} left` : (daysLeft ? `Already active · ${daysLeft} days left` : 'Already active')
    if (state === 'already_claimed' || state === 'already_claimed_email') return 'Trial already used'
    if (state === 'already_elite') return 'Elite already active'
    if (state === 'login_required') return 'Login required'
    if (state === 'rate_limited') return 'Too many attempts. Try again soon.'
    if (state === 'error') return 'Could not claim right now'
    return null
  }, [countdown, daysLeft, state])

  async function onClick() { /* unchanged logic with trialEndsAt set */
    if (state === 'claimed') { router.push('/terminal/token-scanner'); return }
    setState('claiming')
    const { data } = await supabase.auth.getSession()
    const session = data.session
    if (!session?.access_token) { setState('login_required'); router.push('/auth?redirect=/'); return }
    try {
      const res = await fetch('/api/trial/claim', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } })
      const json = await res.json() as { status?: string; daysLeft?: number; error?: string; trialEndsAt?: string }
      if (res.status === 429 || json.error === 'rate_limited') { setState('rate_limited'); return }
      if (!res.ok) { setState('error'); return }
      if (json.status === 'claimed') { setTrialEndsAt(typeof json.trialEndsAt === 'string' ? json.trialEndsAt : null); setState('claimed'); writeCachedPlan('elite', session.user.id, session.user.email ?? null); return }
      if (json.status === 'already_active') { setDaysLeft(typeof json.daysLeft === 'number' ? json.daysLeft : null); setState('already_active'); return }
      if (json.status === 'already_claimed_email') { setState('already_claimed_email'); return }
      if (json.status === 'already_claimed') { setState('already_claimed'); return }
      if (json.status === 'already_elite') { setState('already_elite'); return }
      setState('error')
    } catch { setState('error') }
  }

  return <div style={{ display:'inline-flex',flexDirection:'column',alignItems:'center',gap:8,width:'100%',maxWidth:360 }}><button onClick={onClick} disabled={state==='claiming'} style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:'100%',maxWidth:360,padding:'15px 20px',borderRadius:'999px',border:'1px solid rgba(251,191,36,0.58)',background:'linear-gradient(95deg, rgba(251,191,36,0.18), rgba(236,72,153,0.20), rgba(139,92,246,0.26))',color:'#fff',fontSize:'13px',fontWeight:800,letterSpacing:'0.05em',textTransform:'uppercase',whiteSpace:'normal'}}>{buttonLabel}</button>{infoLabel ? <p style={{ margin:0,fontSize:12,color:'#fbbf24',textAlign:'center' }}>{infoLabel}</p> : null}{(state === 'already_claimed' || state === 'already_claimed_email' || state === 'error') && <Link href="/pricing" style={{ color:'#fbbf24',fontSize:12 }}>Upgrade to Elite</Link>}</div>
}
