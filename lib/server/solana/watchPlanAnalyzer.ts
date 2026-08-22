// SOLANA WATCH PLAN, DISCLOSED (Dev Intelligence "Watch Plan" tab follow-up task).
//
// Generates dynamic monitoring recommendations — every item is triggered by, and cites, real
// evidence already gathered elsewhere in the scan (mint/freeze authority, extensions, holder
// concentration, liquidity, pool program, deep creator trace). No new provider calls are made
// here; this is a pure read of already-collected evidence. An empty list (no active risk signals
// found in available evidence) is returned honestly rather than padded with generic advice.

import type { SolanaSupplyControl } from './supplyControlAnalyzer.ts'
import type { SolanaPoolProgram, SolanaMarketData } from './types.ts'
import type { SolanaDeepCreatorAnalysis } from './deepCreatorAnalyzer.ts'

export type SolanaWatchItem = {
  item: string
  reason: string
}

const HIGH_CONCENTRATION_THRESHOLD_PCT = 20
const LOW_LIQUIDITY_THRESHOLD_USD = 25_000

export function buildSolanaWatchPlan(input: {
  supplyControl: SolanaSupplyControl
  top1Percent: number | null
  top10Percent: number | null
  marketData: SolanaMarketData | null
  poolProgram: SolanaPoolProgram
  deepCreator: SolanaDeepCreatorAnalysis | null
}): SolanaWatchItem[] {
  const { supplyControl, top1Percent, top10Percent, marketData, poolProgram, deepCreator } = input
  const items: SolanaWatchItem[] = []

  if (supplyControl.mintAuthority) {
    items.push({
      item: 'Monitor mint authority activity',
      reason: `Mint authority ${supplyControl.mintAuthority} is still active — watch for new mint transactions from this wallet, which would increase supply beyond the current total.`,
    })
  }

  if (supplyControl.freezeAuthority) {
    items.push({
      item: 'Monitor freeze authority activity',
      reason: `Freeze authority ${supplyControl.freezeAuthority} is still active — this wallet can freeze any holder's token account at any time, blocking their ability to transfer.`,
    })
  }

  for (const ext of supplyControl.extensions) {
    if (ext.type === 'permanentDelegate') {
      const delegate = typeof ext.state?.delegate === 'string' ? ext.state.delegate : 'the configured delegate wallet';
      items.push({ item: 'Monitor permanent delegate activity', reason: `${delegate} can transfer or burn tokens from any holder's account without their signature — watch for unexpected transfers/burns from this wallet.` })
    }
    if (ext.type === 'transferHook') {
      const programId = typeof ext.state?.programId === 'string' ? ext.state.programId : 'the configured program';
      items.push({ item: 'Monitor transfer hook program', reason: `Every transfer invokes external program ${programId} — a change to that program's logic could alter or block transfers outside this engine's visibility.` })
    }
    if (ext.type === 'mintCloseAuthority') {
      items.push({ item: 'Monitor mint close authority', reason: 'This mint can be closed once supply reaches zero — relevant if supply is being wound down toward zero.' })
    }
  }

  if (top1Percent != null && top1Percent >= HIGH_CONCENTRATION_THRESHOLD_PCT) {
    items.push({
      item: 'Monitor holder concentration',
      reason: `The single largest sampled account holds ${top1Percent.toFixed(2)}% of supply — a sell from this account alone could move price significantly. Watch for large transfers out of it.`,
    })
  } else if (top10Percent != null && top10Percent >= HIGH_CONCENTRATION_THRESHOLD_PCT * 2) {
    items.push({
      item: 'Monitor whale accumulation / distribution',
      reason: `The top 10 sampled accounts hold ${top10Percent.toFixed(2)}% of supply combined — watch for coordinated movement across these accounts.`,
    })
  }

  if (marketData?.liquidityUsd != null) {
    if (marketData.liquidityUsd < LOW_LIQUIDITY_THRESHOLD_USD) {
      items.push({
        item: 'Monitor liquidity withdrawals',
        reason: `Pool liquidity is $${marketData.liquidityUsd.toLocaleString('en-US')} — thin liquidity means a single withdrawal could sharply move or drain price. Watch pool ${marketData.primaryPoolAddress ?? ''}.`.trim(),
      })
    } else {
      items.push({
        item: 'Monitor liquidity movement',
        reason: `Pool liquidity is $${marketData.liquidityUsd.toLocaleString('en-US')} at ${marketData.primaryDexLabel ?? 'the primary pool'} — watch for large withdrawals relative to this baseline.`,
      })
    }
  }

  if (poolProgram.migratedFromPumpFun === true) {
    items.push({
      item: 'Monitor PumpSwap pool for LP movement',
      reason: 'This token migrated from the Pump.fun bonding curve to PumpSwap (confirmed by the pool\'s owning program) — watch the PumpSwap pool for liquidity changes now that it trades on an open AMM.',
    })
  }

  const likelyCreator = deepCreator?.creatorTrace.resolved.likelyCreatorWallet
  if (likelyCreator) {
    items.push({
      item: 'Monitor creator wallet',
      reason: `${likelyCreator} was the fee payer of this mint's earliest found transaction (Deep Creator Check) — watch this wallet for further token launches or large transfers.`,
    })
  }

  if (marketData?.socials && Object.values(marketData.socials).some((v) => v != null)) {
    items.push({
      item: 'Monitor metadata / social link changes',
      reason: 'This token has indexed social/website links via its DexScreener listing — a sudden removal or change of these links can signal an abandoned or rebranded project.',
    })
  }

  return items
}
