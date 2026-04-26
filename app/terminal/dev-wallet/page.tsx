'use client'

import { useState } from 'react'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────

type VerdictLabel = 'TRUSTWORTHY' | 'WATCH' | 'AVOID' | 'UNKNOWN'

interface LinkedWallet {
  address: string
  amountReceived: number | null
  asset: string | null
  txHash: string | null
  firstSeen: string | null
}

interface MatchedHolder {
  address: string
  supplyPct: number
  isDeployer: boolean
  isLinked: boolean
}

interface PreviousProject {
  contractAddress: string
  name: string | null
  symbol: string | null
  createdAt: string | null
  rugFlag: boolean | null
  rugReason: string | null
}

interface ClarkVerdict {
  label: VerdictLabel
  confidence: 'high' | 'medium' | 'low'
  summary: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

interface DevWalletResult {
  contractAddress: string
  chain: string
  deployerAddress: string | null
  deployerConfidence: 'high' | 'medium' | 'low'
  methodUsed: string
  linkedWallets: LinkedWallet[]
  holderDataAvailable: boolean
  supplyControlled: number | null
  matchedHolderWallets: MatchedHolder[]
  previousActivityAvailable: boolean
  previousProjects: PreviousProject[]
  suspiciousTransfers: boolean
  suspiciousTransferReasons: string[]
  clarkVerdict: ClarkVerdict | null
  warnings: string[]
  fetchedAt: string
}

// ─── Design tokens ───────────────────────────────────────────────────────

const VERDICT_STYLE: Record<VerdictLabel, { color: string; bg: string; border: string }> = {
  TRUSTWORTHY: { color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.25)'  },
  WATCH:       { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)'  },
  AVOID:       { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.28)' },
  UNKNOWN:     { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.20)' },
}

const CONF_COLOR: Record<string, string> = {
  high: '#2DD4BF', medium: '#fbbf24', low: '#f87171',
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function shortAddr(addr: string, pre = 8, suf = 6): string {
  if (addr.length <= pre + suf + 1) return addr
  return `${addr.slice(0, pre)}…${addr.slice(-suf)}`
}

function fmtAmount(v: number | null, asset: string | null): string {
  if (v === null) return '—'
  const sym = asset ?? 'ETH'
  if (v < 0.0001) return `<0.0001 ${sym}`
  if (v < 1) return `${v.toFixed(4)} ${sym}`
  return `${v.toFixed(3)} ${sym}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return iso }
}

// ─── Sub-components ───────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '28px' }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        fontFamily: 'var(--font-plex-mono)', margin: '0 0 12px',
      }}>
        {title}
      </p>
      {children}
    </div>
  )
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '14px',
      padding: '20px',
      ...style,
    }}>
      {children}
    </div>
  )
}

function DataRow({ label, value, valueStyle }: {
  label: string
  value: React.ReactNode
  valueStyle?: React.CSSProperties
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
    }}>
      <span style={{ fontSize: '12px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>
        {label}
      </span>
      <span style={{
        fontSize: '12px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)',
        textAlign: 'right', maxWidth: '60%', wordBreak: 'break-all', ...valueStyle,
      }}>
        {value}
      </span>
    </div>
  )
}

function WarningBanner({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <div style={{
      background: 'rgba(251,191,36,0.06)',
      border: '1px solid rgba(251,191,36,0.18)',
      borderRadius: '10px',
      padding: '12px 16px',
      marginBottom: '20px',
    }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, color: '#fbbf24',
        textTransform: 'uppercase', letterSpacing: '0.12em',
        fontFamily: 'var(--font-plex-mono)', margin: '0 0 6px',
      }}>
        Data Availability
      </p>
      {warnings.map((w, i) => (
        <p key={i} style={{ fontSize: '11px', color: '#94a3b8', margin: '3px 0', fontFamily: 'var(--font-plex-mono)' }}>
          · {w}
        </p>
      ))}
    </div>
  )
}

// ─── Clark Verdict Card ───────────────────────────────────────────────────

function VerdictCard({ verdict }: { verdict: ClarkVerdict }) {
  const style = VERDICT_STYLE[verdict.label]
  return (
    <Card style={{
      borderColor: style.border,
      background: style.bg,
      marginBottom: '24px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Top accent bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        height: '2px', background: style.color,
      }} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <span style={{
              fontSize: '10px', fontWeight: 700, color: '#a78bfa',
              letterSpacing: '0.14em', textTransform: 'uppercase',
              fontFamily: 'var(--font-plex-mono)',
            }}>
              CLARK AI VERDICT
            </span>
            <span style={{
              fontSize: '9px', color: CONF_COLOR[verdict.confidence] ?? '#94a3b8',
              fontFamily: 'var(--font-plex-mono)',
              background: 'rgba(0,0,0,0.20)', padding: '2px 8px', borderRadius: '99px',
            }}>
              {verdict.confidence} confidence
            </span>
          </div>

          {/* Summary */}
          <p style={{
            fontSize: '13px', color: '#e2e8f0', lineHeight: 1.6, margin: '0 0 16px',
          }}>
            {verdict.summary}
          </p>

          {/* Signals + Risks in two cols */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '14px' }}>
            {verdict.keySignals.length > 0 && (
              <div>
                <p style={{
                  fontSize: '10px', fontWeight: 700, color: '#3a5268',
                  textTransform: 'uppercase', letterSpacing: '0.12em',
                  fontFamily: 'var(--font-plex-mono)', margin: '0 0 6px',
                }}>
                  Key Signals
                </p>
                {verdict.keySignals.map((s, i) => (
                  <p key={i} style={{ fontSize: '11px', color: '#94a3b8', margin: '3px 0' }}>· {s}</p>
                ))}
              </div>
            )}
            {verdict.risks.length > 0 && (
              <div>
                <p style={{
                  fontSize: '10px', fontWeight: 700, color: '#3a5268',
                  textTransform: 'uppercase', letterSpacing: '0.12em',
                  fontFamily: 'var(--font-plex-mono)', margin: '0 0 6px',
                }}>
                  Risks
                </p>
                {verdict.risks.map((r, i) => (
                  <p key={i} style={{ fontSize: '11px', color: '#f87171', margin: '3px 0' }}>· {r}</p>
                ))}
              </div>
            )}
          </div>

          {/* Next action */}
          <div style={{
            borderTop: '1px solid rgba(255,255,255,0.08)',
            paddingTop: '12px',
            fontSize: '11px', color: '#64748b',
            fontFamily: 'var(--font-plex-mono)',
          }}>
            NEXT: {verdict.nextAction}
          </div>
        </div>

        {/* Verdict pill */}
        <div style={{
          padding: '10px 20px', borderRadius: '12px',
          background: 'rgba(0,0,0,0.25)',
          border: `1px solid ${style.border}`,
          textAlign: 'center', flexShrink: 0,
        }}>
          <p style={{
            fontSize: '18px', fontWeight: 700, color: style.color,
            fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em',
            margin: 0,
          }}>
            {verdict.label}
          </p>
        </div>
      </div>
    </Card>
  )
}

// ─── Supply Bar ───────────────────────────────────────────────────────────

function SupplyBar({ supplyControlled, holderDataAvailable }: {
  supplyControlled: number | null
  holderDataAvailable: boolean
}) {
  if (!holderDataAvailable || supplyControlled === null) {
    return (
      <Card>
        <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
          Holder distribution data unavailable for this token.
        </p>
      </Card>
    )
  }

  const pct = Math.min(supplyControlled, 100)
  const barColor = pct > 50 ? '#f87171' : pct > 20 ? '#fbbf24' : '#2DD4BF'

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <span style={{ fontSize: '13px', color: '#e2e8f0', fontWeight: 600 }}>
          {supplyControlled.toFixed(1)}%
        </span>
        <span style={{
          fontSize: '10px', fontWeight: 700, color: barColor,
          fontFamily: 'var(--font-plex-mono)',
          background: barColor === '#2DD4BF' ? 'rgba(45,212,191,0.10)' : barColor === '#fbbf24' ? 'rgba(251,191,36,0.10)' : 'rgba(248,113,113,0.10)',
          padding: '2px 8px', borderRadius: '99px',
        }}>
          {pct > 50 ? 'HIGH RISK' : pct > 20 ? 'ELEVATED' : 'LOW'}
        </span>
      </div>
      <div style={{ height: '6px', borderRadius: '99px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: '99px',
          width: `${pct}%`,
          background: barColor,
          transition: 'width 0.6s ease',
        }} />
      </div>
      <p style={{ fontSize: '11px', color: '#3a5268', margin: '8px 0 0', fontFamily: 'var(--font-plex-mono)' }}>
        Deployer + linked wallets estimated supply control
      </p>
    </Card>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function DevWalletPage() {
  const [input,   setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<DevWalletResult | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  async function handleScan() {
    const q = input.trim()
    if (!q || loading) return
    if (!/^0x[a-fA-F0-9]{40}$/.test(q)) {
      setError('Enter a valid contract address (0x followed by 40 hex characters)')
      return
    }
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res  = await fetch('/api/dev-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractAddress: q }),
      })
      const json = await res.json() as DevWalletResult & { error?: string }
      if (!res.ok || json.error) {
        setError(json.error ?? 'Scan failed — try again')
      } else {
        setResult(json)
      }
    } catch {
      setError('Network error — check your connection')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes devDot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.75); }
          40%            { opacity: 1;    transform: scale(1);    }
        }
      `}</style>

      <div
        className="mob-scan-main"
        style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '40px 48px', color: '#e2e8f0' }}
      >
        {/* Back */}
        <Link href="/terminal" style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          color: 'rgba(255,255,255,0.30)', fontSize: '12px',
          textDecoration: 'none', marginBottom: '24px',
          fontFamily: 'var(--font-inter, Inter, sans-serif)',
        }}
          onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.70)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.30)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </Link>

        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.25)',
            borderRadius: '99px', padding: '4px 12px', marginBottom: '14px',
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
            color: '#a78bfa', fontFamily: 'var(--font-plex-mono)',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: '#8b5cf6', boxShadow: '0 0 8px rgba(139,92,246,0.80)',
            }} />
            ELITE
          </div>
          <h1 style={{ fontSize: '26px', fontWeight: 700, color: '#f8fafc', margin: '0 0 6px' }}>
            Dev Wallet Detector
          </h1>
          <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
            Identify the likely deployer, linked wallets, and supply concentration for any Base token
          </p>
        </div>

        {/* Input */}
        <div style={{ display: 'flex', gap: '10px', maxWidth: '680px', marginBottom: '28px' }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
            disabled={loading}
            placeholder="0x… token contract address on Base"
            style={{
              flex: 1, background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '10px', padding: '12px 16px',
              color: '#e2e8f0', fontSize: '13px', outline: 'none',
              fontFamily: 'var(--font-plex-mono)',
              transition: 'border-color 0.15s',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(139,92,246,0.50)' }}
            onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)' }}
          />
          <button
            onClick={handleScan}
            disabled={loading || !input.trim()}
            style={{
              padding: '12px 22px', borderRadius: '10px',
              background: loading || !input.trim() ? 'rgba(139,92,246,0.15)' : 'rgba(139,92,246,0.85)',
              border: '1px solid rgba(139,92,246,0.40)',
              color: loading || !input.trim() ? '#64748b' : '#fff',
              fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em',
              cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-plex-mono)',
              transition: 'background 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            {loading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    width: '5px', height: '5px', borderRadius: '50%', background: '#a78bfa',
                    animation: 'devDot 1.2s ease-in-out infinite',
                    animationDelay: `${i * 0.18}s`,
                  }} />
                ))}
              </span>
            ) : 'SCAN'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            padding: '12px 16px', borderRadius: '10px',
            background: 'rgba(248,113,113,0.08)',
            border: '1px solid rgba(248,113,113,0.20)',
            color: '#f87171', fontSize: '13px',
            fontFamily: 'var(--font-plex-mono)',
            marginBottom: '24px',
          }}>
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !result && !error && (
          <div style={{
            textAlign: 'center', padding: '60px 20px',
            color: '#3a5268', fontFamily: 'var(--font-plex-mono)',
          }}>
            <div style={{ fontSize: '32px', opacity: 0.3, marginBottom: '12px' }}>⬡</div>
            <p style={{ fontSize: '13px', margin: 0 }}>
              Enter a Base token contract to analyse the deployer wallet
            </p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div style={{ maxWidth: '760px' }}>
            {/* Warnings */}
            <WarningBanner warnings={result.warnings} />

            {/* Clark Verdict */}
            {result.clarkVerdict && (
              <VerdictCard verdict={result.clarkVerdict} />
            )}
            {!result.clarkVerdict && (
              <Card style={{ marginBottom: '24px', borderColor: 'rgba(148,163,184,0.15)' }}>
                <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                  Clark analysis unavailable for this scan.
                </p>
              </Card>
            )}

            {/* Deployer */}
            <Section title={result.deployerConfidence === 'high' ? 'Deployer Wallet' : 'Likely Deployer Wallet'}>
              <Card>
                <DataRow
                  label="Address"
                  value={
                    result.deployerAddress
                      ? <span style={{ fontFamily: 'var(--font-plex-mono)', color: '#c4b5fd' }}>
                          {shortAddr(result.deployerAddress)}
                        </span>
                      : <span style={{ color: '#3a5268' }}>Unknown</span>
                  }
                />
                <DataRow
                  label="Confidence"
                  value={
                    <span style={{ color: CONF_COLOR[result.deployerConfidence] ?? '#94a3b8' }}>
                      {result.deployerConfidence}
                    </span>
                  }
                />
                <DataRow
                  label="Detection Method"
                  value={result.methodUsed.replace(/_/g, ' ')}
                />
                <DataRow label="Chain" value="Base" />
                <DataRow label="Scanned At" value={fmtDate(result.fetchedAt)} />

                {result.deployerAddress && (
                  <div style={{ marginTop: '14px', display: 'flex', gap: '8px' }}>
                    <a
                      href={`https://basescan.org/address/${result.deployerAddress}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '6px 12px', borderRadius: '8px', textDecoration: 'none',
                        fontSize: '11px', fontWeight: 600,
                        color: '#a78bfa', background: 'rgba(139,92,246,0.08)',
                        border: '1px solid rgba(139,92,246,0.20)',
                        fontFamily: 'var(--font-plex-mono)',
                      }}
                    >
                      ↗ Basescan
                    </a>
                  </div>
                )}
              </Card>
            </Section>

            {/* Supply Concentration */}
            <Section title="Supply Concentration">
              <SupplyBar
                supplyControlled={result.supplyControlled}
                holderDataAvailable={result.holderDataAvailable}
              />
              {result.matchedHolderWallets.length > 0 && (
                <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {result.matchedHolderWallets.map((h, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 12px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: '8px',
                      fontSize: '11px', fontFamily: 'var(--font-plex-mono)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: '#64748b' }}>{shortAddr(h.address)}</span>
                        {h.isDeployer && (
                          <span style={{
                            padding: '1px 6px', borderRadius: '99px', fontSize: '9px',
                            color: '#a78bfa', background: 'rgba(139,92,246,0.12)',
                            border: '1px solid rgba(139,92,246,0.25)',
                          }}>DEPLOYER</span>
                        )}
                        {h.isLinked && !h.isDeployer && (
                          <span style={{
                            padding: '1px 6px', borderRadius: '99px', fontSize: '9px',
                            color: '#fbbf24', background: 'rgba(251,191,36,0.10)',
                            border: '1px solid rgba(251,191,36,0.20)',
                          }}>LINKED</span>
                        )}
                      </div>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                        {h.supplyPct.toFixed(2)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Linked Wallets */}
            <Section title={`Linked Wallets (${result.linkedWallets.length})`}>
              {result.linkedWallets.length === 0 ? (
                <Card>
                  <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    {result.deployerAddress
                      ? 'No outgoing ETH transfers found from the deployer wallet.'
                      : 'Unavailable — deployer address not identified.'}
                  </p>
                </Card>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {result.linkedWallets.map((w, i) => (
                    <div key={i} style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      gap: '16px', alignItems: 'center',
                      padding: '12px 16px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.07)',
                      borderRadius: '10px',
                      fontSize: '11px', fontFamily: 'var(--font-plex-mono)',
                    }}>
                      <div>
                        <span style={{ color: '#c4b5fd' }}>{shortAddr(w.address)}</span>
                        {w.firstSeen && (
                          <span style={{ color: '#3a5268', marginLeft: '10px' }}>
                            {fmtDate(w.firstSeen)}
                          </span>
                        )}
                      </div>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                        {fmtAmount(w.amountReceived, w.asset)}
                      </span>
                      {w.txHash && (
                        <a
                          href={`https://basescan.org/tx/${w.txHash}`}
                          target="_blank" rel="noopener noreferrer"
                          style={{ color: '#3a5268', textDecoration: 'none', fontSize: '10px' }}
                          title="View tx on Basescan"
                        >
                          ↗
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Suspicious Transfers */}
            <Section title="Transfer Analysis">
              {result.suspiciousTransfers ? (
                <Card style={{ borderColor: 'rgba(248,113,113,0.20)', background: 'rgba(248,113,113,0.05)' }}>
                  <p style={{
                    fontSize: '11px', fontWeight: 700, color: '#f87171',
                    textTransform: 'uppercase', letterSpacing: '0.12em',
                    fontFamily: 'var(--font-plex-mono)', margin: '0 0 8px',
                  }}>
                    ⚠ Suspicious Patterns Detected
                  </p>
                  {result.suspiciousTransferReasons.map((r, i) => (
                    <p key={i} style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0', fontFamily: 'var(--font-plex-mono)' }}>
                      · {r}
                    </p>
                  ))}
                </Card>
              ) : (
                <Card>
                  <p style={{ fontSize: '12px', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    ✓ No suspicious transfer patterns detected from available data
                  </p>
                </Card>
              )}
            </Section>

            {/* Previous Projects */}
            <Section title="Previous Activity / Projects">
              {!result.previousActivityAvailable ? (
                <Card>
                  <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    Previous deployment history unavailable from current Alchemy/GoldRush data.
                  </p>
                </Card>
              ) : result.previousProjects.length === 0 ? (
                <Card>
                  <p style={{ fontSize: '12px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    No previous deployments found for this wallet.
                  </p>
                </Card>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {result.previousProjects.map((p, i) => (
                    <Card key={i} style={{
                      borderColor: p.rugFlag ? 'rgba(248,113,113,0.25)' : 'rgba(255,255,255,0.08)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <p style={{ fontSize: '12px', color: '#c4b5fd', fontFamily: 'var(--font-plex-mono)', margin: '0 0 4px' }}>
                            {p.name && p.symbol ? `${p.name} (${p.symbol})` : shortAddr(p.contractAddress)}
                          </p>
                          <p style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                            {p.contractAddress}
                          </p>
                          {p.rugReason && (
                            <p style={{ fontSize: '11px', color: '#f87171', margin: '6px 0 0' }}>· {p.rugReason}</p>
                          )}
                        </div>
                        {p.rugFlag !== null && (
                          <span style={{
                            padding: '3px 10px', borderRadius: '99px',
                            fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em',
                            fontFamily: 'var(--font-plex-mono)',
                            color: p.rugFlag ? '#f87171' : '#2DD4BF',
                            background: p.rugFlag ? 'rgba(248,113,113,0.10)' : 'rgba(45,212,191,0.08)',
                            border: `1px solid ${p.rugFlag ? 'rgba(248,113,113,0.25)' : 'rgba(45,212,191,0.20)'}`,
                          }}>
                            {p.rugFlag ? 'RUG FLAGGED' : 'CLEAN'}
                          </span>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}
      </div>
    </>
  )
}
