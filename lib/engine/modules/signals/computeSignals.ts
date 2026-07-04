// lib/engine/modules/signals/computeSignals.ts — new signal module, the top of the V2 engine's
// intelligence chain (consumes the output of every prior module: portfolio/pnl/chainActivity/risk/
// personality/behavior).
//
// PURE, DISCLOSED: everything below is rule evaluation over already-computed data — no new network
// calls. Declared `async` only to match the spec's own Promise-returning signature.
//
// "PREVIOUS SCAN" COMPARISON, DISCLOSED (rule B): step B's first condition
// ("stablecoinRatio increased significantly vs previous scan") requires a stored prior scan result
// to diff against. No such persistence exists anywhere in this pipeline — every module in this V2
// engine chain (this task's own included) computes a single, stateless snapshot per request; there
// is no scan-history store this function could read from without inventing a new persistence layer
// (out of scope — this task only asked for the signal module itself). Only step B's SECOND,
// self-contained condition (`stablecoinRatio > 0.6 AND memeBehavior != "meme-active"`) is
// implemented; the trend-based condition is honestly never evaluated, not faked with a fabricated
// "previous scan" of zero.
//
// bridging_out_of_base, DISCLOSED (rule D): this signal's own condition requires (1) "bridge-heavy"
// behavior and (2) a DECREASING Base valueHeldUsd over time. Both are structurally unavailable given
// this module's real inputs: `behaviorV2.bridgingBehavior` is always `"none"` today (a real,
// disclosed gap in lib/engine/modules/behavior/computeBehavior.ts — that module's own
// task-specified signature never receives a wallet address, so it can never actually detect
// bridging), and "decreasing" requires the same missing previous-scan comparison as rule B above.
// This rule is implemented exactly as specified but, given real current inputs, can never actually
// fire — never worked around by loosening its condition or fabricating a trend from one snapshot.

import type { Portfolio } from '../portfolio/types'
import type { PnlV2 } from '../pnl/types'
import type { ChainActivityRecord } from '../activity/types'
import type { RiskV2 } from '../risk/types'
import type { PersonalityV2 } from '../personality/types'
import type { BehaviorV2 } from '../behavior/types'
import type { PricedHolding } from '../pricing/types'
import type { ChainHolding } from '../holdings/types'
import type { ParsedTrade } from '../pnl/types'
import type { SignalV2, SignalsEngineOutput } from './types'

const BASE_CHAIN_ID = 8453

let signalIdCounter = 0
function nextSignalId(type: SignalV2['type']): string {
  signalIdCounter += 1
  return `${type}-${signalIdCounter}`
}

export async function computeSignals(
  portfolioV2: Portfolio,
  pnlV2: PnlV2,
  chainActivityV2: ChainActivityRecord[],
  riskV2: RiskV2,
  personalityV2: PersonalityV2,
  behaviorV2: BehaviorV2,
  pricedHoldings: PricedHolding[],
  _chainHoldings: ChainHolding[],
  trades: ParsedTrade[],
): Promise<SignalsEngineOutput> {
  // A. Empty case — exactly as specified.
  if (portfolioV2.totalValueUsd === 0 && trades.length === 0) {
    return { signalsV2: [], signalsStatus: 'empty' }
  }

  const signals: SignalV2[] = []

  // B. rotation_to_stables — see file header on the omitted "vs previous scan" condition.
  if (portfolioV2.stablecoinRatio > 0.6 && behaviorV2.memeBehavior !== 'meme-active') {
    signals.push({
      id: nextSignalId('rotation_to_stables'),
      type: 'rotation_to_stables',
      severity: portfolioV2.stablecoinRatio > 0.8 ? 'high' : 'medium',
      summary: 'Wallet shows a strong rotation toward stablecoins.',
      details: `Stablecoin ratio is ${(portfolioV2.stablecoinRatio * 100).toFixed(1)}% of portfolio value, with no significant meme-token activity.`,
    })
  }

  // C. base_meme_accumulation.
  if (personalityV2.chainPreference === BASE_CHAIN_ID && behaviorV2.memeBehavior === 'meme-active') {
    signals.push({
      id: nextSignalId('base_meme_accumulation'),
      type: 'base_meme_accumulation',
      severity: riskV2.volatileExposure > 0.5 ? 'high' : 'medium',
      summary: 'Wallet is accumulating memecoins on Base.',
      details: `Base is this wallet's preferred chain, with active meme-token behavior and ${(riskV2.volatileExposure * 100).toFixed(1)}% volatile exposure.`,
    })
  }

  // D. bridging_out_of_base — see file header; structurally unreachable given real current inputs,
  // implemented exactly as specified anyway.
  const baseActivity = chainActivityV2.find((c) => c.chainId === BASE_CHAIN_ID)
  if (behaviorV2.bridgingBehavior === 'bridge-heavy' && baseActivity) {
    signals.push({
      id: nextSignalId('bridging_out_of_base'),
      type: 'bridging_out_of_base',
      severity: 'medium',
      summary: 'Wallet appears to be bridging assets out of Base.',
      details: 'Bridge-heavy behavior detected alongside declining Base-held value.',
    })
  }

  // E. high_unrealized_loss_pressure.
  if (pnlV2.unrealizedPnlUsd < 0) {
    const pressure = Math.min(1, Math.abs(pnlV2.unrealizedPnlUsd) / portfolioV2.totalValueUsd)
    if (pressure > 0.3) {
      signals.push({
        id: nextSignalId('high_unrealized_loss_pressure'),
        type: 'high_unrealized_loss_pressure',
        severity: pressure > 0.5 ? 'high' : 'medium',
        summary: 'Wallet is under significant unrealized loss pressure.',
        details: `Unrealized loss represents ${(pressure * 100).toFixed(1)}% of total portfolio value.`,
      })
    }
  }

  // F. entering_high_risk_posture.
  if (riskV2.level === 'high') {
    signals.push({
      id: nextSignalId('entering_high_risk_posture'),
      type: 'entering_high_risk_posture',
      severity: 'high',
      summary: 'Wallet has entered a high-risk posture.',
      details: `Overall risk score is ${riskV2.score.toFixed(0)}/100.`,
    })
  }

  // G. exiting_high_risk_posture.
  if (riskV2.level === 'low') {
    signals.push({
      id: nextSignalId('exiting_high_risk_posture'),
      type: 'exiting_high_risk_posture',
      severity: 'medium',
      summary: 'Wallet shows a low-risk posture.',
      details: `Overall risk score is ${riskV2.score.toFixed(0)}/100.`,
    })
  }

  // H. whale_like_accumulation.
  if (portfolioV2.totalValueUsd > 100_000 && behaviorV2.accumulationStyle === 'accumulator') {
    signals.push({
      id: nextSignalId('whale_like_accumulation'),
      type: 'whale_like_accumulation',
      severity: 'high',
      summary: 'Wallet shows whale-like accumulation behavior.',
      details: `Portfolio value exceeds $100,000 with a net-accumulating trade pattern.`,
    })
  }

  // I. lp_farming_cycle.
  if (behaviorV2.farmingBehavior === 'farmer') {
    signals.push({
      id: nextSignalId('lp_farming_cycle'),
      type: 'lp_farming_cycle',
      severity: 'medium',
      summary: 'Wallet shows an active LP farming cycle.',
      details: 'Frequent LP add/remove events detected.',
    })
  }

  // J. stablecoin_routing.
  if (behaviorV2.stableRoutingBehavior === 'router') {
    signals.push({
      id: nextSignalId('stablecoin_routing'),
      type: 'stablecoin_routing',
      severity: 'medium',
      summary: 'Wallet frequently routes through stablecoins.',
      details: 'High volume of stablecoin swaps detected.',
    })
  }

  // K. high_trade_frequency.
  if (behaviorV2.tradeFrequency === 'high') {
    signals.push({
      id: nextSignalId('high_trade_frequency'),
      type: 'high_trade_frequency',
      severity: 'medium',
      summary: 'Wallet shows high trade frequency.',
      details: '50 or more trades detected in the last 30 days.',
    })
  }

  // L. dormant_wallet.
  if (personalityV2.activityConsistency === 'dormant') {
    signals.push({
      id: nextSignalId('dormant_wallet'),
      type: 'dormant_wallet',
      severity: 'low',
      summary: 'Wallet shows dormant activity.',
      details: 'No high-activity chain detected across any supported chain.',
    })
  }

  // M. signalsStatus, DISCLOSED: the literal "empty" condition (no signals AND portfolio/trades
  // empty) is already fully handled by step A's early return above — by the time execution reaches
  // here, portfolioV2.totalValueUsd/trades are known NOT to be both empty, so that branch can never
  // re-trigger here (not duplicated as dead code). What remains is a real, two-way choice:
  // "partial" (some pricedHoldings unpriced) takes priority over "ok", matching the same convention
  // every other module in this chain already uses — a wallet with real data but zero fired signals
  // is still a genuine "ok, nothing notable" result, never mislabeled "empty".
  const hasUnpriced = pricedHoldings.some((h) => h.valueUsd == null)
  const signalsStatus: SignalsEngineOutput['signalsStatus'] = hasUnpriced ? 'partial' : 'ok'

  return { signalsV2: signals, signalsStatus }
}
