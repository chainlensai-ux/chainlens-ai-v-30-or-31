'use client'

// LiquidityProviderCard — shown when a wallet mainly provides liquidity or holds open LP positions.
// Everything comes from buildLiquidityProviderView (app/frontend/lib/liquidityProviderView.ts).
import type { LiquidityProviderView } from '@/app/frontend/lib/liquidityProviderView'
import { fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'

const ACCENT = '#1fd6dc'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: '1 1 140px', minWidth: '120px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgba(158,161,164,0.9)' }}>{label}</div>
      <div style={{ marginTop: '4px', fontSize: '18px', fontWeight: 700, color: '#e4e7ea', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

export function LiquidityProviderCard({ view }: { view: LiquidityProviderView }) {
  return (
    <div
      style={{
        marginBottom: '16px', padding: '16px 20px', borderRadius: '16px',
        background: `linear-gradient(160deg, ${ACCENT}12, rgba(7,10,13,0.95))`,
        border: '1px solid rgba(255,255,255,0.08)', borderTop: `2px solid ${ACCENT}66`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: ACCENT }}>Liquidity provider</span>
        {view.liquiditySharePct != null && view.lpStrategyWallet && (
          <span style={{ fontSize: '12px', color: 'rgba(209,212,215,0.85)' }}>
            {view.liquiditySharePct}% of this wallet&apos;s transactions add or remove liquidity
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px' }}>
        <Stat label="Open LP positions" value={view.positionsValueUsd != null ? fmtUsd(view.positionsValueUsd) : '—'} />
        <Stat label="Wallet + LP positions" value={view.totalWithPositionsUsd != null ? fmtUsd(view.totalWithPositionsUsd) : '—'} />
        <Stat label="Positions" value={String(view.openPositions)} />
        <Stat label="Deposits / withdrawals" value={`${view.deposits} / ${view.withdrawals}`} />
      </div>
      {view.feeIncome && (
        <div style={{ marginTop: '14px', padding: '12px 14px', borderRadius: '12px', background: 'rgba(31,214,220,0.07)', border: `1px solid ${ACCENT}33` }}>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgba(158,161,164,0.9)' }}>LP fee income · realized</div>
          <div style={{ marginTop: '4px', fontSize: '20px', fontWeight: 700, color: '#3ee08f', fontVariantNumeric: 'tabular-nums' }}>
            {fmtUsd(view.feeIncome.realizedUsd)}
            {view.feeIncome.realizedNative != null && view.feeIncome.realizedNative > 0 && (
              <span style={{ marginLeft: '8px', fontSize: '13px', fontWeight: 600, color: 'rgba(209,212,215,0.85)' }}>{view.feeIncome.realizedNative.toFixed(4)} ETH</span>
            )}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: '12.5px', lineHeight: 1.5, color: 'rgba(209,212,215,0.8)' }}>{view.feeIncome.note}</p>
        </div>
      )}
      <p style={{ margin: '12px 0 0', fontSize: '12.5px', lineHeight: 1.5, color: 'rgba(209,212,215,0.8)' }}>
        Deposits into and withdrawals from liquidity pools are not trades, so they are left out of PnL, which covers swaps only.
        {view.feeIncome ? ' LP fee income above is reported separately and is not part of trading PnL.' : ' LP fees and rewards are not part of PnL.'} Position values use current token prices.
        {view.positionsNote ? ` ${view.positionsNote}` : ''}
      </p>
    </div>
  )
}

export default LiquidityProviderCard
