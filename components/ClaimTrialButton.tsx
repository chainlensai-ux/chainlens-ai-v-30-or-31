'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { writeCachedPlan } from '@/lib/usePlan'

type TrialState =
  | 'idle'
  | 'claiming'
  | 'claimed'
  | 'already_claimed'
  | 'already_claimed_email'
  | 'already_active'
  | 'already_elite'
  | 'login_required'
  | 'rate_limited'
  | 'error'

export default function ClaimTrialButton() {
  const [state, setState] = useState<TrialState>('idle')
  const [daysLeft, setDaysLeft] = useState<number | null>(null)
  const router = useRouter()

  const buttonLabel = useMemo(() => {
    if (state === 'claiming') return 'Claiming...'
    if (state === 'claimed') return 'Open Token Scanner'
    return 'Claim 7-Day Elite Pass'
  }, [state])

  const infoLabel = useMemo(() => {
    if (state === 'claimed') return 'Elite pass activated'
    if (state === 'already_active') return daysLeft ? `Already active · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'Already active'
    if (state === 'already_claimed' || state === 'already_claimed_email') return 'Trial already used'
    if (state === 'already_elite') return 'Elite already active'
    if (state === 'login_required') return 'Login required'
    if (state === 'rate_limited') return 'Too many attempts. Try again soon.'
    if (state === 'error') return 'Could not claim right now'
    return null
  }, [daysLeft, state])

  async function onClick() {
    if (state === 'claimed') {
      router.push('/terminal/token-scanner')
      return
    }

    setState('claiming')
    const { data } = await supabase.auth.getSession()
    const session = data.session
    if (!session?.access_token) {
      setState('login_required')
      router.push('/auth?redirect=/')
      return
    }

    try {
      const res = await fetch('/api/trial/claim', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json() as { status?: string; daysLeft?: number; error?: string }

      if (res.status === 429 || json.error === 'rate_limited') {
        setState('rate_limited')
        return
      }
      if (!res.ok) {
        setState('error')
        return
      }

      if (json.status === 'claimed') {
        setState('claimed')
        writeCachedPlan('elite', session.user.id, session.user.email ?? null)
        return
      }
      if (json.status === 'already_active') {
        setDaysLeft(typeof json.daysLeft === 'number' ? json.daysLeft : null)
        setState('already_active')
        return
      }
      if (json.status === 'already_claimed_email') {
        setState('already_claimed_email')
        return
      }
      if (json.status === 'already_claimed') {
        setState('already_claimed')
        return
      }
      if (json.status === 'already_elite') {
        setState('already_elite')
        return
      }
      setState('error')
    } catch {
      setState('error')
    }
  }

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: '100%', maxWidth: 360 }}>
      <button onClick={onClick} disabled={state === 'claiming'} style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', maxWidth: 360,
        padding: '15px 20px', borderRadius: '999px', border: '1px solid rgba(251,191,36,0.58)',
        background: 'linear-gradient(95deg, rgba(251,191,36,0.18), rgba(236,72,153,0.20), rgba(139,92,246,0.26))',
        color: '#fff', fontSize: '13px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'normal',
      }}>{buttonLabel}</button>
      {infoLabel ? <p style={{ margin: 0, fontSize: 12, color: '#fbbf24', textAlign: 'center' }}>{infoLabel}</p> : null}
      {(state === 'already_claimed' || state === 'already_claimed_email' || state === 'error') && <Link href="/pricing" style={{ color: '#fbbf24', fontSize: 12 }}>Upgrade to Elite</Link>}
    </div>
  )
}
