'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { writeCachedPlan } from '@/lib/usePlan'

type TrialState = 'idle' | 'claiming' | 'claimed' | 'already_claimed' | 'already_active' | 'already_elite' | 'error'

export default function ClaimTrialButton() {
  const [state, setState] = useState<TrialState>('idle')
  const [daysLeft, setDaysLeft] = useState<number | null>(null)
  const router = useRouter()

  const label = useMemo(() => {
    if (state === 'claiming') return 'Claiming...'
    if (state === 'claimed') return 'Open Token Scanner'
    if (state === 'already_active' && daysLeft) return `Elite trial active · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
    if (state === 'already_claimed') return 'Trial already used'
    if (state === 'already_elite') return 'Elite already active'
    return 'Claim 7-Day Elite Pass'
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
      router.push('/auth?redirect=/')
      return
    }

    try {
      const res = await fetch('/api/trial/claim', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json() as { status?: string; trialEndsAt?: string; daysLeft?: number }
      if (!res.ok) throw new Error('request_failed')

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
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <button onClick={onClick} disabled={state === 'claiming'} style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: '17px 30px', borderRadius: '999px', border: '1px solid rgba(251,191,36,0.58)',
        background: 'linear-gradient(95deg, rgba(251,191,36,0.18), rgba(236,72,153,0.20), rgba(139,92,246,0.26))',
        color: '#fff', fontSize: '14px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>{label}</button>
      {(state === 'already_claimed' || state === 'error') && <Link href="/pricing" style={{ color: '#fbbf24', fontSize: 12 }}>Upgrade to Elite</Link>}
    </div>
  )
}
