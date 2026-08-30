'use client'

import { useState } from 'react'

const FAQS = [
  {
    q: 'Do you store my wallet keys or private data?',
    a: 'Never. ChainLens only reads public blockchain data from addresses you provide. We never ask for private keys or seed phrases.',
  },
  {
    q: 'What does each plan include?',
    a: 'Free: Token Scanner basic market data and liquidity depth, plus Clark AI at 5 prompts per day. Pro ($30/month): full Token Scanner, Liquidity Safety, Wallet Scanner, Dev Wallet Detector, Pump Alerts, Whale Alerts, Base Radar, Portfolio, and Clark AI at 50 prompts per day. Elite ($60/month): everything in Pro, Clark AI at 300 prompts per day, and faster whale-alert sync.',
  },
  {
    q: "What's the difference between Pro and Elite?",
    a: 'Both unlock the full terminal. Elite raises Clark AI from 50 to 300 prompts per day and runs whale-alert sync faster than Pro. There is no separate Elite-only product suite beyond those limits.',
  },
  {
    q: 'How many Clark prompts do I get?',
    a: 'Signed-out visitors get 3 per day. Free gets 5. Pro gets 50. Elite gets 300. Unused prompts do not roll over.',
  },
  {
    q: 'Can I cancel my subscription any time?',
    a: 'Yes. Cancel from your account. Access continues until the end of the billing period you already paid for.',
  },
  {
    q: 'Is Clark financial advice?',
    a: 'No. Clark reads live scanner evidence and returns an analysis. Treat it as one input, not an instruction to buy or sell.',
  },
  {
    q: 'Do you have a mobile app?',
    a: 'ChainLens is a web app that works on phones. You can add it to your home screen. There is no native iOS or Android app yet.',
  },
]

export default function FAQAccordion() {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))',
      gap: '10px',
    }}>
      {FAQS.map((faq, i) => (
        <div key={i} style={{
          border: '1px solid rgba(139,92,246,0.15)',
          borderRadius: '12px',
          overflow: 'hidden',
          background: 'rgba(139,92,246,0.03)',
          transition: 'border-color 0.2s',
          borderColor: open === i ? 'rgba(139,92,246,0.35)' : 'rgba(139,92,246,0.15)',
        }}>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '16px 20px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'var(--font-inter, Inter, sans-serif)',
              fontSize: '13px',
              fontWeight: 600,
              color: '#fff',
              lineHeight: 1.4,
            }}
          >
            {faq.q}
            <span style={{
              fontSize: '18px',
              color: 'rgba(139,92,246,0.7)',
              flexShrink: 0,
              transition: 'transform 0.2s',
              transform: open === i ? 'rotate(45deg)' : 'none',
            }}>+</span>
          </button>
          {open === i && (
            <div style={{
              padding: '0 20px 16px',
              fontSize: '13px',
              color: 'rgba(255,255,255,0.55)',
              lineHeight: 1.75,
              borderTop: '1px solid rgba(139,92,246,0.1)',
              paddingTop: '14px',
            }}>
              {faq.a}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
