'use client'

import { Suspense, useMemo, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'next/navigation'
import ClarkChat from '@/components/ClarkChat'

type QuickAction = {
  key: string
  title: string
  description: string
  icon: string
  prompt: string
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    key: 'token-analysis',
    title: 'Token Analysis',
    description: 'Evaluate token quality, momentum, and risk on Base.',
    icon: '◈',
    prompt: 'Analyze this Base token and give me WATCH, AVOID, or SCAN DEEPER with key reasons.',
  },
  {
    key: 'wallet-analysis',
    title: 'Wallet Analysis',
    description: 'Break down holdings, behavior, and wallet risk profile.',
    icon: '◎',
    prompt: 'Analyze this Base wallet. Focus on behavior, concentration risk, and recent activity.',
  },
  {
    key: 'contract-risk',
    title: 'Contract Risk',
    description: 'Review taxes, privilege flags, and potential traps.',
    icon: '⚠',
    prompt: 'Run a contract risk analysis on this Base token contract. Highlight red flags clearly.',
  },
  {
    key: 'base-radar-import',
    title: 'Base Radar Import',
    description: 'Use context imported from Base Radar signal cards.',
    icon: '⟲',
    prompt: 'Use my imported Base Radar context and give a concise WATCH / AVOID / SCAN DEEPER verdict.',
  },
  {
    key: 'whale-flow',
    title: 'Whale Flow',
    description: 'Surface large-holder flow and unusual movement.',
    icon: '⬤',
    prompt: 'Analyze whale flow on Base for this token and summarize buy/sell pressure.',
  },
  {
    key: 'liquidity-safety',
    title: 'Liquidity Safety',
    description: 'Assess LP depth, quality, and early liquidity signals.',
    icon: '◍',
    prompt: 'Assess liquidity safety for this Base token. Flag fragility and strongest positives.',
  },
  {
    key: 'dev-wallet-check',
    title: 'Dev Wallet Check',
    description: 'Inspect deployer behavior and linked wallet signals.',
    icon: '◇',
    prompt: 'Check the deployer/dev wallet for suspicious distribution or sell behavior on Base.',
  },
  {
    key: 'market-narrative',
    title: 'Market Narrative',
    description: 'Summarize current Base narrative and positioning context.',
    icon: '✦',
    prompt: 'Give me the current Base market narrative and where this token fits.',
  },
]

function decodePrompt(value: string | null): string | null {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function ClarkAiContent() {
  const searchParams = useSearchParams()
  const importedPrompt = useMemo(() => decodePrompt(searchParams.get('prompt')), [searchParams])
  const [prefillPrompt, setPrefillPrompt] = useState<string | null>(importedPrompt)
  const [activeMode, setActiveMode] = useState<string | null>(importedPrompt ? 'Base Radar Import' : null)

  function setPrompt(prompt: string, mode: string) {
    setPrefillPrompt(prompt)
    setActiveMode(mode)
  }

  function handleImportFromRadar() {
    if (importedPrompt) {
      setPrompt(importedPrompt, 'Base Radar Import')
    } else {
      setPrompt('Import the most recent Base Radar context and provide a concise risk-aware verdict.', 'Base Radar Import')
    }
  }

  function handlePasteContract() {
    setPrompt('I want a contract risk analysis on Base. Contract: 0x... (paste contract)', 'Contract Risk')
  }

  function handlePasteWallet() {
    setPrompt('I want a wallet analysis on Base. Wallet: 0x... (paste wallet)', 'Wallet Analysis')
  }

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '24px 30px 20px',
        color: '#e2e8f0',
        background:
          'radial-gradient(circle at 20% 10%, rgba(45,212,191,0.08), transparent 35%), radial-gradient(circle at 80% 5%, rgba(168,85,247,0.10), transparent 35%), #050816',
      }}
    >
      <style>{`
        .clark-grid-bg {
          background-image:
            linear-gradient(rgba(148,163,184,0.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148,163,184,0.06) 1px, transparent 1px);
          background-size: 26px 26px;
          background-position: center;
        }
      `}</style>

      <div className='clark-grid-bg' style={{ borderRadius: '18px', border: '1px solid rgba(255,255,255,0.08)', padding: '20px', background: 'rgba(7,11,26,0.55)' }}>
        <div style={{ maxWidth: '920px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '20px' }}>
            <div
                style={{
                width: '72px',
                height: '72px',
                margin: '0 auto 10px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#99f6e4',
                fontSize: '24px',
                fontWeight: 800,
                background: 'radial-gradient(circle at 35% 35%, rgba(45,212,191,0.34), rgba(139,92,246,0.28) 55%, rgba(236,72,153,0.18))',
                border: '1px solid rgba(255,255,255,0.16)',
                boxShadow: '0 0 25px rgba(45,212,191,0.22), 0 0 40px rgba(168,85,247,0.18)',
              }}
            >
              C
            </div>
            <p style={{ margin: '0 0 5px', fontSize: '11px', letterSpacing: '0.15em', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
              LIVE • Powered by CORTEX
            </p>
            <h1 style={{ margin: '0 0 5px', fontSize: '30px', fontWeight: 700, color: '#f8fafc' }}>Clark AI</h1>
            <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#94a3b8' }}>Base-native AI analyst for tokens, wallets, and on-chain risk.</p>
            <h2 style={{ margin: '0 0 8px', fontSize: '26px', fontWeight: 700, color: '#e2e8f0' }}>Analyze Base Faster With Clark AI</h2>
            <p style={{ margin: 0, fontSize: '13px', color: '#cbd5e1' }}>
              Analyze tokens, wallets, contract risk, liquidity, and market activity across Base in seconds.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px', marginBottom: '16px' }}>
            {QUICK_ACTIONS.map((item) => (
              <button
                key={item.key}
                onClick={() => setPrompt(item.prompt, item.title)}
                style={{
                  textAlign: 'left',
                  borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.10)',
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
                  padding: '12px',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s, transform 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ width: '20px', height: '20px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', color: '#99f6e4' }}>
                    {item.icon}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748b' }}>↗</span>
                </div>
                <p style={{ margin: '0 0 4px', fontSize: '12px', fontWeight: 700, color: '#e2e8f0' }}>{item.title}</p>
                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.4 }}>{item.description}</p>
              </button>
            ))}
          </div>

          <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.12em' }}>CORTEX ENGINE</span>
            <span style={{ fontSize: '10px', color: '#99f6e4', border: '1px solid rgba(45,212,191,0.28)', borderRadius: '99px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono)' }}>3 free uses today</span>
            <span style={{ fontSize: '10px', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.25)', borderRadius: '99px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono)' }}>Credits remaining: 3</span>
            <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Resets in 2d 14h</span>
            {importedPrompt && (
              <span style={{ fontSize: '10px', color: '#c4b5fd', border: '1px solid rgba(196,181,253,0.32)', borderRadius: '99px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono)' }}>
                Imported from Base Radar
              </span>
            )}
            {activeMode && (
              <span style={{ fontSize: '10px', color: '#99f6e4', border: '1px solid rgba(45,212,191,0.30)', borderRadius: '99px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono)' }}>
                Mode: {activeMode}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <button onClick={handleImportFromRadar} style={chipButtonStyle}>Import from Base Radar</button>
            <button onClick={handlePasteContract} style={chipButtonStyle}>Paste Contract</button>
            <button onClick={handlePasteWallet} style={chipButtonStyle}>Paste Wallet</button>
          </div>

          <div style={{ borderRadius: '14px', border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(5,8,22,0.78)', minHeight: '460px', overflow: 'hidden' }}>
            <ClarkChat
              mode='chat-only'
              active='clark-ai'
              initialMessage={prefillPrompt}
              prefillOnlyInitial
            />
          </div>
        </div>
      </div>
    </div>
  )
}

const chipButtonStyle: CSSProperties = {
  borderRadius: '999px',
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.03)',
  color: '#cbd5e1',
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  padding: '6px 10px',
  textTransform: 'uppercase',
  fontFamily: 'var(--font-plex-mono)',
  cursor: 'pointer',
}

export default function ClarkAiPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#94a3b8' }}>Loading Clark AI...</div>}>
      <ClarkAiContent />
    </Suspense>
  )
}
