// SOLANA CREATOR ANALYZER, DISCLOSED (Solana-native architecture task).
//
// WHAT THIS DOES: a lightweight, real on-chain-activity signal via Helius's standard
// getSignaturesForAddress RPC method — confirms whether the mint has recent signature activity.
// Gated behind ENABLE_HELIUS_SOLANA + HELIUS_API_KEY; never called when disabled.
//
// WHAT THIS DELIBERATELY DOES NOT DO, DISCLOSED (read before extending this file): it does NOT
// resolve a creator/deployer wallet, funding-wallet trail, linked-launch history, or rug history.
// Real creator identity for a Solana token (e.g. who called Pump.fun's "create" instruction)
// requires PARSED transaction data — Helius's Enhanced Transactions API, which this codebase's own
// hard limit forbids calling by default (cost control; see solanaProviders.ts's own disclosure).
// The alternative — paginating a token's full signature history back to its first transaction on
// plain RPC — is unbounded and expensive for any actively-traded token, and still would not
// itself identify a "creator" without parsing instruction data. Building either safely requires a
// dedicated, explicitly user-gated "Deep Dev Check" path that does not exist yet. Presenting a
// guessed creator address here (e.g. "the earliest fee payer") without parsing the actual
// instruction would risk being wrong and is not attempted.

import { fetchHeliusSolanaActivity, type SolanaHeliusResult } from '../solanaProviders.ts'
import type { RpcFetch } from './rpcClient.ts'

export type SolanaCreatorAnalysis = {
  helius: SolanaHeliusResult
  evidenceGaps: string[]
}

export async function analyzeSolanaCreator(mintAddress: string, fetchImpl: RpcFetch): Promise<SolanaCreatorAnalysis> {
  const evidenceGaps: string[] = []
  const helius = await fetchHeliusSolanaActivity(mintAddress, fetchImpl)
  if (helius.called && !helius.success) evidenceGaps.push('Helius activity read did not resolve — dev/creator activity signal unavailable.')
  if (helius.called) evidenceGaps.push('Creator/dev-wallet activity requires Helius Enhanced Transactions, which is not called by default (cost control) — only recent on-chain signature presence is checked.')
  return { helius, evidenceGaps }
}
