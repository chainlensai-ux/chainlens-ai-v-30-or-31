// SOLANA SUPPLY TIMELINE / HISTORY, DISCLOSED (Dev Intelligence "History" + "Supply Timeline" tabs
// follow-up task).
//
// HONESTY CONTRACT, CRITICAL: Solana account state is a present-tense snapshot — the RPC has no
// built-in "authority change log" or "metadata update log", and this codebase has no dedicated
// historical indexer. So this module returns only events it can back with real evidence (the
// mint's earliest found transaction via Deep Creator Check, and pool-program identity as a
// migration fact), plus an explicit, itemized list of what CANNOT be reconstructed and why — per
// this task's own rule ("if unavailable, explain which history cannot be reconstructed and why"),
// never a fabricated or interpolated timeline.

import type { SolanaMintAnalysis } from './mintAnalyzer.ts'
import type { SolanaPoolProgram, SolanaMarketData } from './types.ts'
import type { SolanaDeepCreatorAnalysis } from './deepCreatorAnalyzer.ts'

export type SolanaTimelineEvent = {
  label: string
  /** ISO timestamp when known exactly; null when only an approximate age is known. */
  timestamp: string | null
  /** Human-readable approximation (e.g. "42d ago") when an exact timestamp isn't available. */
  approxAge: string | null
  detail: string
  source: string
}

export type SolanaSupplyTimeline = {
  events: SolanaTimelineEvent[]
  /** Each entry names exactly what history is missing and why, per the honesty contract above. */
  reconstructionGaps: string[]
}

export function buildSolanaSupplyTimeline(input: {
  mint: SolanaMintAnalysis & { ok: true }
  poolProgram: SolanaPoolProgram
  marketData: SolanaMarketData | null
  deepCreator: SolanaDeepCreatorAnalysis | null
}): SolanaSupplyTimeline {
  const { mint, poolProgram, marketData, deepCreator } = input
  const events: SolanaTimelineEvent[] = []
  const reconstructionGaps: string[] = []

  const trace = deepCreator?.creatorTrace
  if (trace?.success && trace.resolved.earliestTimestamp) {
    events.push({
      label: 'Earliest found on-chain activity',
      timestamp: trace.resolved.earliestTimestamp,
      approxAge: null,
      detail: trace.reachedGenesis
        ? `Earliest transaction for this mint, fee-paid by ${trace.resolved.likelyCreatorWallet ?? 'an unresolved wallet'}${trace.resolved.transactionSource ? ` via ${trace.resolved.transactionSource}` : ''}. Signature history was fully paginated back to this point — this is very likely the actual mint-creation transaction.`
        : `Earliest transaction found within the ${trace.pagesFetched}-page lookback window, fee-paid by ${trace.resolved.likelyCreatorWallet ?? 'an unresolved wallet'}. History was NOT fully paginated to genesis — an older transaction may exist beyond this window.`,
      source: 'Helius Enhanced Transactions (Deep Creator Check)',
    })
  } else if (deepCreator) {
    reconstructionGaps.push('Mint creation timestamp: Deep Creator Check ran but did not resolve an earliest transaction — signature history may be empty or unreachable for this mint.')
  } else {
    reconstructionGaps.push('Mint creation timestamp: not resolved — this requires running Deep Creator Check (Helius Enhanced Transactions), which is opt-in only and was not run for this scan.')
  }

  if (poolProgram.resolved && poolProgram.label) {
    events.push({
      label: poolProgram.migratedFromPumpFun ? 'Migrated to PumpSwap' : 'Pool identified',
      timestamp: null,
      approxAge: marketData?.pairAgeLabel ?? null,
      detail: poolProgram.migratedFromPumpFun
        ? `Pool's owning program is confirmed as PumpSwap AMM — this is Pump.fun's exclusive post-graduation AMM, so this token has migrated off the bonding curve.`
        : `Primary pool's owning program is confirmed on-chain as ${poolProgram.label}.`,
      source: 'Solana RPC getAccountInfo (pool owner) + DexScreener (pair age)',
    })
  } else {
    reconstructionGaps.push('Pool launch / migration timeline: no indexed pool could be verified on-chain for this mint, so launch and migration timing cannot be shown.')
  }

  events.push({
    label: mint.mintAuthority ? 'Mint authority: active (current state)' : 'Mint authority: revoked (current state)',
    timestamp: null,
    approxAge: null,
    detail: mint.authorityReadSucceeded
      ? (mint.mintAuthority ? `Mint authority ${mint.mintAuthority} is currently active.` : 'Mint authority is currently revoked (null).')
      : 'Mint authority state could not be read.',
    source: 'Solana RPC getAccountInfo (current snapshot only, not a historical record)',
  })
  events.push({
    label: mint.freezeAuthority ? 'Freeze authority: active (current state)' : 'Freeze authority: revoked (current state)',
    timestamp: null,
    approxAge: null,
    detail: mint.authorityReadSucceeded
      ? (mint.freezeAuthority ? `Freeze authority ${mint.freezeAuthority} is currently active.` : 'Freeze authority is currently revoked (null).')
      : 'Freeze authority state could not be read.',
    source: 'Solana RPC getAccountInfo (current snapshot only, not a historical record)',
  })

  reconstructionGaps.push('Authority change history: Solana accounts carry no built-in log of PAST authority changes — only the field above (current state) is directly readable. Whether/when a prior authority was revoked cannot be reconstructed without a dedicated transaction indexer this codebase does not have access to.')
  reconstructionGaps.push('Metadata update history: same limitation — only the current metadata state is readable, not a log of past changes.')
  reconstructionGaps.push('Program upgrade history: not applicable — SPL mints are data accounts owned by the (non-upgradable) Token/Token-2022 program, not upgradable programs themselves.')
  reconstructionGaps.push('Historical supply changes over time (a supply chart): would require indexing every mint/burn instruction across the mint\'s full transaction history — not attempted here; only the current total supply is shown.')

  return { events, reconstructionGaps }
}
