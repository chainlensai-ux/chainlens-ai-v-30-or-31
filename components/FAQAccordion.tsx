'use client'

import { useState } from 'react'

const FAQS = [
  {
    q: 'Do you store my wallet keys or private data?',
    a: 'Never. ChainLens AI only reads public blockchain data from wallet addresses you provide. We never ask for private keys, seed phrases, or wallet connections. Your funds are always 100% in your control.',
  },
  {
    q: 'Which chains does WalletScan support?',
    a: 'Ethereum, BNB Chain, Polygon, Arbitrum, Base, Optimism (EVM wallets), Solana, and Bitcoin. More chains are added regularly. If a chain has a public explorer API, we can add it.',
  },
  {
    q: 'Is GhostTrade using real prices?',
    a: "Yes. GhostTrade pulls live prices from DexScreener so your simulated trades reflect actual market conditions. There's no spread manipulation or artificial pricing — it's as close to real trading as paper trading gets.",
  },
  {
    q: 'How does PumpAlert detect pumps early?',
    a: "PumpAlert queries DexScreener's live pairs API every 60 seconds, filtering for tokens showing unusual volume spikes and price action above your configured thresholds. It scores each alert for rug risk so you can separate genuine momentum from manufactured pumps.",
  },
  {
    q: 'Can I cancel my subscription any time?',
    a: 'Yes, always. No lock-ins, no cancellation fees. Cancel from your account settings in under 10 seconds. Your access continues until the end of the billing period you already paid for.',
  },
  {
    q: "What's the difference between Pro and Elite?",
    a: 'Pro unlocks GhostTrade, DipRadar, TradeCoach, EdgeScan AI, SentimentPulse, TaxMate, Price Alerts, and Token Unlocks. Elite adds WalletScan, SignalBreaker, PumpAlert, NarrativeRank, Smart Wallets, and ProofVault — the heavy on-chain intelligence tools.',
  },
  {
    q: 'Is the AI analysis accurate?',
    a: "Clark AI combines live blockchain data with GPT-4-class reasoning to give you specific, data-backed analysis — not generic crypto advice. That said, no AI is infallible. Always treat AI output as one input among many, not a financial instruction.",
  },
  {
    q: 'Do you have a mobile app?',
    a: 'ChainLens AI is a fully responsive web app — it works on any device. You can add it to your home screen on iOS and Android for an app-like experience. A native app is on the roadmap.',
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
