// SOLANA HOLDER ANALYZER, DISCLOSED (Solana-native architecture task): Solana has no built-in
// "holder list" RPC method the way an indexer does — this module merges two REAL, independent
// reads into one holder-intelligence picture, native to how Solana actually exposes this data:
//
//  1. getTokenLargestAccounts (Alchemy) — the top 20 token ACCOUNTS by balance. Routinely includes
//     AMM pool vaults and exchange custody, so a high "top 1" share can be a liquidity pool, not a
//     whale. Reported as topAccountConcentration — never called a holder list.
//  2. getTokenAccounts (Helius DAS, paginated) — a REAL, capped count of accounts with a positive
//     balance. Still an account count, not a KYC-verified unique-human count — see
//     solanaProviders.ts's fetchHeliusHolderCount for the full disclosure.
//
// WHAT THIS DOES NOT DO, DISCLOSED: it does not classify accounts into snipers / bundlers /
// insiders / team wallets / smart money. Doing that honestly requires either (a) a wallet-labeling
// database this codebase does not have access to, or (b) heuristics with no verifiable ground
// truth — which would mean presenting a guess as a classification. Neither is acceptable under
// this engine's no-fabrication contract, so those labels are not implemented. See this session's
// final capability report for the full list of what's real vs. not yet possible.

import { fetchHeliusHolderCount, type SolanaHeliusHolderResult } from '../solanaProviders.ts'
import { type RpcFetch } from './rpcClient.ts'
import type { SolanaTopAccountShare } from './types.ts'
import { resolveSolanaHolderConcentration, type SolanaHolderConcentrationResult, type SolanaHolderConcentrationAudit } from './holderConcentrationResolver.ts'

export type SolanaTopAccountConcentration = {
  accountsSampled: number
  top1Percent: number | null
  top10Percent: number | null
  top20Percent: number | null
  accounts: SolanaTopAccountShare[]
} | null

export type SolanaHolderAnalysis = {
  topAccountConcentration: SolanaTopAccountConcentration
  heliusHolders: SolanaHeliusHolderResult
  evidenceGaps: string[]
  // RELIABILITY FIX, DISCLOSED (Solana holder-concentration reliability task): additive — the full
  // cache/Helius/RPC/supply-only/failure resolution this module's concentration read now goes
  // through (see holderConcentrationResolver.ts), plus its audit trail. `topAccountConcentration`
  // above is preserved byte-for-byte for existing callers; these two fields are the richer view for
  // callers that want the resolver's own status/source/confidence/public-vs-technical reason split.
  concentrationResult: SolanaHolderConcentrationResult
  concentrationAudit: SolanaHolderConcentrationAudit
}

const PUBLIC_HOLDER_UNAVAILABLE_FALLBACK = 'Holder concentration unavailable — Solana provider did not return top token accounts.'

export async function analyzeSolanaHolders(params: {
  mintAddress: string
  rpcUrl: string
  fetchImpl: RpcFetch
  rawSupply: number | null
  /** Exact u64 base-unit supply string — preferred over rawSupply for precision. */
  rawSupplyExact?: string | null
}): Promise<SolanaHolderAnalysis> {
  const evidenceGaps: string[] = []
  const { mintAddress, rpcUrl, fetchImpl, rawSupply, rawSupplyExact } = params

  // ── Top-account concentration + Helius holder count run CONCURRENTLY, DISCLOSED: these are two
  // fully independent reads (different providers, neither depends on the other's result) that
  // previously ran sequentially — worst case (3 retried attempts on getTokenLargestAccounts, THEN
  // up to 3 paginated Helius calls) could take ~50s end to end. Running them together roughly
  // halves worst-case latency, which matters directly: app/api/token/route.ts has no maxDuration
  // override, so a scan that runs long risks the PLATFORM killing the whole request before this
  // module's own retries even get to finish — which reads to a user as "holders randomly doesn't
  // work" even though every individual read is behaving exactly as designed.
  //
  // RELIABILITY FIX, DISCLOSED (Solana holder-concentration reliability task): concentration
  // resolution itself is now resolveSolanaHolderConcentration's full cache → Helius →
  // getTokenLargestAccounts → supply-only → honest-failure chain (holderConcentrationResolver.ts) —
  // this used to be a single RPC attempt (with retry) and nothing else, so a live rpc_error surfaced
  // straight to evidenceGaps as a raw provider string. Concurrent with the Helius holder-COUNT read
  // below (a different metric, unaffected by this change).
  const [concentration, heliusHolders] = await Promise.all([
    resolveSolanaHolderConcentration({ mintAddress, chainSlug: 'solana', rpcUrl, fetchImpl, rawSupply, rawSupplyExact }),
    fetchHeliusHolderCount(mintAddress, fetchImpl),
  ])
  const concentrationResult = concentration.result
  const concentrationAudit = concentration.audit
  let topAccountConcentration: SolanaTopAccountConcentration = null

  if (concentrationResult.topAccounts.length > 0) {
    topAccountConcentration = {
      accountsSampled: concentrationResult.topAccounts.length,
      top1Percent: concentrationResult.top1Percent,
      top10Percent: concentrationResult.top10Percent,
      top20Percent: concentrationResult.top20Percent,
      accounts: concentrationResult.topAccounts,
    }
    if (concentrationResult.top1Percent == null) evidenceGaps.push('Top-account shares could not be expressed as a percent — supply unknown.')
    evidenceGaps.push('Concentration reflects the top token ACCOUNTS only (max 20), not a full holder count. AMM pool vaults and exchange custody accounts are included.')
    if (concentrationResult.publicReason) evidenceGaps.push(concentrationResult.publicReason)
  } else {
    // PUBLIC-SAFE WORDING, DISCLOSED: never the raw technicalReason (e.g. "rpc_error:Internal
    // error") — always the resolver's own clean, public-safe reason.
    evidenceGaps.push(concentrationResult.publicReason ?? PUBLIC_HOLDER_UNAVAILABLE_FALLBACK)
  }

  // ── Real, paginated holder-account count (Helius) — fetched above, alongside the largest-
  // accounts read (see this function's own header for why they now run concurrently). ──────────
  if (heliusHolders.called && !heliusHolders.success) evidenceGaps.push('Helius holder-account count did not resolve — holder count unavailable.')
  if (heliusHolders.success) evidenceGaps.push('Holder count reflects SPL token ACCOUNTS with a positive balance (AMM pool vaults and exchange custody accounts are included), not a KYC-verified unique-holder count.')
  if (heliusHolders.isLowerBound) evidenceGaps.push(`Holder count is a lower bound — capped at ${heliusHolders.pagesFetched} page(s) of accounts for cost control; the real count may be higher.`)

  return { topAccountConcentration, heliusHolders, evidenceGaps, concentrationResult, concentrationAudit }
}
