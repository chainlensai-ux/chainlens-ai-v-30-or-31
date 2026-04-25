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
        padding: '28px 18px 24px',
        color: '#e2e8f0',
        background:
          'radial-gradient(circle at 18% 10%, rgba(45,212,191,0.12), transparent 38%), radial-gradient(circle at 82% 8%, rgba(236,72,153,0.10), transparent 34%), radial-gradient(circle at 78% 22%, rgba(139,92,246,0.12), transparent 36%), #050816',
      }}
    >
      <style>{`
        .clark-grid-bg {
          background-image:
            linear-gradient(rgba(148,163,184,0.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148,163,184,0.06) 1px, transparent 1px);
          background-size: 28px 28px;
          background-position: center;
        }
        .clark-shell {
          max-width: 1180px;
          margin: 0 auto;
          border-radius: 20px;
          border: 1px solid rgba(255,255,255,0.09);
          background: rgba(7,11,26,0.58);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          padding: 24px;
        }
        .clark-hero {
          text-align: center;
          margin-bottom: 24px;
        }
        .clark-title {
          margin: 0 0 8px;
          font-size: 42px;
          font-weight: 800;
          letter-spacing: -0.02em;
          background: linear-gradient(92deg, #99f6e4 0%, #a5b4fc 40%, #f0abfc 70%, #fb7185 100%);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
        .clark-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 20px;
        }
        .clark-action-card {
          text-align: left;
          min-height: 142px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.12);
          background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
          padding: 20px;
          cursor: pointer;
          transition: border-color .15s, transform .15s, box-shadow .15s;
        }
        .clark-action-card:hover {
          border-color: rgba(153,246,228,0.34);
          transform: translateY(-2px);
          box-shadow: 0 10px 28px rgba(45,212,191,0.10), 0 8px 24px rgba(168,85,247,0.08);
        }
        .clark-chat-wrap {
          max-width: 980px;
          margin: 0 auto;
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.13);
          background: linear-gradient(180deg, rgba(8,12,28,0.82), rgba(5,8,22,0.85));
          box-shadow: 0 0 0 1px rgba(45,212,191,0.06) inset, 0 14px 38px rgba(0,0,0,0.42);
          overflow: hidden;
        }
        .clark-footer-row {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 10px;
          justify-content: center;
        }
        @media (max-width: 1080px) {
          .clark-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .clark-title { font-size: 36px; }
        }
        @media (max-width: 700px) {
          .clark-shell { padding: 16px; }
          .clark-grid { grid-template-columns: 1fr; }
          .clark-title { font-size: 30px; }
        }
      `}</style>

      <div className='clark-grid-bg clark-shell'>
        <div className='clark-hero'>
          <div
            style={{
              width: '76px',
              height: '76px',
              margin: '0 auto 12px',
              borderRadius: '50%',
              position: 'relative',
              background: 'conic-gradient(from 140deg, rgba(45,212,191,0.85), rgba(139,92,246,0.78), rgba(236,72,153,0.75), rgba(45,212,191,0.85))',
              padding: '2px',
              boxShadow: '0 0 24px rgba(45,212,191,0.22), 0 0 40px rgba(168,85,247,0.20)',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                background: 'radial-gradient(circle at 50% 35%, rgba(31,41,55,0.85), rgba(2,6,23,0.95))',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              <span style={{ position: 'absolute', width: '8px', height: '8px', borderRadius: '50%', background: '#99f6e4', left: '29px', top: '34px', boxShadow: '0 0 12px rgba(153,246,228,0.9)' }} />
              <span style={{ position: 'absolute', width: '8px', height: '8px', borderRadius: '50%', background: '#c4b5fd', right: '29px', top: '34px', boxShadow: '0 0 12px rgba(196,181,253,0.9)' }} />
            </div>
          </div>
          <p style={{ margin: '0 0 7px', fontSize: '11px', letterSpacing: '0.15em', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
            LIVE • Powered by CORTEX
          </p>
          <h1 className='clark-title'>Clark AI</h1>
          <p style={{ margin: '0 0 10px', fontSize: '14px', color: '#94a3b8' }}>Base-native AI analyst for tokens, wallets, and on-chain risk.</p>
          <h2 style={{ margin: '0 0 10px', fontSize: '35px', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
            Analyze <span style={{ color: '#2DD4BF' }}>Base</span> Faster With <span style={{ color: '#f0abfc' }}>Clark AI</span>
          </h2>
          <p style={{ margin: 0, fontSize: '14px', color: '#cbd5e1', maxWidth: '760px', marginInline: 'auto', lineHeight: 1.55 }}>
            Analyze tokens, wallets, contract risk, liquidity, and market activity across Base in seconds.
          </p>
        </div>

        <div className='clark-grid'>
            {QUICK_ACTIONS.map((item) => (
              <button
                key={item.key}
                onClick={() => setPrompt(item.prompt, item.title)}
                className='clark-action-card'
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <span style={{ width: '28px', height: '28px', borderRadius: '9px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: '#99f6e4' }}>
                    {item.icon}
                  </span>
                  <span style={{ fontSize: '13px', color: '#64748b' }}>↗</span>
                </div>
                <p style={{ margin: '0 0 7px', fontSize: '14px', fontWeight: 700, color: '#e2e8f0' }}>{item.title}</p>
                <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.45 }}>{item.description}</p>
              </button>
            ))}
        </div>

        <div className='clark-chat-wrap'>
          <div style={{ padding: '12px 14px 0' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
              <button onClick={handleImportFromRadar} style={chipButtonStyle}>Import from Base Radar</button>
              <button onClick={handlePasteContract} style={chipButtonStyle}>Paste Contract</button>
              <button onClick={handlePasteWallet} style={chipButtonStyle}>Paste Wallet</button>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
              {importedPrompt && (
                <span style={{ fontSize: '10px', color: '#c4b5fd', border: '1px solid rgba(196,181,253,0.32)', borderRadius: '99px', padding: '3px 9px', fontFamily: 'var(--font-plex-mono)' }}>
                  Imported from Base Radar
                </span>
              )}
              {activeMode && (
                <span style={{ fontSize: '10px', color: '#99f6e4', border: '1px solid rgba(45,212,191,0.30)', borderRadius: '99px', padding: '3px 9px', fontFamily: 'var(--font-plex-mono)' }}>
                  Mode: {activeMode}
                </span>
              )}
            </div>
          </div>
          <ClarkChat
            mode='chat-only'
            active='clark-ai'
            initialMessage={prefillPrompt}
            prefillOnlyInitial
          />
        </div>

        <div className='clark-footer-row'>
          <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.12em' }}>CORTEX ENGINE</span>
          <span style={{ fontSize: '10px', color: '#99f6e4', border: '1px solid rgba(45,212,191,0.28)', borderRadius: '99px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono)' }}>3 free uses today</span>
          <span style={{ fontSize: '10px', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.25)', borderRadius: '99px', padding: '2px 8px', fontFamily: 'var(--font-plex-mono)' }}>Credits remaining: 3</span>
          <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Resets in 2d 14h</span>
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
