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
import { solanaRpc, type RpcFetch } from './rpcClient.ts'
import type { SolanaTopAccountShare } from './types.ts'

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
}

export async function analyzeSolanaHolders(params: {
  mintAddress: string
  rpcUrl: string
  fetchImpl: RpcFetch
  rawSupply: number | null
}): Promise<SolanaHolderAnalysis> {
  const evidenceGaps: string[] = []
  const { mintAddress, rpcUrl, fetchImpl, rawSupply } = params

  // ── Top-account concentration (never a holder count — see module header) ───
  type LargestResp = { value?: Array<{ address?: string; amount?: string; uiAmount?: number | null }> }
  const largestRes = await solanaRpc<LargestResp>(rpcUrl, 'getTokenLargestAccounts', [mintAddress], fetchImpl)
  let topAccountConcentration: SolanaTopAccountConcentration = null

  if (largestRes.ok && Array.isArray(largestRes.result?.value) && largestRes.result.value.length > 0) {
    const rows = largestRes.result.value
    const pct = (sumRaw: number): number | null =>
      rawSupply != null && rawSupply > 0 ? Math.round((sumRaw / rawSupply) * 10000) / 100 : null
    const rawAmounts = rows.map((r) => {
      const n = typeof r.amount === 'string' ? Number(r.amount) : NaN
      return Number.isFinite(n) ? n : 0
    })
    const sumOf = (n: number) => rawAmounts.slice(0, n).reduce((s, v) => s + v, 0)
    topAccountConcentration = {
      accountsSampled: rows.length,
      top1Percent: pct(sumOf(1)),
      top10Percent: pct(sumOf(10)),
      top20Percent: pct(sumOf(20)),
      accounts: rows.slice(0, 20).map((r, i) => ({
        rank: i + 1,
        amountRaw: typeof r.amount === 'string' ? r.amount : '0',
        percentOfSupply: pct(rawAmounts[i] ?? 0),
      })),
    }
    if (rawSupply == null) evidenceGaps.push('Top-account shares could not be expressed as a percent — supply unknown.')
    evidenceGaps.push('Concentration reflects the top token ACCOUNTS only (max 20), not a full holder count. AMM pool vaults and exchange custody accounts are included.')
  } else {
    evidenceGaps.push('Top token accounts could not be read — concentration unavailable.')
  }

  // ── Real, paginated holder-account count (Helius) ───────────────────────────
  const heliusHolders = await fetchHeliusHolderCount(mintAddress, fetchImpl)
  if (heliusHolders.called && !heliusHolders.success) evidenceGaps.push('Helius holder-account count did not resolve — holder count unavailable.')
  if (heliusHolders.success) evidenceGaps.push('Holder count reflects SPL token ACCOUNTS with a positive balance (AMM pool vaults and exchange custody accounts are included), not a KYC-verified unique-holder count.')
  if (heliusHolders.isLowerBound) evidenceGaps.push(`Holder count is a lower bound — capped at ${heliusHolders.pagesFetched} page(s) of accounts for cost control; the real count may be higher.`)

  return { topAccountConcentration, heliusHolders, evidenceGaps }
}
