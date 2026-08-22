// SOLANA PATTERN ANALYSIS, DISCLOSED (Dev Intelligence "Pattern Analysis" tab follow-up task).
//
// HONESTY CONTRACT, CRITICAL: several patterns this task names (wash trading, bot activity, large
// coordinated buys, RATE of holder-concentration change) require indexing many historical
// transactions/snapshots this codebase has no indexer for — attempting them from a single snapshot
// would be a guess, not evidence. Each pattern below returns `detected: null` with an explicit
// `reason` when it cannot be verified — never a fabricated true/false. Patterns that ARE
// verifiable from real, already-gathered evidence (pool-program identity, mint authority state,
// current holder concentration) are reported with a real confidence, cited to that evidence.

import type { SolanaPoolProgram } from './types.ts'
import type { SolanaSupplyControl } from './supplyControlAnalyzer.ts'

export type SolanaPatternConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | null

export type SolanaPatternVerdict = {
  key: string
  label: string
  /** null means "cannot be determined from available evidence" — never a guessed false. */
  detected: boolean | null
  confidence: SolanaPatternConfidence
  evidence: string
}

export type SolanaPatternAnalysis = {
  patterns: SolanaPatternVerdict[]
}

const UNAVAILABLE = (label: string, key: string, reason: string): SolanaPatternVerdict => ({ key, label, detected: null, confidence: null, evidence: reason })

export function analyzeSolanaPatterns(input: {
  poolProgram: SolanaPoolProgram
  supplyControl: SolanaSupplyControl
  top1Percent: number | null
  helius: { called: boolean; success: boolean; resolved: { recentTransfers: number | null } }
}): SolanaPatternAnalysis {
  const { poolProgram, supplyControl, top1Percent, helius } = input
  const patterns: SolanaPatternVerdict[] = []

  // ── Pump.fun migration — definitional from real pool-program identity, no guess involved ──────
  if (poolProgram.resolved && poolProgram.migratedFromPumpFun === true) {
    patterns.push({ key: 'pumpfun_migration', label: 'Pump.fun → PumpSwap migration', detected: true, confidence: 'HIGH', evidence: 'Primary pool\'s owning program is confirmed on-chain as PumpSwap AMM — Pump.fun\'s exclusive post-graduation AMM, so this token migrated off the bonding curve.' })
  } else if (poolProgram.resolved) {
    patterns.push({ key: 'pumpfun_migration', label: 'Pump.fun → PumpSwap migration', detected: false, confidence: 'HIGH', evidence: `Primary pool's owning program is confirmed as ${poolProgram.label ?? 'an unrecognized program'}, not PumpSwap.` })
  } else {
    patterns.push(UNAVAILABLE('Pump.fun → PumpSwap migration', 'pumpfun_migration', 'No indexed pool could be verified on-chain for this mint — pool-program identity is unknown.'))
  }

  // ── Raydium launch — same real pool-program identity read ──────────────────────────────────────
  if (poolProgram.resolved && poolProgram.label === 'Raydium AMM V4') {
    patterns.push({ key: 'raydium_launch', label: 'Raydium AMM launch', detected: true, confidence: 'HIGH', evidence: 'Primary pool\'s owning program is confirmed on-chain as Raydium AMM V4.' })
  } else if (poolProgram.resolved) {
    patterns.push({ key: 'raydium_launch', label: 'Raydium AMM launch', detected: false, confidence: 'HIGH', evidence: `Primary pool's owning program is confirmed as ${poolProgram.label ?? 'an unrecognized program'}, not Raydium.` })
  } else {
    patterns.push(UNAVAILABLE('Raydium AMM launch', 'raydium_launch', 'No indexed pool could be verified on-chain for this mint — pool-program identity is unknown.'))
  }

  // ── Liquidity additions / removals — requires historical pool-balance snapshots ────────────────
  patterns.push(UNAVAILABLE('Liquidity additions', 'liquidity_additions', 'Requires historical pool-balance snapshots over time — this engine reads only a live snapshot, not indexed history.'))
  patterns.push(UNAVAILABLE('Liquidity removals', 'liquidity_removals', 'Requires historical pool-balance snapshots over time — this engine reads only a live snapshot, not indexed history.'))

  // ── Mint activity / supply events — tied to real, current mint-authority state ────────────────
  if (!supplyControl.mintAuthority && supplyControl.inflationPossible === false) {
    patterns.push({ key: 'mint_activity', label: 'Mint / supply events', detected: false, confidence: 'HIGH', evidence: 'Mint authority is revoked (verified on-chain) — no further mint events are possible for this token.' })
  } else if (supplyControl.mintAuthority) {
    const active = helius.called && helius.success && (helius.resolved.recentTransfers ?? 0) > 0
    patterns.push({ key: 'mint_activity', label: 'Mint / supply events', detected: active ? true : null, confidence: active ? 'LOW' : null, evidence: active ? `Mint authority ${supplyControl.mintAuthority} is active and this mint has ${helius.resolved.recentTransfers} recent signature(s) — some of that activity MAY be mint events, but this engine cannot distinguish mint instructions from other transaction types without Enhanced Transaction parsing of each signature.` : 'Mint authority is active, but on-chain activity signal is unavailable — cannot determine whether mint events have occurred.' })
  } else {
    patterns.push(UNAVAILABLE('Mint / supply events', 'mint_activity', 'Mint authority state could not be read for this mint.'))
  }

  // ── Wash trading / bot activity / coordinated buys — require historical trade-level indexing ──
  patterns.push(UNAVAILABLE('Wash trading indicators', 'wash_trading', 'Requires per-trade historical indexing (buyer/seller wallet overlap, trade timing) this codebase does not have access to — a live snapshot cannot verify this pattern.'))
  patterns.push(UNAVAILABLE('Bot activity', 'bot_activity', 'Requires transaction-level timing/signature analysis across many trades this codebase does not index — not attempted from a snapshot.'))
  patterns.push(UNAVAILABLE('Large coordinated buys', 'coordinated_buys', 'Requires correlating buy timing and size across many wallets over a historical window this codebase does not index.'))

  // ── Current holder concentration — a real, verifiable SNAPSHOT (not a rate-of-change) ─────────
  if (top1Percent != null) {
    const elevated = top1Percent >= 20
    patterns.push({ key: 'holder_concentration', label: 'Holder concentration (current snapshot)', detected: elevated, confidence: 'MEDIUM', evidence: `Largest sampled account holds ${top1Percent.toFixed(2)}% of supply right now. This is a point-in-time snapshot, not a rate-of-change measurement — "rapid" accumulation cannot be verified without historical snapshots this engine does not index.` })
  } else {
    patterns.push(UNAVAILABLE('Holder concentration (current snapshot)', 'holder_concentration', 'Top-account concentration could not be read for this mint.'))
  }

  return { patterns }
}
