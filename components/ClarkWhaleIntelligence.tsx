'use client'

import { useEffect, useState } from 'react'
import type { ClarkWhaleIntelligenceUi } from '@/lib/clarkWhaleUi'

function shortAddress(address: string): string {
  return address.length > 13 ? `${address.slice(0, 7)}…${address.slice(-5)}` : address
}

function formatUsd(value: number | null, status: string, reason: string | null): string {
  if (status === 'unavailable' || value == null) return `USD unavailable: ${reason ?? 'price unavailable'}`
  if (status === 'zero') return '$0 (zero movement)'
  return `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)} ${status}`
}

function formatTime(value: string | null): string {
  if (!value) return 'Unavailable'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Unavailable' : parsed.toLocaleString()
}

function formatRelativeTime(value: string | null): string {
  if (!value) return 'unavailable'
  const ms = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(ms)) return 'unavailable'
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function CopyButton({ value, label, onCopied }: { value: string; label: string; onCopied: () => void }) {
  return (
    <button
      type="button"
      className="clark-whale-copy"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        onCopied()
      }}
    >
      {shortAddress(value)} <span aria-hidden="true">⧉</span>
    </button>
  )
}

export default function ClarkWhaleIntelligence({ data }: { data: ClarkWhaleIntelligenceUi }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <section className="clark-whale-intel" aria-label="Whale intelligence">
      <div className="clark-whale-intel__head">
        <strong>{data.summary}</strong>
        <span className={data.stale ? 'is-stale' : ''}>{data.lastSyncedAt ? `Last synced ${formatRelativeTime(data.lastSyncedAt)}` : 'Last sync unavailable'}</span>
      </div>
      {data.kind === 'flow' ? (
        <div className="clark-whale-grid">
          {(data.flowRows ?? []).map(row => (
            <article className="clark-whale-row" key={row.id}>
              <div className="clark-whale-row__token">
                <strong>{row.token}</strong><span>{row.chain}</span>
                {row.tokenAddress && <CopyButton value={row.tokenAddress} label={`${row.token} contract`} onCopied={() => setCopied(true)} />}
              </div>
              <div><small>Whale</small><strong>{row.walletLabel}</strong>{row.walletAddress && <CopyButton value={row.walletAddress} label="wallet address" onCopied={() => setCopied(true)} />}</div>
              <div><small>Value</small><strong>{formatUsd(row.usdValue, row.usdStatus, row.usdReason)}</strong></div>
              <div><small>Evidence</small><strong>{row.txCount} tx · {row.confidence}</strong><span>{formatTime(row.lastSeen)}</span></div>
            </article>
          ))}
        </div>
      ) : (
        <div className="clark-whale-grid">
          {(data.walletRows ?? []).map(row => (
            <article className="clark-whale-row clark-whale-row--wallet" key={row.id}>
              <div><small>Wallet</small><strong>{row.label}</strong><CopyButton value={row.address} label="wallet address" onCopied={() => setCopied(true)} /></div>
              <div><small>Activity</small><strong>{row.buys} buys · {row.sells} sells</strong><span>{formatTime(row.lastActive)}</span></div>
              <div><small>Portfolio</small><strong>{row.portfolioUsd == null ? 'Unavailable' : formatUsd(row.portfolioUsd, 'estimated', null)}</strong></div>
              <div><small>Confidence</small><strong>{row.confidence}</strong><span>{row.chain}</span></div>
            </article>
          ))}
        </div>
      )}
      {data.syncRecommended && <div className="clark-whale-sync-note">Data is stale/incomplete — sync more wallets for fresher evidence.</div>}
      {copied && <div className="clark-copy-toast" role="status">Copied</div>}
      <style jsx>{`
        .clark-whale-intel{display:grid;gap:10px;margin-top:10px;min-width:0}.clark-whale-intel__head{display:flex;justify-content:space-between;gap:12px;align-items:center;color:#dce7ef;font-size:12px}.clark-whale-intel__head span{color:#7a8a9e;font-size:10px}.clark-whale-intel__head .is-stale{color:#f0b35d}.clark-whale-grid{display:grid;gap:7px}.clark-whale-row{display:grid;grid-template-columns:minmax(140px,1.05fr) minmax(150px,1.15fr) minmax(145px,1fr) minmax(130px,.85fr);gap:10px;padding:10px;border:1px solid rgba(83,243,195,.12);border-radius:10px;background:rgba(7,11,18,.58);min-width:0}.clark-whale-row>div{display:flex;flex-direction:column;gap:3px;min-width:0}.clark-whale-row small{color:#7a8a9e;font-size:9px;text-transform:uppercase;letter-spacing:.09em}.clark-whale-row strong{color:#dfe8f1;font-size:11px;line-height:1.35;overflow-wrap:anywhere}.clark-whale-row span{color:#7a8a9e;font-size:9px}.clark-whale-row__token>strong{color:#53f3c3}.clark-whale-copy{display:inline-flex;align-items:center;gap:4px;width:max-content;max-width:100%;padding:2px 5px;border:1px solid rgba(182,102,243,.22);border-radius:5px;background:rgba(182,102,243,.07);color:#aeb9c8;font:500 9px/1.3 var(--font-plex-mono,monospace);cursor:pointer;overflow:hidden}.clark-whale-copy:hover{border-color:rgba(83,243,195,.4);color:#53f3c3}.clark-whale-sync-note{padding:8px 10px;border-left:2px solid #f0b35d;background:rgba(240,179,93,.06);color:#c7b38e;font-size:10px}.clark-copy-toast{position:fixed;right:22px;bottom:22px;z-index:1000;padding:8px 12px;border:1px solid rgba(83,243,195,.35);border-radius:8px;background:#0c1719;color:#53f3c3;font-size:11px;box-shadow:0 8px 28px rgba(0,0,0,.35)}@media(max-width:760px){.clark-whale-row{grid-template-columns:1fr 1fr}.clark-whale-intel__head{align-items:flex-start;flex-direction:column;gap:3px}}@media(max-width:430px){.clark-whale-row{grid-template-columns:1fr}.clark-whale-intel{width:100%;overflow:hidden}}
      `}</style>
    </section>
  )
}
