'use client'

import { Suspense, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'next/navigation'

type Message = { role: 'user' | 'clark'; text: string }

type Mode = {
  key: 'token' | 'wallet' | 'contract' | 'radar'
  label: string
  helper: string
  prompt: string
}

const MODES: Mode[] = [
  {
    key: 'token',
    label: 'Token Analysis',
    helper: 'Evaluate token quality, momentum, and risk on Base.',
    prompt: 'Analyze this Base token and give me WATCH, AVOID, or SCAN DEEPER with key reasons.',
  },
  {
    key: 'wallet',
    label: 'Wallet Analysis',
    helper: 'Break down holdings, behavior, concentration, and recent activity.',
    prompt: 'Analyze this Base wallet. Focus on behavior, concentration risk, and recent activity.',
  },
  {
    key: 'contract',
    label: 'Contract Risk',
    helper: 'Review privilege flags, liquidity traps, and suspicious mechanics.',
    prompt: 'Run a contract risk analysis on this Base token contract. Highlight red flags clearly.',
  },
  {
    key: 'radar',
    label: 'Base Radar',
    helper: 'Use imported Base Radar signal context for a concise verdict.',
    prompt: 'Use my imported Base Radar context and give a concise WATCH / AVOID / SCAN DEEPER verdict.',
  },
]

const SUGGESTED_PROMPTS = [
  'Analyze this Base token',
  'Check wallet behavior',
  'Explain liquidity risk',
  'Summarize Base Radar signal',
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
  const [messages, setMessages] = useState<Message[]>([])
  const [activeMode, setActiveMode] = useState<Mode['key']>(importedPrompt ? 'radar' : 'token')
  const [input, setInput] = useState(importedPrompt ?? '')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (importedPrompt) {
      setInput((prev) => (prev.trim() ? prev : importedPrompt))
      setActiveMode('radar')
    }
  }, [importedPrompt])

  const activeModeConfig = MODES.find((mode) => mode.key === activeMode) ?? MODES[0]

  function applyMode(mode: Mode) {
    setActiveMode(mode.key)
    setInput((prev) => (prev.trim() ? prev : mode.prompt))
  }

  function handleImportFromRadar() {
    if (importedPrompt) {
      setInput(importedPrompt)
      setActiveMode('radar')
      return
    }
    const fallback = 'Import the most recent Base Radar context and provide a concise risk-aware verdict.'
    setInput(fallback)
    setActiveMode('radar')
  }

  function handlePasteContract() {
    setInput('I want a contract risk analysis on Base. Contract: 0x... (paste contract)')
    setActiveMode('contract')
  }

  function handlePasteWallet() {
    setInput('I want a wallet analysis on Base. Wallet: 0x... (paste wallet)')
    setActiveMode('wallet')
  }

  function handleClear() {
    setMessages([])
    setInput('')
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return

    setMessages((prev) => [...prev, { role: 'user', text }, { role: 'clark', text: 'Clark is thinking...' }])
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
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: String(reply) }
        return next
      })
    } catch {
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: 'Clark backend unreachable.' }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={pageStyle}>
      <style>{`
        .clark-shell {
          max-width: 1280px;
          margin: 0 auto;
          padding: 30px 20px 24px;
        }
        .clark-grid-bg {
          background-image:
            linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px);
          background-size: 32px 32px;
          background-position: center;
        }
        .clark-main-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.8fr) minmax(320px, 1fr);
          gap: 18px;
          align-items: start;
        }
        .clark-panel {
          border: 1px solid rgba(148,163,184,0.18);
          border-radius: 18px;
          background: linear-gradient(180deg, rgba(15,23,42,0.72), rgba(2,6,23,0.86));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 20px 50px rgba(0,0,0,0.28);
        }
        .clark-mode-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 12px;
        }
        .clark-mode {
          border-radius: 14px;
          border: 1px solid rgba(148,163,184,0.2);
          background: linear-gradient(180deg, rgba(15,23,42,0.65), rgba(15,23,42,0.35));
          text-align: left;
          padding: 11px 12px;
          cursor: pointer;
          transition: all .16s ease;
        }
        .clark-mode:hover {
          border-color: rgba(45,212,191,0.36);
          transform: translateY(-1px);
        }
        .clark-mode.active {
          border-color: rgba(45,212,191,0.56);
          box-shadow: 0 0 0 1px rgba(45,212,191,0.2), 0 0 24px rgba(139,92,246,0.20);
          background: linear-gradient(180deg, rgba(45,212,191,0.16), rgba(139,92,246,0.14));
        }
        @media (max-width: 1080px) {
          .clark-main-grid { grid-template-columns: 1fr; }
          .clark-mode-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 680px) {
          .clark-shell { padding-inline: 14px; }
          .clark-mode-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className='clark-shell clark-grid-bg'>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={orbShellStyle}>
              <div style={orbCoreStyle}>
                <span style={orbEyeLeftStyle} />
                <span style={orbEyeRightStyle} />
              </div>
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: '26px', letterSpacing: '-0.02em', color: '#e2e8f0' }}>Clark AI</h1>
              <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#94a3b8' }}>Base-native AI analyst for tokens, wallets, and on-chain risk.</p>
            </div>
          </div>
          <span style={liveBadgeStyle}>LIVE • Powered by CORTEX</span>
        </header>

        <div className='clark-main-grid'>
          <section>
            <div className='clark-mode-grid'>
              {MODES.map((mode) => (
                <button
                  key={mode.key}
                  className={`clark-mode${activeMode === mode.key ? ' active' : ''}`}
                  onClick={() => applyMode(mode)}
                >
                  <p style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{mode.label}</p>
                  <p style={{ margin: '4px 0 0', fontSize: '11px', lineHeight: 1.35, color: '#94a3b8' }}>{mode.helper}</p>
                </button>
              ))}
            </div>

            <div className='clark-panel' style={{ borderColor: 'rgba(45,212,191,0.38)', boxShadow: '0 0 0 1px rgba(236,72,153,0.16), 0 0 48px rgba(45,212,191,0.12), 0 22px 56px rgba(0,0,0,0.35)' }}>
              <div style={{ padding: '14px 14px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                  <h2 style={{ margin: 0, fontSize: '15px', color: '#e2e8f0' }}>Ask Clark</h2>
                  <span style={{ fontSize: '10px', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em' }}>{activeModeConfig.label}</span>
                </div>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <button onClick={handleImportFromRadar} style={chipButtonStyle}>Import from Base Radar</button>
                  <button onClick={handlePasteContract} style={chipButtonStyle}>Paste Contract</button>
                  <button onClick={handlePasteWallet} style={chipButtonStyle}>Paste Wallet</button>
                  <button onClick={handleClear} style={chipButtonStyle}>Clear</button>
                </div>

                <div style={{ height: '360px', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.10)', background: 'linear-gradient(180deg, rgba(2,6,23,0.58), rgba(2,6,23,0.80))', padding: '12px', overflowY: 'auto' }}>
                  {messages.length === 0 ? (
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#94a3b8' }}>
                      <div style={{ ...orbShellStyle, width: '58px', height: '58px', marginBottom: '10px', boxShadow: '0 0 20px rgba(139,92,246,0.4), 0 0 34px rgba(45,212,191,0.22)' }}>
                        <div style={{ ...orbCoreStyle, border: '1px solid rgba(255,255,255,0.14)' }}>
                          <span style={{ ...orbEyeLeftStyle, left: '18px', top: '26px' }} />
                          <span style={{ ...orbEyeRightStyle, right: '18px', top: '26px' }} />
                        </div>
                      </div>
                      <p style={{ margin: 0, fontSize: '14px', color: '#cbd5e1' }}>Import a token, paste a wallet, or ask Clark what’s moving on Base.</p>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {messages.map((msg, idx) => (
                        <div key={idx} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', padding: '10px 11px', borderRadius: '12px', border: '1px solid', borderColor: msg.role === 'user' ? 'rgba(45,212,191,0.35)' : 'rgba(148,163,184,0.20)', background: msg.role === 'user' ? 'rgba(45,212,191,0.14)' : 'rgba(15,23,42,0.72)' }}>
                          <p style={{ margin: '0 0 4px', fontSize: '10px', color: msg.role === 'user' ? '#99f6e4' : '#94a3b8', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em' }}>
                            {msg.role === 'user' ? 'YOU' : 'CLARK'}
                          </p>
                          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.45, color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>{msg.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ marginTop: '12px', height: '58px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(2,6,23,0.72)', display: 'flex', alignItems: 'center', padding: '8px 8px 8px 14px', gap: '8px', marginBottom: '14px' }}>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !loading) handleSend()
                    }}
                    disabled={loading}
                    placeholder='Ask Clark about a token, wallet, contract, or Base move…'
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#e2e8f0', fontSize: '14px' }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={loading || !input.trim()}
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '999px',
                      border: 'none',
                      background: loading || !input.trim() ? 'rgba(148,163,184,0.28)' : 'linear-gradient(135deg, #2DD4BF 0%, #8B5CF6 55%, #EC4899 100%)',
                      color: loading || !input.trim() ? '#334155' : '#e2e8f0',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                      boxShadow: loading || !input.trim() ? 'none' : '0 0 24px rgba(45,212,191,0.45), 0 0 28px rgba(236,72,153,0.36)',
                    }}
                    aria-label='Send prompt'
                  >
                    ↗
                  </button>
                </div>
              </div>
            </div>
          </section>

          <aside style={{ display: 'grid', gap: '12px' }}>
            <div className='clark-panel' style={{ padding: '12px' }}>
              <p style={asideTitleStyle}>Context</p>
              {importedPrompt ? (
                <>
                  <p style={{ margin: '0 0 8px', fontSize: '12px', color: '#c4b5fd' }}>Imported from Base Radar</p>
                  <div style={contextPreviewStyle}>{importedPrompt}</div>
                </>
              ) : (
                <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>No context imported.</p>
              )}
            </div>

            <div className='clark-panel' style={{ padding: '12px' }}>
              <p style={asideTitleStyle}>Analysis Modes</p>
              <div style={{ display: 'grid', gap: '7px' }}>
                {MODES.map((mode) => (
                  <button
                    key={`aside-${mode.key}`}
                    onClick={() => applyMode(mode)}
                    style={{
                      ...asideButtonStyle,
                      borderColor: activeMode === mode.key ? 'rgba(45,212,191,0.5)' : 'rgba(148,163,184,0.2)',
                      color: activeMode === mode.key ? '#99f6e4' : '#cbd5e1',
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <div className='clark-panel' style={{ padding: '12px' }}>
              <p style={asideTitleStyle}>CORTEX Status</p>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '6px' }}>
                {['Online', 'Base data enabled', 'CoinGecko Terminal active', 'Clark ready'].map((item) => (
                  <li key={item} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#cbd5e1' }}>
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#2dd4bf', boxShadow: '0 0 10px rgba(45,212,191,0.8)' }} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className='clark-panel' style={{ padding: '12px' }}>
              <p style={asideTitleStyle}>Suggested Prompts</p>
              <div style={{ display: 'grid', gap: '7px' }}>
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button key={prompt} onClick={() => setInput(prompt)} style={asideButtonStyle}>{prompt}</button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

const pageStyle: CSSProperties = {
  height: '100%',
  overflowY: 'auto',
  overflowX: 'hidden',
  color: '#e2e8f0',
  background:
    'radial-gradient(circle at 12% 12%, rgba(45,212,191,0.16), transparent 40%), radial-gradient(circle at 86% 10%, rgba(236,72,153,0.14), transparent 40%), radial-gradient(circle at 60% 0%, rgba(139,92,246,0.20), transparent 36%), linear-gradient(180deg, #030712 0%, #040815 45%, #030611 100%)',
}

const orbShellStyle: CSSProperties = {
  width: '44px',
  height: '44px',
  borderRadius: '999px',
  position: 'relative',
  background: 'conic-gradient(from 180deg, #2DD4BF, #8B5CF6, #EC4899, #2DD4BF)',
  padding: '2px',
  boxShadow: '0 0 24px rgba(139,92,246,0.35), 0 0 32px rgba(45,212,191,0.25)',
}

const orbCoreStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  borderRadius: '999px',
  background: 'radial-gradient(circle at 50% 40%, rgba(255,255,255,0.11), rgba(15,23,42,0.95) 50%, rgba(2,6,23,1) 75%)',
  border: '1px solid rgba(255,255,255,0.10)',
  position: 'relative',
}

const orbEyeLeftStyle: CSSProperties = {
  position: 'absolute',
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  background: '#e0f2fe',
  left: '13px',
  top: '18px',
  boxShadow: '0 0 12px rgba(224,242,254,0.9)',
}

const orbEyeRightStyle: CSSProperties = {
  ...orbEyeLeftStyle,
  left: 'auto',
  right: '13px',
}

const chipButtonStyle: CSSProperties = {
  borderRadius: '999px',
  border: '1px solid rgba(148,163,184,0.28)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
  color: '#cbd5e1',
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  padding: '7px 12px',
  textTransform: 'uppercase',
  fontFamily: 'var(--font-plex-mono)',
  cursor: 'pointer',
}

const liveBadgeStyle: CSSProperties = {
  borderRadius: '999px',
  border: '1px solid rgba(45,212,191,0.34)',
  background: 'rgba(45,212,191,0.10)',
  color: '#99f6e4',
  fontSize: '10px',
  letterSpacing: '0.1em',
  fontFamily: 'var(--font-plex-mono)',
  padding: '5px 10px',
  whiteSpace: 'nowrap',
}

const asideTitleStyle: CSSProperties = {
  margin: '0 0 10px',
  fontSize: '11px',
  color: '#94a3b8',
  letterSpacing: '0.08em',
  fontFamily: 'var(--font-plex-mono)',
  textTransform: 'uppercase',
}

const asideButtonStyle: CSSProperties = {
  width: '100%',
  borderRadius: '10px',
  border: '1px solid rgba(148,163,184,0.2)',
  background: 'rgba(15,23,42,0.5)',
  color: '#cbd5e1',
  fontSize: '12px',
  textAlign: 'left',
  padding: '8px 10px',
  cursor: 'pointer',
}

const contextPreviewStyle: CSSProperties = {
  borderRadius: '10px',
  border: '1px solid rgba(196,181,253,0.34)',
  background: 'rgba(196,181,253,0.08)',
  color: '#ddd6fe',
  fontSize: '12px',
  lineHeight: 1.4,
  padding: '8px 10px',
  maxHeight: '120px',
  overflow: 'auto',
}

export default function ClarkAiPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#94a3b8' }}>Loading Clark AI...</div>}>
      <ClarkAiContent />
    </Suspense>
  )
}
