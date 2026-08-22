// SOLANA CREATOR CONFIDENCE, DISCLOSED (Dev Intelligence "Creator Analysis" upgrade follow-up).
//
// Upgrades the binary "matched / not matched" creator read into the tiered
// Confirmed/Likely/Possible/Unknown verdict this task asks for — every tier is derived from real,
// already-gathered Deep Creator Check evidence (deepCreatorAnalyzer.ts), never a new guess:
//
//  - CONFIRMED: signature history was paginated all the way to genesis AND the earliest
//    transaction's source program is a recognized launch program (e.g. Pump.fun) — the strongest
//    real signal this engine can produce, since a launch-program create instruction naming this fee
//    payer is close to definitional.
//  - LIKELY: signature history reached genesis, but the interacting program wasn't recognized —
//    still very likely the true earliest transaction, just without a named launch-program tie.
//  - POSSIBLE: an earliest transaction was found, but pagination did NOT reach genesis — there may
//    be older history beyond the lookback window, so this fee payer might not be the true creator.
//  - UNKNOWN: Deep Creator Check was not run, or ran without resolving a fee payer.

import type { SolanaCreatorTraceResult } from '../solanaProviders.ts'

export type SolanaCreatorConfidenceTier = 'CONFIRMED' | 'LIKELY' | 'POSSIBLE' | 'UNKNOWN'

export type SolanaCreatorConfidence = {
  tier: SolanaCreatorConfidenceTier
  /** 0-100, purely a readable mapping of the tier above — never an independent score. */
  confidencePercent: number
  wallet: string | null
  reason: string
}

const KNOWN_LAUNCH_SOURCES = new Set(['PUMP_FUN', 'PUMP_AMM'])

export function analyzeSolanaCreatorConfidence(creatorTrace: SolanaCreatorTraceResult | null): SolanaCreatorConfidence {
  if (!creatorTrace || !creatorTrace.called) {
    return { tier: 'UNKNOWN', confidencePercent: 0, wallet: null, reason: 'Deep Creator Check has not been run for this mint — no creator wallet evidence is available yet.' }
  }
  const wallet = creatorTrace.resolved.likelyCreatorWallet
  if (!wallet) {
    return { tier: 'UNKNOWN', confidencePercent: 0, wallet: null, reason: creatorTrace.errorReason ? `Deep Creator Check ran but did not resolve a creator wallet (${creatorTrace.errorReason}).` : 'Deep Creator Check ran but did not resolve a creator wallet.' }
  }
  const source = creatorTrace.resolved.transactionSource
  if (creatorTrace.reachedGenesis && source && KNOWN_LAUNCH_SOURCES.has(source)) {
    return { tier: 'CONFIRMED', confidencePercent: 90, wallet, reason: `Signature history was fully paginated to genesis, and the earliest transaction's source program is recognized as ${source} — a launch-program create transaction naming ${wallet} as fee payer.` }
  }
  if (creatorTrace.reachedGenesis) {
    return { tier: 'LIKELY', confidencePercent: 65, wallet, reason: `Signature history was fully paginated to genesis, so ${wallet} is very likely this mint's true earliest fee payer — the interacting program was not a recognized launch program, so this stops short of a launch-instruction confirmation.` }
  }
  return { tier: 'POSSIBLE', confidencePercent: 35, wallet, reason: `An earliest transaction was found with fee payer ${wallet}, but signature pagination did NOT reach genesis (capped at ${creatorTrace.pagesFetched} page(s)) — an older transaction with a different fee payer may exist beyond this lookback window.` }
}
