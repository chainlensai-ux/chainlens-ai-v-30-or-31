'use client'

import { Suspense, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'next/navigation'

type Message = { role: 'user' | 'clark'; text: string }

type QuickAction = {
  key: string
  title: string
  description: string
  icon: string
  prompt: string
  accent: string
}

const QUICK_ACTIONS: QuickAction[] = [
  { key: 'token-analysis', title: 'Token Analysis', description: 'Evaluate token quality, momentum, and risk on Base.', icon: '◈', prompt: 'Analyze this Base token and give me WATCH, AVOID, or SCAN DEEPER with key reasons.', accent: 'rgba(45,212,191,0.30)' },
  { key: 'wallet-analysis', title: 'Wallet Analysis', description: 'Break down holdings, behavior, and wallet risk profile.', icon: '◎', prompt: 'Analyze this Base wallet. Focus on behavior, concentration risk, and recent activity.', accent: 'rgba(96,165,250,0.30)' },
  { key: 'contract-risk', title: 'Contract Risk', description: 'Review taxes, privilege flags, and potential traps.', icon: '⚠', prompt: 'Run a contract risk analysis on this Base token contract. Highlight red flags clearly.', accent: 'rgba(251,191,36,0.32)' },
  { key: 'base-radar-import', title: 'Base Radar Import', description: 'Use context imported from Base Radar signal cards.', icon: '⟲', prompt: 'Use my imported Base Radar context and give a concise WATCH / AVOID / SCAN DEEPER verdict.', accent: 'rgba(196,181,253,0.35)' },
  { key: 'whale-flow', title: 'Whale Flow', description: 'Surface large-holder flow and unusual movement.', icon: '⬤', prompt: 'Analyze whale flow on Base for this token and summarize buy/sell pressure.', accent: 'rgba(236,72,153,0.35)' },
  { key: 'liquidity-safety', title: 'Liquidity Safety', description: 'Assess LP depth, quality, and early liquidity signals.', icon: '◍', prompt: 'Assess liquidity safety for this Base token. Flag fragility and strongest positives.', accent: 'rgba(45,212,191,0.30)' },
  { key: 'dev-wallet-check', title: 'Dev Wallet Check', description: 'Inspect deployer behavior and linked wallet signals.', icon: '◇', prompt: 'Check the deployer/dev wallet for suspicious distribution or sell behavior on Base.', accent: 'rgba(139,92,246,0.35)' },
  { key: 'market-narrative', title: 'Market Narrative', description: 'Summarize current Base narrative and positioning context.', icon: '✦', prompt: 'Give me the current Base market narrative and where this token fits.', accent: 'rgba(244,114,182,0.33)' },
]

function decodePrompt(value: string | null): string | null {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseClarkPayload(raw: string): Record<string, string> {
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  const addrMatch = trimmed.match(/0x[a-fA-F0-9]{40}/)
  const address = addrMatch?.[0]

  if (lower.startsWith('scan wallet') && address) return { feature: 'wallet-scanner', walletAddress: address }
  if (address) return { feature: 'scan-token', tokenAddress: address, prompt: trimmed }
  return { feature: 'clark-ai', prompt: trimmed }
}

function ClarkAiContent() {
  const searchParams = useSearchParams()
  const importedPrompt = useMemo(() => decodePrompt(searchParams.get('prompt')), [searchParams])

  const [activeMode, setActiveMode] = useState<string | null>(importedPrompt ? 'Base Radar Import' : null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState(importedPrompt ?? '')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (importedPrompt) setInput(prev => (prev.trim() ? prev : importedPrompt))
  }, [importedPrompt])

  function setPrompt(prompt: string, mode: string) {
    setInput(prompt)
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

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return

    setMessages(prev => [...prev, { role: 'user', text }, { role: 'clark', text: 'Clark is thinking...' }])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/clark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parseClarkPayload(text)),
      })
      const json = await res.json()
      const reply = json.ok ? (json.data?.analysis ?? json.data?.response ?? 'No response.') : (json.error ?? 'Something went wrong.')
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: String(reply) }
        return next
      })
    } catch {
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: 'Clark backend unreachable.' }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '56px 18px 26px',
        color: '#e2e8f0',
        background:
          'radial-gradient(circle at 12% 16%, rgba(45,212,191,0.18), transparent 40%), radial-gradient(circle at 86% 15%, rgba(236,72,153,0.16), transparent 40%), radial-gradient(circle at 50% 2%, rgba(139,92,246,0.20), transparent 38%), linear-gradient(180deg, #040712 0%, #050816 45%, #040611 100%)',
      }}
    >
      <style>{`
        .clark-grid-bg {
          background-image:
            linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px);
          background-size: 30px 30px;
          background-position: center;
        }
        .clark-shell {
          max-width: 1120px;
          margin: 0 auto;
        }
        .clark-hero {
          text-align: center;
          margin-bottom: 38px;
        }
        .clark-title {
          margin: 0 0 12px;
          font-size: 44px;
          font-weight: 800;
          letter-spacing: -0.02em;
          background: linear-gradient(92deg, #99f6e4 0%, #a5b4fc 45%, #f0abfc 70%, #fb7185 100%);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
        .clark-grid {
          max-width: 980px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 16px;
        }
        .clark-action-card {
          text-align: left;
          min-height: 150px;
          border-radius: 18px;
          border: 1px solid rgba(148,163,184,0.16);
          background: linear-gradient(180deg, rgba(15,23,42,0.78), rgba(15,23,42,0.42));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 18px 50px rgba(0,0,0,0.22);
          padding: 22px;
          cursor: pointer;
          transition: border-color .15s, transform .15s, box-shadow .15s;
        }
        .clark-action-card:hover {
          transform: translateY(-2px);
          border-color: rgba(45,212,191,0.35);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 18px 50px rgba(0,0,0,0.24), 0 0 24px rgba(45,212,191,0.14), 0 0 32px rgba(139,92,246,0.12);
        }
        .clark-chat-wrap {
          max-width: 980px;
          margin: 32px auto 0;
          border-radius: 22px;
          border: 1px solid rgba(45,212,191,0.32);
          background: linear-gradient(180deg, rgba(15,23,42,0.78), rgba(3,7,18,0.92));
          box-shadow: 0 0 0 1px rgba(236,72,153,0.12), 0 0 42px rgba(45,212,191,0.12), 0 0 58px rgba(236,72,153,0.10);
          overflow: hidden;
        }
        .clark-footer-row {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 12px;
          justify-content: center;
        }
        @media (max-width: 1080px) {
          .clark-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .clark-title { font-size: 38px; }
        }
        @media (max-width: 700px) {
          .clark-grid { grid-template-columns: 1fr; }
          .clark-title { font-size: 30px; }
        }
      `}</style>

      <div className='clark-grid-bg clark-shell'>
        <div className='clark-hero'>
          <div
            style={{
              width: '88px',
              height: '88px',
              margin: '0 auto 18px',
              borderRadius: '999px',
              position: 'relative',
              background: 'conic-gradient(from 180deg, #2DD4BF, #8B5CF6, #EC4899, #2DD4BF)',
              padding: '2.5px',
              boxShadow: '0 0 36px rgba(139,92,246,0.45), 0 0 52px rgba(45,212,191,0.22)',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '999px',
                background: 'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.12), rgba(15,23,42,0.95) 45%, rgba(2,6,23,1) 75%)',
                border: '1px solid rgba(255,255,255,0.12)',
                boxShadow: 'inset 0 10px 20px rgba(255,255,255,0.06)',
                position: 'relative',
              }}
            >
              <span style={{ position: 'absolute', width: '8px', height: '8px', borderRadius: '50%', background: '#e0f2fe', left: '31px', top: '40px', boxShadow: '0 0 12px rgba(224,242,254,0.9)' }} />
              <span style={{ position: 'absolute', width: '8px', height: '8px', borderRadius: '50%', background: '#e0f2fe', right: '31px', top: '40px', boxShadow: '0 0 12px rgba(224,242,254,0.9)' }} />
            </div>
          </div>
          <p style={{ margin: '0 0 8px', fontSize: '11px', letterSpacing: '0.15em', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
            LIVE • Powered by CORTEX
          </p>
          <h1 className='clark-title'>Clark AI</h1>
          <p style={{ margin: '0 0 10px', fontSize: '15px', color: '#94a3b8' }}>Base-native AI analyst for tokens, wallets, and on-chain risk.</p>
          <h2 style={{ margin: '0 0 12px', fontSize: '40px', fontWeight: 800, color: '#e2e8f0', letterSpacing: '-0.015em' }}>
            Analyze <span style={{ color: '#2DD4BF' }}>Base</span> Faster With <span style={{ color: '#f0abfc' }}>Clark AI</span>
          </h2>
          <p style={{ margin: 0, fontSize: '14px', color: '#cbd5e1', maxWidth: '780px', marginInline: 'auto', lineHeight: 1.58 }}>
            Analyze tokens, wallets, contract risk, liquidity, and market activity across Base in seconds.
          </p>
        </div>

        <div className='clark-grid'>
          {QUICK_ACTIONS.map((item) => (
            <button key={item.key} onClick={() => setPrompt(item.prompt, item.title)} className='clark-action-card'>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ width: '44px', height: '44px', borderRadius: '14px', background: 'rgba(255,255,255,0.08)', border: `1px solid ${item.accent}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', color: '#99f6e4', boxShadow: `0 0 18px ${item.accent}` }}>
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
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
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

            <div style={{ height: '110px', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.015)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', marginBottom: '10px', padding: '8px' }}>
              {messages.length === 0 ? (
                <>
                  <p style={{ margin: '0 0 6px', fontSize: '13px', color: '#cbd5e1' }}>Ask Clark anything.</p>
                  <p style={{ margin: 0, fontSize: '11px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>scan token 0x… · scan wallet 0x… · base radar · clark ai</p>
                </>
              ) : (
                <div style={{ width: '100%', maxHeight: '90px', overflowY: 'auto', fontSize: '12px', lineHeight: 1.5, color: '#cbd5e1' }}>
                  {messages.slice(-4).map((m, idx) => (
                    <p key={idx} style={{ margin: '0 0 6px', color: m.role === 'user' ? '#99f6e4' : '#cbd5e1' }}>
                      <strong style={{ fontFamily: 'var(--font-plex-mono)', fontSize: '10px' }}>{m.role === 'user' ? 'YOU' : 'CLARK'}:</strong> {m.text}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div style={{ height: '52px', borderRadius: '999px', background: 'rgba(2,6,23,0.65)', border: '1px solid rgba(255,255,255,0.10)', display: 'flex', alignItems: 'center', padding: '6px 6px 6px 14px', gap: '8px', marginBottom: '14px' }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !loading) handleSend() }}
                disabled={loading}
                placeholder='Ask Clark about a token, wallet, contract, or Base move…'
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#e2e8f0', fontSize: '13px' }}
              />
              <button
                onClick={handleSend}
                disabled={loading || !input.trim()}
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '999px',
                  border: 'none',
                  background: loading || !input.trim() ? 'rgba(148,163,184,0.28)' : 'linear-gradient(135deg, #2DD4BF, #8B5CF6)',
                  color: loading || !input.trim() ? '#334155' : '#e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                  boxShadow: loading || !input.trim() ? 'none' : '0 0 20px rgba(45,212,191,0.45), 0 0 24px rgba(139,92,246,0.42)',
                }}
              >
                ↗
              </button>
            </div>
          </div>
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
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04))',
  color: '#cbd5e1',
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  padding: '8px 14px',
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
