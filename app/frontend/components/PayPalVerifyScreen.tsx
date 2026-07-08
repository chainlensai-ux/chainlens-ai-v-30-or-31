'use client'

// PayPalVerifyScreen — shown after the user pays via the static PayPal link (PaymentSelector's
// PayPal option). The user pastes back their PayPal transaction ID; this calls
// POST /api/paypal/verify, which looks the transaction up for real on PayPal's own servers
// (Reporting API) before granting anything. Tailwind-only, matching the same premium neon
// treatment as PaymentSelector.tsx/SmartMoneyProfileCard.tsx (frosted glass, mint/purple/pink
// glow, scoped <style> for the one thing Tailwind can't express directly: @keyframes).
import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export type PayPalVerifyScreenProps = {
  plan: 'pro' | 'elite'
  onVerified: (plan: 'pro' | 'elite') => void
}

type VerifyState = 'idle' | 'verifying' | 'error'

export function PayPalVerifyScreen({ plan, onVerified }: PayPalVerifyScreenProps) {
  const [transactionId, setTransactionId] = useState('')
  const [state, setState] = useState<VerifyState>('idle')
  const [error, setError] = useState<string | null>(null)

  async function handleVerify() {
    const trimmed = transactionId.trim()
    if (!trimmed) {
      setError('Enter your PayPal transaction ID.')
      return
    }
    setError(null)
    setState('verifying')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setError('Sign in first, then verify your payment.')
        setState('error')
        return
      }
      const res = await fetch('/api/paypal/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transactionId: trimmed, plan }),
      })
      const json = await res.json() as { success?: boolean; plan?: 'pro' | 'elite'; error?: string }
      if (!res.ok || !json.success) {
        setError(json.error ?? 'Could not verify this transaction. Try again.')
        setState('error')
        return
      }
      onVerified(json.plan ?? plan)
    } catch {
      setError('Could not verify this transaction. Try again.')
      setState('error')
    }
  }

  const isVerifying = state === 'verifying'

  return (
    <div className="w-full">
      <style>{`
        @keyframes ppvBorderShimmer {
          0% { border-color: rgba(45,212,191,0.4); }
          50% { border-color: rgba(139,92,246,0.4); }
          100% { border-color: rgba(236,72,153,0.4); }
        }
        @keyframes ppvGlowPulse {
          0% { box-shadow: 0 0 10px rgba(45,212,191,0.35); }
          50% { box-shadow: 0 0 20px rgba(139,92,246,0.5); }
          100% { box-shadow: 0 0 10px rgba(236,72,153,0.35); }
        }
      `}</style>

      <div className="group relative">
        <div
          className="pointer-events-none absolute -inset-px rounded-2xl opacity-50 blur-md transition-opacity duration-500 group-hover:opacity-90 animate-[ppvGlowPulse_6s_ease-in-out_infinite]"
          style={{ background: 'linear-gradient(135deg, rgba(45,212,191,0.35), rgba(139,92,246,0.30), rgba(236,72,153,0.25))' }}
        />

        <div
          className="relative overflow-hidden rounded-2xl border bg-[#06060A]/85 px-6 py-6 backdrop-blur-xl animate-[ppvBorderShimmer_6s_ease-in-out_infinite]"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: 'linear-gradient(135deg, rgba(45,212,191,0.06) 0%, rgba(139,92,246,0.06) 50%, rgba(236,72,153,0.06) 100%)' }}
          />

          <div className="relative">
            <h3 className="m-0 text-[15px] font-extrabold text-slate-50" style={{ fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
              Enter your PayPal Transaction ID
            </h3>
            <p className="mt-1.5 mb-4 text-[12.5px] leading-relaxed text-slate-400/80">
              After paying via PayPal, copy the Transaction ID from your PayPal receipt or email and paste it below to activate {plan === 'pro' ? 'Pro' : 'Elite'}.
            </p>

            <input
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              spellCheck={false}
              value={transactionId}
              onChange={(e) => { setTransactionId(e.target.value); if (error) setError(null) }}
              placeholder="e.g. 3AB123456C789012D"
              disabled={isVerifying}
              className="w-full rounded-xl border bg-white/[0.03] px-4 py-3 font-mono text-[13px] tracking-wide text-slate-100 placeholder:text-slate-500/60 outline-none transition-colors duration-200 focus:border-[#2DD4BF]/60"
              style={{ borderColor: 'rgba(255,255,255,0.10)' }}
            />

            {error && (
              <p className="mt-2.5 text-[12px] font-medium text-rose-400">{error}</p>
            )}

            <button
              type="button"
              onClick={handleVerify}
              disabled={isVerifying}
              className="mt-4 w-full rounded-xl border px-6 py-3 text-[13.5px] font-extrabold tracking-tight text-slate-50 transition-transform duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
              style={{
                borderColor: 'rgba(45,212,191,0.45)',
                background: 'linear-gradient(135deg, rgba(45,212,191,0.18), rgba(139,92,246,0.18), rgba(236,72,153,0.14))',
              }}
            >
              {isVerifying ? 'Verifying…' : 'Verify Payment'}
            </button>

            <p className="mt-3 text-center font-mono text-[10.5px] text-slate-500/70">
              We verify every transaction directly with PayPal before activating your plan.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default PayPalVerifyScreen
