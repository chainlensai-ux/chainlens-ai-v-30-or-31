// Portfolio Intelligence card — compact stat grid shown under the Wallet Overview header's
// portfolio value. Additive, presentation-only; every value is real or a direct arithmetic
// derivation of real data.
//
// HONESTY NOTE: does NOT include an "Instant Wallet Score" or "Estimated PnL" panel (both were
// requested from a reference screenshot). Those reproduce the old legacy profiler's estimation
// pattern this project explicitly banned (estimatedPnl, wallet-score-style verdicts on unverified
// samples) — the real, honest equivalent already exists as PnLTab (real fifoAndPnl/pnlSummaryV2).
// Concentration is computed here client-side from report.portfolio.tokens (real, priced token
// list) using behaviorIntel's own concentrationLabelFor thresholds for consistency — the
// backend's own behaviorIntel.concentrationSignals is currently always null in the real pipeline
// (src/pipeline/index.ts still passes `holdings: []` into buildBehaviorIntelObject), so computing
// it here from the same real portfolio data is the only way to show it honestly today. Chain
// Exposure lists only chains this engine actually supports/scanned
// (scanMetadata.chainsScanned) — never a fabricated list of unsupported chains
// (Optimism/Plasma/Monad/Unichain/BSC etc. do not exist in this engine).
import { concentrationLabelFor } from '@/src/modules/behaviorIntel/utils'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { ChainBadge } from './ChainBadge'

export type PortfolioIntelligenceCardProps = {
  portfolio: PortfolioSummary | null | undefined
  chainsScanned: SupportedChain[] | null | undefined
  activeChain?: SupportedChain | null
}

function deriveConcentration(tokens: PortfolioSummary['tokens']): { label: string; detail: string } | null {
  const priced = tokens.filter((t) => t.valueUsd != null && t.valueUsd > 0)
  const totalValue = priced.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0)
  if (priced.length === 0 || totalValue <= 0) return null

  const top = [...priced].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))[0]
  const percent = ((top.valueUsd ?? 0) / totalValue) * 100
  const label = concentrationLabelFor(percent)
  const labelText: Record<string, string> = { high: 'High concentration', medium: 'Medium concentration', balanced: 'Balanced' }

  return { label: labelText[label] ?? 'Balanced', detail: `${top.symbol} · ${percent.toFixed(0)}% of portfolio` }
}

function topHoldingsChips(tokens: PortfolioSummary['tokens']): { symbol: string; percent: number }[] {
  const priced = tokens.filter((t) => t.valueUsd != null && t.valueUsd > 0)
  const totalValue = priced.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0)
  if (priced.length === 0 || totalValue <= 0) return []

  return [...priced]
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
    .slice(0, 3)
    .map((t) => ({ symbol: t.symbol, percent: ((t.valueUsd ?? 0) / totalValue) * 100 }))
}

// Fixed minHeight + consistent label/value/sub sizing so all three stat boxes read as one unified
// set regardless of how much (or little) content each one has.
function StatBox({ label, value, sub, valueColor }: { label: string; value: React.ReactNode; sub?: string; valueColor?: string }) {
  return (
    <div style={{
      flex: '1 1 180px', minWidth: '160px', minHeight: '82px', padding: '14px 16px', borderRadius: '13px',
      background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
    }}>
      <div style={{ fontSize: '9px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.72)', marginBottom: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {label}
      </div>
      <div style={{ fontSize: '18px', fontWeight: 800, color: valueColor ?? '#e2e8f0', lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.60)', marginTop: '4px', minHeight: '14px' }}>{sub ?? ' '}</div>
    </div>
  )
}

export function PortfolioIntelligenceCard({ portfolio, chainsScanned, activeChain }: PortfolioIntelligenceCardProps) {
  const tokens = Array.isArray(portfolio?.tokens) ? portfolio!.tokens : []
  const pricedTokenCount = tokens.filter((t) => t.valueUsd != null && t.valueUsd > 0).length
  const totalValueUsd = portfolio?.totalValueUsd ?? null
  const concentration = deriveConcentration(tokens)
  const topChips = topHoldingsChips(tokens)
  const chains = Array.isArray(chainsScanned) ? chainsScanned : []

  return (
    <div style={{
      padding: '18px 20px', borderRadius: '16px', background: 'rgba(255,255,255,0.015)',
      border: '1px solid rgba(255,255,255,0.06)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <span style={{ width: '6px', height: '14px', borderRadius: '3px', background: '#2DD4BF', display: 'inline-block' }} />
        <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#e2e8f0' }}>Portfolio Intelligence</span>
        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#4ade80', border: '1px solid rgba(74,222,128,0.3)', borderRadius: '999px', padding: '2px 8px', boxShadow: '0 0 12px rgba(74,222,128,0.20)' }}>
          Active
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'rgba(148,163,184,0.45)' }}>multi-chain holdings</span>
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <StatBox label="Total Value" value={totalValueUsd != null ? fmtUsd(totalValueUsd) : 'Not available'} valueColor="#2DD4BF" />
        <StatBox label="Priced Tokens" value={pricedTokenCount} sub="Zero/unpriced tokens excluded" />
        <StatBox
          label="Concentration"
          value={concentration ? concentration.label : 'Not available'}
          sub={concentration ? concentration.detail : 'No priced tokens to assess'}
          valueColor={concentration ? '#c4b5fd' : undefined}
        />
      </div>

      {topChips.length > 0 && (
        <div style={{ marginBottom: '22px' }}>
          <div style={{ fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.50)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            Top Holdings
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {topChips.map((c) => (
              <span key={c.symbol} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', fontSize: '12px', fontWeight: 700, color: '#e2e8f0' }}>
                {c.symbol}
                <span style={{ fontSize: '10px', color: 'rgba(45,212,191,0.85)' }}>{c.percent.toFixed(0)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {chains.length > 0 && (
        <div>
          <div style={{ fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.50)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            Chain Exposure
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {chains.map((chain) => (
              <span key={chain} style={{ opacity: activeChain && chain !== activeChain ? 0.6 : 1 }}>
                <ChainBadge chain={chain} />
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default PortfolioIntelligenceCard
