'use client'

// PaymentSelector — premium, Base-native payment-method picker for the ChainLens Pro checkout
// flow. Tailwind-only (no external CSS files); the two @keyframes blocks are the one thing
// Tailwind utilities can't express directly (a keyframe's steps have to exist as real CSS
// somewhere), so — matching the same pattern already used by SmartMoneyProfileCard.tsx and this
// codebase's own wallet-scanner page (@keyframes fadeUp) — they're declared once in a scoped
// <style> tag and driven entirely via Tailwind's animate-[...] arbitrary-value syntax.
//
// REAL LINK, DISCLOSED: the PayPal CTA is a plain <a href> (not a JS window.open) pointing at the
// exact URL given — an anchor tag is the correct, popup-blocker-safe way to open an external
// payment link, and it means a right-click/"open in new tab"/⌘-click all work the way a user
// expects from a real link, not a JS-only click handler.
import { useState } from 'react'

export type PaymentSelectorProps = {
  onCryptoSelect: () => void
  onPayPalSelect: () => void
}

const PAYPAL_CHECKOUT_URL = 'https://www.paypal.com/ncp/payment/LA29DL2QZQSL'

type PaymentMethod = 'crypto' | 'paypal'

function CryptoIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9.5 9.5c0-1.1 1.12-2 2.5-2s2.5.9 2.5 2-1.12 2-2.5 2-2.5.9-2.5 2 1.12 2 2.5 2 2.5-.9 2.5-2" />
    </svg>
  )
}

function PayPalIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 16.5 8.6 5.8c.1-.7.7-1.3 1.5-1.3h3.9c2.4 0 4 1.5 3.7 3.8-.4 2.7-2.4 4.3-5 4.3H10l-.9 6.4H6.5z" />
      <path d="M9.6 10.6h3.5c2.4 0 4 1.5 3.7 3.8-.4 2.7-2.4 4.3-5 4.3H9.4" />
    </svg>
  )
}

function MethodCard({
  active,
  icon,
  title,
  subtitle,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  title: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group/method relative flex flex-1 items-center gap-3 overflow-hidden rounded-xl border px-4 py-4 text-left transition-all duration-300 ${
        active
          ? 'border-transparent shadow-[0_0_0_1px_rgba(45,212,191,0.5),0_0_24px_rgba(139,92,246,0.30)]'
          : 'border-white/[0.08] hover:border-white/[0.16]'
      }`}
      style={{
        background: active
          ? 'linear-gradient(135deg, rgba(45,212,191,0.12), rgba(139,92,246,0.12), rgba(236,72,153,0.10))'
          : 'rgba(255,255,255,0.02)',
      }}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors duration-300 ${active ? 'text-[#2DD4BF]' : 'text-slate-400 group-hover/method:text-slate-200'}`}
        style={{
          borderColor: active ? 'rgba(45,212,191,0.45)' : 'rgba(255,255,255,0.10)',
          background: active ? 'rgba(45,212,191,0.10)' : 'rgba(255,255,255,0.03)',
        }}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-bold text-slate-100" style={{ fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          {title}
        </span>
        <span className="block truncate font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-slate-400/70">
          {subtitle}
        </span>
      </span>
      {active && (
        <span
          className="ml-auto h-2 w-2 shrink-0 rounded-full"
          style={{ background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.9)' }}
        />
      )}
    </button>
  )
}

export function PaymentSelector({ onCryptoSelect, onPayPalSelect }: PaymentSelectorProps) {
  const [method, setMethod] = useState<PaymentMethod | null>(null)

  function selectCrypto() {
    setMethod('crypto')
    onCryptoSelect()
  }

  function selectPayPal() {
    setMethod('paypal')
    onPayPalSelect()
  }

  return (
    <div className="w-full">
      <style>{`
        @keyframes payBorderShimmer {
          0% { border-color: rgba(45,212,191,0.45); }
          50% { border-color: rgba(139,92,246,0.45); }
          100% { border-color: rgba(236,72,153,0.45); }
        }
        @keyframes payGlowPulse {
          0% { box-shadow: 0 0 10px rgba(45,212,191,0.35), 0 0 0 rgba(139,92,246,0); }
          50% { box-shadow: 0 0 22px rgba(139,92,246,0.55), 0 0 40px rgba(45,212,191,0.15); }
          100% { box-shadow: 0 0 10px rgba(236,72,153,0.35), 0 0 0 rgba(139,92,246,0); }
        }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400/70">
        Choose a payment method
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <MethodCard
          active={method === 'crypto'}
          icon={<CryptoIcon />}
          title="Crypto"
          subtitle="Base · USDC"
          onClick={selectCrypto}
        />
        <MethodCard
          active={method === 'paypal'}
          icon={<PayPalIcon />}
          title="PayPal"
          subtitle="Card · PayPal Balance"
          onClick={selectPayPal}
        />
      </div>

      {method === 'paypal' && (
        <div className="group relative mt-4 animate-[fadeInUp_0.25s_ease-out_both]">
          {/* Outer neon glow, pulsing */}
          <div
            className="pointer-events-none absolute -inset-1 rounded-2xl opacity-70 blur-lg transition-opacity duration-500 group-hover:opacity-100 animate-[payGlowPulse_3.5s_ease-in-out_infinite]"
            style={{ background: 'linear-gradient(135deg, rgba(45,212,191,0.45), rgba(139,92,246,0.40), rgba(236,72,153,0.35))' }}
          />

          <a
            href={PAYPAL_CHECKOUT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="relative flex w-full items-center justify-center gap-2.5 overflow-hidden rounded-2xl border bg-[#06060A]/85 px-6 py-4 backdrop-blur-xl transition-transform duration-200 animate-[payBorderShimmer_5s_ease-in-out_infinite] hover:-translate-y-0.5 active:translate-y-0"
            style={{ borderColor: 'rgba(255,255,255,0.10)' }}
          >
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: 'linear-gradient(135deg, rgba(45,212,191,0.08) 0%, rgba(139,92,246,0.08) 50%, rgba(236,72,153,0.08) 100%)' }}
            />
            <span className="relative flex items-center gap-2.5 text-[14px] font-extrabold tracking-tight text-slate-50" style={{ fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
              <PayPalIcon size={19} />
              Continue with PayPal
            </span>
          </a>

          <p className="mt-2.5 text-center font-mono text-[10.5px] text-slate-400/60">
            Opens PayPal in a new tab · your plan activates after payment confirmation
          </p>
        </div>
      )}
    </div>
  )
}

export default PaymentSelector
