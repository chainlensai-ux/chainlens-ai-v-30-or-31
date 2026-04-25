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
        padding: '34px 18px 26px',
        color: '#e2e8f0',
        background:
          'radial-gradient(circle at 14% 14%, rgba(45,212,191,0.14), transparent 42%), radial-gradient(circle at 86% 12%, rgba(236,72,153,0.12), transparent 38%), radial-gradient(circle at 80% 30%, rgba(139,92,246,0.14), transparent 42%), linear-gradient(180deg, #040712 0%, #050816 45%, #040611 100%)',
      }}
    >
      <style>{`
        .clark-grid-bg {
          background-image:
            linear-gradient(rgba(148,163,184,0.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148,163,184,0.06) 1px, transparent 1px);
          background-size: 30px 30px;
          background-position: center;
        }
        .clark-shell {
          max-width: 1120px;
          margin: 0 auto;
          padding: 6px 8px;
        }
        .clark-hero {
          text-align: center;
          margin-bottom: 30px;
        }
        .clark-title {
          margin: 0 0 10px;
          font-size: 50px;
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
          gap: 14px;
          margin-bottom: 24px;
        }
        .clark-action-card {
          text-align: left;
          min-height: 152px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.16);
          background: linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.03));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 10px 30px rgba(0,0,0,0.28);
          padding: 22px;
          cursor: pointer;
          transition: border-color .15s, transform .15s, box-shadow .15s;
        }
        .clark-action-card:hover {
          border-color: rgba(153,246,228,0.42);
          transform: translateY(-2px);
          box-shadow: 0 12px 34px rgba(45,212,191,0.12), 0 10px 30px rgba(168,85,247,0.11);
        }
        .clark-chat-wrap {
          max-width: 1020px;
          margin: 0 auto;
          border-radius: 20px;
          border: 1px solid rgba(255,255,255,0.17);
          background: linear-gradient(180deg, rgba(10,16,35,0.90), rgba(4,8,22,0.92));
          box-shadow: 0 0 0 1px rgba(45,212,191,0.12) inset, 0 16px 46px rgba(0,0,0,0.48), 0 0 36px rgba(45,212,191,0.08);
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
          .clark-title { font-size: 40px; }
        }
        @media (max-width: 700px) {
          .clark-shell { padding: 0; }
          .clark-grid { grid-template-columns: 1fr; }
          .clark-title { font-size: 30px; }
        }
      `}</style>

      <div className='clark-grid-bg clark-shell'>
        <div className='clark-hero'>
          <div
            style={{
              width: '92px',
              height: '92px',
              margin: '0 auto 14px',
              borderRadius: '50%',
              position: 'relative',
              background: 'conic-gradient(from 140deg, rgba(45,212,191,0.85), rgba(139,92,246,0.78), rgba(236,72,153,0.75), rgba(45,212,191,0.85))',
              padding: '2.5px',
              boxShadow: '0 0 28px rgba(45,212,191,0.24), 0 0 46px rgba(168,85,247,0.22), 0 10px 30px rgba(0,0,0,0.35)',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                background: 'radial-gradient(circle at 50% 28%, rgba(31,41,55,0.9), rgba(2,6,23,0.98))',
                border: '1px solid rgba(255,255,255,0.12)',
                boxShadow: 'inset 0 8px 18px rgba(255,255,255,0.06)',
              }}
            >
              <span style={{ position: 'absolute', width: '9px', height: '9px', borderRadius: '50%', background: '#99f6e4', left: '33px', top: '41px', boxShadow: '0 0 14px rgba(153,246,228,0.95)' }} />
              <span style={{ position: 'absolute', width: '9px', height: '9px', borderRadius: '50%', background: '#c4b5fd', right: '33px', top: '41px', boxShadow: '0 0 14px rgba(196,181,253,0.95)' }} />
            </div>
          </div>
          <p style={{ margin: '0 0 7px', fontSize: '11px', letterSpacing: '0.15em', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
            LIVE • Powered by CORTEX
          </p>
          <h1 className='clark-title'>Clark AI</h1>
          <p style={{ margin: '0 0 10px', fontSize: '14px', color: '#94a3b8' }}>Base-native AI analyst for tokens, wallets, and on-chain risk.</p>
          <h2 style={{ margin: '0 0 12px', fontSize: '40px', fontWeight: 800, color: '#e2e8f0', letterSpacing: '-0.015em' }}>
            Analyze <span style={{ color: '#2DD4BF' }}>Base</span> Faster With <span style={{ color: '#f0abfc' }}>Clark AI</span>
          </h2>
          <p style={{ margin: 0, fontSize: '15px', color: '#cbd5e1', maxWidth: '780px', marginInline: 'auto', lineHeight: 1.58 }}>
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
                  <span style={{ width: '42px', height: '42px', borderRadius: '12px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.16)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', color: '#99f6e4' }}>
                    {item.icon}
                  </span>
                  <span style={{ fontSize: '16px', color: '#94a3b8' }}>↗</span>
                </div>
                <p style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: 700, color: '#e2e8f0' }}>{item.title}</p>
                <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', lineHeight: 1.55 }}>{item.description}</p>
              </button>
            ))}
        </div>

        <div className='clark-chat-wrap'>
          <div style={{ padding: '14px 16px 0' }}>
            <div style={{ display: 'flex', gap: '9px', flexWrap: 'wrap', marginBottom: '10px' }}>
              <button onClick={handleImportFromRadar} style={chipButtonStyle}>Import from Base Radar</button>
              <button onClick={handlePasteContract} style={chipButtonStyle}>Paste Contract</button>
              <button onClick={handlePasteWallet} style={chipButtonStyle}>Paste Wallet</button>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' }}>
              {importedPrompt && (
                <span style={{ fontSize: '10px', color: '#c4b5fd', border: '1px solid rgba(196,181,253,0.40)', borderRadius: '99px', padding: '4px 10px', fontFamily: 'var(--font-plex-mono)', background: 'rgba(196,181,253,0.10)' }}>
                  Imported from Base Radar
                </span>
              )}
              {activeMode && (
                <span style={{ fontSize: '10px', color: '#99f6e4', border: '1px solid rgba(45,212,191,0.38)', borderRadius: '99px', padding: '4px 10px', fontFamily: 'var(--font-plex-mono)', background: 'rgba(45,212,191,0.10)' }}>
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
  border: '1px solid rgba(255,255,255,0.20)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04))',
  color: '#cbd5e1',
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  padding: '7px 11px',
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
