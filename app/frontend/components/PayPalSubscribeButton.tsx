'use client'

// PayPalSubscribeButton — real recurring-Subscriptions flow (distinct from PaymentSelector's
// one-time static-link PayPal option). Calls /api/paypal/create-subscription, then redirects the
// browser to PayPal's approval URL. Once the user approves, PayPal fires BILLING.SUBSCRIPTION.*
// webhook events at /api/paypal/webhook, which is what actually grants the plan.
import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export type PayPalSubscribeButtonProps = {
  plan: 'pro' | 'elite'
  className?: string
}

export function PayPalSubscribeButton({ plan, className }: PayPalSubscribeButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setError(null)
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setError('Sign in first to subscribe.')
        setLoading(false)
        return
      }
      const res = await fetch('/api/paypal/create-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan }),
      })
      const json = await res.json() as { approvalUrl?: string; error?: string }
      if (!res.ok || !json.approvalUrl) {
        setError(json.error ?? 'Could not start subscription. Try again.')
        setLoading(false)
        return
      }
      window.location.href = json.approvalUrl
    } catch {
      setError('Could not start subscription. Try again.')
      setLoading(false)
    }
  }

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className={
          className ??
          'w-full rounded-xl border px-6 py-3 text-[13.5px] font-extrabold tracking-tight text-slate-50 transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0'
        }
        style={{
          borderColor: 'rgba(45,212,191,0.45)',
          background: 'linear-gradient(135deg, rgba(45,212,191,0.18), rgba(139,92,246,0.18), rgba(236,72,153,0.14))',
        }}
      >
        {loading ? 'Redirecting to PayPal…' : `Subscribe with PayPal — ${plan === 'elite' ? 'Elite' : 'Pro'}`}
      </button>
      {error && <p className="mt-2 text-[12px] font-medium text-rose-400">{error}</p>}
    </div>
  )
}

export default PayPalSubscribeButton
