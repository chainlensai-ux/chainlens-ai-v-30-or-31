// SOLANA DEEP CREATOR ANALYZER, DISCLOSED (Deep Mode, "do the Helius Enhanced thing" follow-up).
//
// EXPLICIT OPT-IN ONLY, CRITICAL: this module calls Helius's paid Enhanced Transactions API via
// fetchHeliusCreatorTrace (see solanaProviders.ts for the full disclosure). It must NEVER be
// invoked from the default scan path (providerMerge.ts only calls this when `opts.deep === true`,
// itself only set when the API route receives an explicit `deep` flag from a user action — never
// from a normal scan request). This is the one function in the whole engine allowed to spend that
// extra cost, and only when the user asked for it.
//
// WHAT THIS RESOLVES: a real, disclosed "likely creator wallet" — the fee payer of the mint's
// earliest found transaction — plus the earliest transaction's timestamp and, when Helius
// recognizes the interacting program, its source label (e.g. a Pump.fun create). See
// solanaProviders.ts's fetchHeliusCreatorTrace for exactly what "likely" means and why it is
// never asserted as a certainty.
//
// WHAT THIS STILL DOES NOT DO: wallet clustering, funding-wallet tracing beyond this one hop,
// launch history across other tokens, rug history, or reputation scoring. Those all require
// either a wallet-labeling database this codebase has no access to, or heuristics with no
// verifiable ground truth — not attempted here either.

import { fetchHeliusCreatorTrace, type SolanaCreatorTraceResult } from '../solanaProviders.ts'
import type { RpcFetch } from './rpcClient.ts'

export type SolanaDeepCreatorAnalysis = {
  creatorTrace: SolanaCreatorTraceResult
  evidenceGaps: string[]
}

export async function analyzeSolanaDeepCreator(mintAddress: string, fetchImpl: RpcFetch): Promise<SolanaDeepCreatorAnalysis> {
  const evidenceGaps: string[] = []
  const creatorTrace = await fetchHeliusCreatorTrace(mintAddress, fetchImpl)

  if (creatorTrace.called && !creatorTrace.success) evidenceGaps.push('Deep creator trace did not resolve a likely creator wallet.')
  if (creatorTrace.success && !creatorTrace.reachedGenesis) evidenceGaps.push(`Signature history lookback capped at ${creatorTrace.pagesFetched} page(s) for cost control — the earliest transaction found may not be this token's true genesis transaction for a very old or highly active mint.`)
  if (creatorTrace.resolved.likelyCreatorWallet) evidenceGaps.push('Likely creator wallet is the fee payer of the earliest found transaction — a strong signal, not a certainty (a sponsored/relayed transaction would show a different payer than the actual deployer).')

  return { creatorTrace, evidenceGaps }
}
