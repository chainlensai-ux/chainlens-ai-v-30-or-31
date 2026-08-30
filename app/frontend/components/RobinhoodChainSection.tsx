'use client'

// ROBINHOOD CHAIN SECTION, RELOCATED DISCLOSURE (split-Wallet-Scanner-results fix task): this
// component (and the RobinhoodWalletScanResponse type / ROBINHOOD_CHAIN_META constant it needs) used
// to live inline in app/terminal/wallet-scanner/page.tsx and was rendered there as its OWN, separate
// top-level card — producing a second, conflicting portfolio total alongside the real multi-chain
// Wallet Scanner result for the same wallet (confirmed live bug: $2.25 V2-only total shown next to a
// real, nonzero Robinhood total on the same page). Moved to its own file, unchanged in every other
// respect, so it can be rendered as ONE MORE CHAIN TAB inside the SAME Wallet Scanner result model
// (WalletScannerTabsV3.tsx) instead of a second competing card — see that file and
// app/frontend/lib/mergedWalletView.ts for the merge this enables. Every number here is still read
// directly off the real RobinhoodWalletScanResponse the route already computed
// (lib/server/robinhoodWalletScanner.ts) — nothing is derived, guessed, or recomputed client-side, and
// PnL is shown exactly as gated server-side (never upgraded from activity/transfer volume here). The
// optional raw-JSON block only ever renders when the page was loaded with ?debug=true.
import { ChainBadge } from './ChainBadge'
import { PnLHeaderCard } from './PnLHeaderCard'
import { StatusBadge, type StatusTone } from './StatusBadge'

// Mirrors the JSON shape GET /api/wallet-scan/robinhood returns (see
// lib/server/robinhoodWalletScanner.ts). Deliberately untyped against the V2 pipeline's
// WalletV2Report — Robinhood does not run through that pipeline.
export type RobinhoodWalletScanResponse = {
  ok: boolean
  wallet: string
  chainSlug: 'robinhood'
  chainId: number
  holdings: {
    status: 'ok' | 'partial' | 'unavailable' | 'not_configured'
    native: { symbol: string; uiBalance: number | null; priceUsd: number | null; valueUsd: number | null } | null
    holdings: Array<{ address: string; symbol: string | null; name: string | null; uiBalance: number | null; priceUsd: number | null; valueUsd: number | null; priceSource: string | null }>
    portfolioTotalUsd: number | null
    unpricedTokenCount: number
    reason: string | null
  }
  activity: {
    status: 'ok' | 'partial' | 'unavailable' | 'not_configured'
    items: Array<{ txHash: string; blockTimestamp: string | null; kind: 'native_transfer' | 'token_transfer'; direction: 'incoming' | 'outgoing'; counterparty: string | null; tokenSymbol: string | null }>
    skippedSwapLogs: number
    // Count of swap logs that reached confidence 'high' (real token identities AND real price
    // evidence on both legs) — the only swaps ever fed into PnL below.
    verifiedSwapCount: number
    // Real, per-scan outcome of every Blockscout call this scan made (explorer fallback/proof layer
    // only — see lib/server/robinhoodBlockscoutEvidence.ts's own header). Never itself a PnL signal —
    // only ever surfaced as an activity-evidence status line.
    blockscoutEvidence: {
      blockscoutAttempted: boolean
      blockscoutSucceeded: boolean
      blockscoutFallbackUsed: boolean
      blockscoutStatus: 'ok' | 'unavailable' | 'not_configured' | 'rate_limited' | 'not_attempted'
      blockscoutError: string | null
      blockscoutVerifiedSwap: boolean
    }
    reason: string | null
  }
  // status reflects the real, per-scan outcome ('disabled' when zero verified swaps exist, 'partial'
  // for a thin-but-real sample, 'verified' when FIFO produced a publicly-reportable result) — never a
  // single fixed "not verified" placeholder.
  pnl: {
    status: 'disabled' | 'partial' | 'verified'
    message: string
    realizedPnlUsd: number | null
    matchedLotsCount: number
    verifiedSwapCount: number
    reason: string | null
  }
  robinhoodWalletScannerAudit: Record<string, unknown>
}

// The display identity Robinhood Chain uses everywhere — chainSlug/chainId/label — used only by
// ChainBadge/labels. This is presentational only; it does NOT add 'robinhood' to SupportedChain,
// SUPPORTED_CHAINS, or any V2 pipeline type (see lib/server/robinhoodWalletScanner.ts's own header
// for why that stays a deliberately separate module/route — Base/ETH/BNB's shared pipeline is
// untouched by this or any other Robinhood work).
export const ROBINHOOD_CHAIN_META = { chainSlug: 'robinhood' as const, chainId: 4663, label: 'Robinhood Chain' }

function robinhoodLastActivityTimestamp(items: RobinhoodWalletScanResponse['activity']['items']): string | null {
  const timestamps = items.map((i) => i.blockTimestamp).filter((t): t is string => t != null)
  if (timestamps.length === 0) return null
  return timestamps.reduce((latest, t) => (new Date(t).getTime() > new Date(latest).getTime() ? t : latest))
}

export function RobinhoodChainSection({
  result, onRescan, rescanLoading, debugMode,
}: {
  result: RobinhoodWalletScanResponse
  onRescan: () => void
  rescanLoading: boolean
  debugMode: boolean
}) {
  const { holdings, activity, pnl } = result
  const notConfigured = holdings.status === 'not_configured'
  const tokenCount = holdings.holdings.length
  const unpricedCount = holdings.unpricedTokenCount
  const pricedCount = Math.max(0, tokenCount - unpricedCount)
  // "Vacuously fully covered" when there are no token holdings at all to price — same convention
  // this codebase's own derivePublicPnlStatus/coverage-ratio helpers already use elsewhere.
  const pricingCoveragePercent = tokenCount > 0 ? Math.round((pricedCount / tokenCount) * 100) : 100
  const lastActivity = robinhoodLastActivityTimestamp(activity.items)
  const pnlLabel = pnl.status === 'verified' ? 'Verified Robinhood PnL' : 'PnL: Not verified yet'
  const pnlTone: StatusTone = pnl.status === 'verified' ? 'success' : pnl.status === 'partial' ? 'warning' : 'neutral'
  const blockscout = activity.blockscoutEvidence
  const providerErrors = [
    holdings.reason ? `Holdings: ${holdings.reason}` : null,
    activity.reason ? `Activity: ${activity.reason}` : null,
    blockscout?.blockscoutError ? `Blockscout: ${blockscout.blockscoutError}` : null,
  ].filter((v): v is string => v != null)

  return (
    <div className="ws-result-fade">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ChainBadge chain={ROBINHOOD_CHAIN_META.chainSlug} />
          <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            chainId {result.chainId} · {result.wallet}
          </span>
        </div>
        <button
          onClick={onRescan}
          disabled={rescanLoading}
          style={{
            padding: '5px 12px', borderRadius: '7px', border: '1px solid rgba(148,163,184,0.25)',
            background: 'rgba(255,255,255,0.03)', color: 'rgba(226,232,240,0.75)',
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            cursor: rescanLoading ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          }}
        >
          {rescanLoading ? 'Rescanning…' : 'Rescan'}
        </button>
      </div>

      {notConfigured ? (
        <p style={{ fontSize: '13px', color: 'rgba(148,163,184,0.75)', margin: 0 }}>Robinhood Chain is not configured on this deployment.</p>
      ) : (
        <>
          {/* SUMMARY CARDS: Total value / Native ETH / Priced holdings / Unpriced holdings / Pricing
              coverage / PnL status. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '18px' }}>
            <PnLHeaderCard label="Total Value" value={holdings.portfolioTotalUsd != null ? `$${holdings.portfolioTotalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'} tone="neutral" index={0} />
            <PnLHeaderCard label="Native ETH" value={holdings.native?.uiBalance != null ? holdings.native.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'} tone="neutral" index={1} />
            <PnLHeaderCard label="Priced Holdings" value={String(pricedCount)} tone="neutral" index={2} />
            <PnLHeaderCard label="Unpriced Holdings" value={String(unpricedCount)} tone={unpricedCount > 0 ? 'negative' : 'neutral'} index={3} />
            <PnLHeaderCard label="Pricing Coverage" value={`${pricingCoveragePercent}%`} tone={pricingCoveragePercent === 100 ? 'positive' : 'neutral'} index={4} />
            <PnLHeaderCard label="PnL Status" value={pnl.status === 'verified' ? 'Verified' : pnl.status === 'partial' ? 'Partial' : 'Not verified'} tone={pnl.status === 'verified' ? 'positive' : 'neutral'} index={5} />
          </div>

          {/* HOLDINGS TABLE: Token / Balance / Price / Value / Pricing status / Source — a real table,
              never a raw stacked list. */}
          {(holdings.native || tokenCount > 0) && (
            <div style={{ marginBottom: '16px', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'rgba(148,163,184,0.55)', fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    <th style={{ padding: '6px 10px' }}>Token</th>
                    <th style={{ padding: '6px 10px' }}>Balance</th>
                    <th style={{ padding: '6px 10px' }}>Price</th>
                    <th style={{ padding: '6px 10px' }}>Value</th>
                    <th style={{ padding: '6px 10px' }}>Pricing Status</th>
                    <th style={{ padding: '6px 10px' }}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.native && (
                    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{holdings.native.symbol}</td>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: '#cbd5e1' }}>{holdings.native.uiBalance != null ? holdings.native.uiBalance.toFixed(6) : '—'}</td>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: '#cbd5e1' }}>{holdings.native.priceUsd != null ? `$${holdings.native.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : '—'}</td>
                      <td style={{ padding: '9px 10px', color: holdings.native.valueUsd == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>{holdings.native.valueUsd != null ? `$${holdings.native.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}</td>
                      <td style={{ padding: '9px 10px' }}><StatusBadge label={holdings.native.priceUsd != null ? 'Priced' : 'Unpriced'} tone={holdings.native.priceUsd != null ? 'success' : 'warning'} /></td>
                      <td style={{ padding: '9px 10px', color: 'rgba(148,163,184,0.65)' }}>{holdings.native.priceUsd != null ? 'GoldRush' : '—'}</td>
                    </tr>
                  )}
                  {holdings.holdings.map((h) => (
                    <tr key={h.address} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{h.symbol ?? `${h.address.slice(0, 6)}…${h.address.slice(-4)}`}</td>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: '#cbd5e1' }}>{h.uiBalance != null ? h.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}</td>
                      <td style={{ padding: '9px 10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: '#cbd5e1' }}>{h.priceUsd != null ? `$${h.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : '—'}</td>
                      <td style={{ padding: '9px 10px', color: h.valueUsd == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>{h.valueUsd != null ? `$${h.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}</td>
                      <td style={{ padding: '9px 10px' }}><StatusBadge label={h.priceUsd != null ? 'Priced' : 'Unpriced'} tone={h.priceUsd != null ? 'success' : 'warning'} /></td>
                      <td style={{ padding: '9px 10px', color: 'rgba(148,163,184,0.65)', textTransform: 'capitalize' }}>{h.priceSource ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* WARNING CARD: exact wording — shown only when unpriced tokens are real (unpricedCount >
              0), never a fabricated warning. */}
          {unpricedCount > 0 && (
            <div style={{ marginBottom: '14px', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(251,191,36,0.32)', background: 'rgba(251,191,36,0.06)' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#fbbf24' }}>
                {unpricedCount} token{unpricedCount === 1 ? '' : 's'} could not be priced
              </div>
              <div style={{ marginTop: '4px', fontSize: '11px', color: 'rgba(251,191,36,0.75)' }}>
                These tokens are included in holdings but excluded from portfolio value until pricing is available.
              </div>
            </div>
          )}

          {/* ACTIVITY CARD: kept visually and textually separate from the PnL card below — never
              merged into one line, never implying activity volume is a PnL signal. */}
          <div style={{ marginBottom: '12px', padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
            <div className="ws-section-header" style={{ color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontSize: '10px' }}>Activity (not PnL)</div>
            <p style={{ fontSize: '12px', color: 'rgba(226,232,240,0.80)', margin: '0 0 8px' }}>
              {activity.status === 'ok'
                ? `${activity.items.length} token transfer${activity.items.length === 1 ? '' : 's'} found — transfers only, not classified as trades.`
                : `No activity data available${activity.reason ? ` (${activity.reason})` : ''}.`}
            </p>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
              <span>Verified Robinhood swaps: <strong style={{ color: '#e2e8f0' }}>{activity.verifiedSwapCount}</strong></span>
              <span>Skipped unsupported swap logs: <strong style={{ color: '#e2e8f0' }}>{activity.skippedSwapLogs}</strong></span>
              {lastActivity && (
                <span>Last activity: <strong style={{ color: '#e2e8f0' }}>{new Date(lastActivity).toLocaleString()}</strong></span>
              )}
            </div>
          </div>

          {/* PNL CARD: exact wording on both the disabled and verified paths. Realized/unrealized
              figures only ever come from the gated FIFO output (pnl.realizedPnlUsd) — never derived
              from activity items here. Kept out of, and never mixed into, the portfolio value line. */}
          <div style={{
            marginBottom: '12px', padding: '12px 14px', borderRadius: '10px',
            border: pnl.status === 'verified' ? '1px solid rgba(45,212,191,0.35)' : '1px solid rgba(148,163,184,0.18)',
            background: pnl.status === 'verified' ? 'rgba(45,212,191,0.06)' : 'rgba(255,255,255,0.02)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <StatusBadge label={pnl.status === 'verified' ? 'Verified' : 'Not verified'} tone={pnlTone} />
              <span style={{ fontSize: '13px', fontWeight: 800, color: pnl.status === 'verified' ? '#2DD4BF' : '#e2e8f0' }}>{pnlLabel}</span>
            </div>
            {pnl.status === 'verified' ? (
              <div style={{ fontSize: '12px', color: 'rgba(226,232,240,0.80)' }}>
                Realized: {pnl.realizedPnlUsd != null ? `$${pnl.realizedPnlUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 'n/a'} · {pnl.matchedLotsCount} matched lot{pnl.matchedLotsCount === 1 ? '' : 's'}
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
                Robinhood PnL not verified yet — requires verified swap logs and both-leg price evidence.
              </div>
            )}
          </div>

          {/* EVIDENCE CARD: real, measured provider status only — GoldRush/Alchemy RPC/Blockscout
              fallback — never raw API payloads. */}
          <div style={{ padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
            <div className="ws-section-header" style={{ color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontSize: '10px' }}>Evidence</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
              <StatusBadge label={`GoldRush: ${holdings.status}`} tone={holdings.status === 'ok' ? 'success' : holdings.status === 'partial' ? 'warning' : holdings.status === 'not_configured' ? 'neutral' : 'danger'} />
              <StatusBadge label={`Alchemy RPC: ${holdings.native ? 'ok' : 'unavailable'}`} tone={holdings.native ? 'success' : 'neutral'} />
              {/* EXACT WORDING: "Explorer fallback used" / "Blockscout unavailable" / "Swap logs
                  verified by explorer" are the fixed wordings the Blockscout integration task
                  required — kept verbatim here as the badge label rather than invented anew. */}
              <StatusBadge
                label={
                  blockscout?.blockscoutVerifiedSwap ? 'Swap logs verified by explorer'
                    : blockscout?.blockscoutFallbackUsed ? 'Explorer fallback used'
                      : blockscout?.blockscoutAttempted && !blockscout.blockscoutSucceeded ? 'Blockscout unavailable'
                        : 'Blockscout: not used'
                }
                tone={blockscout?.blockscoutVerifiedSwap ? 'success' : blockscout?.blockscoutFallbackUsed ? 'info' : blockscout?.blockscoutAttempted && !blockscout.blockscoutSucceeded ? 'warning' : 'neutral'}
              />
            </div>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
              <span>verifiedSwapCount: {activity.verifiedSwapCount}</span>
              <span>skippedSwapLogs: {activity.skippedSwapLogs}</span>
              <span>blockscoutFallbackUsed: {String(blockscout?.blockscoutFallbackUsed ?? false)}</span>
            </div>
            {providerErrors.length > 0 && (
              <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', color: '#f87171' }}>
                {providerErrors.map((e) => <span key={e}>{e}</span>)}
              </div>
            )}
          </div>

          {/* DEBUG-ONLY RAW VIEW: only rendered with ?debug=true — never the default page. */}
          {debugMode && (
            <details style={{ marginTop: '14px' }}>
              <summary style={{ cursor: 'pointer', fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>Raw response (debug)</summary>
              <pre style={{ fontSize: '10px', color: 'rgba(148,163,184,0.65)', overflowX: 'auto', marginTop: '8px', whiteSpace: 'pre-wrap' }}>{JSON.stringify(result, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}

export default RobinhoodChainSection
