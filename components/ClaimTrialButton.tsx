'use client'

import { useEffect, useMemo, useState } from 'react'
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
  | 'expired'
  | 'error'

type ClaimResponse = {
  status?: string
  daysLeft?: number
  error?: string
  trialEndsAt?: string | null
}

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
    const tick = () => {
      const next = remainingLabel(trialEndsAt)
      setCountdown(next)
      if (!next && (state === 'claimed' || state === 'already_active')) setState('expired')
    }
    tick()
    const timer = window.setInterval(tick, 60_000)
    return () => window.clearInterval(timer)
  }, [trialEndsAt, state])

  const buttonLabel = useMemo(() => {
    if (state === 'claiming') return 'Claiming...'
    if (state === 'claimed') return 'Open Token Scanner'
    return 'Claim 7-Day Elite Pass'
  }, [state])

  const infoLabel = useMemo(() => {
    if (state === 'claimed') return countdown ? `Elite Pass Active · ${countdown} left` : 'Elite Pass Active'
    if (state === 'already_active') return countdown ? `Elite Pass Active · ${countdown} left` : (daysLeft ? `Already active · ${daysLeft} days left` : 'Already active')
    if (state === 'already_claimed' || state === 'already_claimed_email') return 'Trial already used'
    if (state === 'already_elite') return 'Elite already active'
    if (state === 'login_required') return 'Login required'
    if (state === 'rate_limited') return 'Too many attempts. Try again soon.'
    if (state === 'expired') return 'Trial expired'
    if (state === 'error') return 'Could not claim right now'
    return null
  }, [countdown, daysLeft, state])

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
      const json = await res.json() as ClaimResponse

      if (res.status === 401 || json.error === 'unauthorized') {
        setState('login_required')
        router.push('/auth?redirect=/')
        return
      }
      if (res.status === 429 || json.error === 'rate_limited') {
        setState('rate_limited')
        return
      }
      if (!res.ok) {
        setState('error')
        return
      }

      if (json.status === 'claimed') {
        setTrialEndsAt(typeof json.trialEndsAt === 'string' ? json.trialEndsAt : null)
        setState('claimed')
        writeCachedPlan('elite', session.user.id, session.user.email ?? null)
        return
      }

      if (json.status === 'already_active') {
        setDaysLeft(typeof json.daysLeft === 'number' ? json.daysLeft : null)
        setTrialEndsAt(typeof json.trialEndsAt === 'string' ? json.trialEndsAt : null)
        setState('already_active')
        return
      }

      if (json.status === 'already_claimed_email') return setState('already_claimed_email')
      if (json.status === 'already_claimed') return setState('already_claimed')
      if (json.status === 'already_elite') return setState('already_elite')
      setState('error')
    } catch {
      setState('error')
    }
  }

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: '100%', maxWidth: 360 }}>
      <button
        onClick={onClick}
        disabled={state === 'claiming'}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '100%', maxWidth: 360, minHeight: 48,
          padding: '13px 18px', borderRadius: '999px', border: '1px solid rgba(251,191,36,0.58)',
          background: 'linear-gradient(95deg, rgba(251,191,36,0.18), rgba(236,72,153,0.20), rgba(139,92,246,0.26))',
          color: '#fff', fontSize: '13px', fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
        }}
      >
        {buttonLabel}
      </button>
      {infoLabel ? <p style={{ margin: 0, fontSize: 12, color: '#fbbf24', textAlign: 'center' }}>{infoLabel}</p> : null}
      {(state === 'already_claimed' || state === 'already_claimed_email' || state === 'expired' || state === 'error') && (
        <Link href="/pricing" style={{ color: '#fbbf24', fontSize: 12 }}>Upgrade to Elite</Link>
      )}
    </div>
  )
}
