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
  // maxRetries: 2 (3 total attempts) on getTokenLargestAccounts, DISCLOSED: this specific call is
  // documented in rpcClient.ts's own header as the flakiest endpoint this engine calls — a single
  // retry was sometimes not enough under real concurrent load on a shared RPC key. Raised only
  // here, not for every RPC call in this engine.
  type LargestResp = { value?: Array<{ address?: string; amount?: string; uiAmount?: number | null }> }
  const [largestRes, heliusHolders] = await Promise.all([
    solanaRpc<LargestResp>(rpcUrl, 'getTokenLargestAccounts', [mintAddress], fetchImpl, 9000, 2),
    fetchHeliusHolderCount(mintAddress, fetchImpl),
  ])
  let topAccountConcentration: SolanaTopAccountConcentration = null

  if (largestRes.ok && Array.isArray(largestRes.result?.value) && largestRes.result.value.length > 0) {
    const rows = largestRes.result.value
    // BigInt throughout: raw SPL balances are u64 base-unit amounts and routinely exceed
    // Number.MAX_SAFE_INTEGER (2^53) for high-decimal/high-supply memecoins — converting via
    // Number() before summing loses precision that then propagates into every downstream
    // consumer (risk engine, pattern analyzer, watch plan, both client scorers). Only the final
    // percentage — not the raw amount itself — is ever narrowed to a JS number.
    const ZERO = BigInt(0)
    const rawSupplyBig = (() => {
      if (rawSupplyExact) {
        try {
          const v = BigInt(rawSupplyExact)
          if (v > ZERO) return v
        } catch {
          /* fall through to the lossy number below */
        }
      }
      return rawSupply != null && rawSupply > 0 ? BigInt(Math.trunc(rawSupply)) : null
    })()
    const pct = (sumRaw: bigint): number | null =>
      rawSupplyBig != null && rawSupplyBig > ZERO
        ? Math.round(Number((sumRaw * BigInt(1000000)) / rawSupplyBig)) / 10000
        : null
    const rawAmounts = rows.map((r) => {
      if (typeof r.amount !== 'string') return ZERO
      try {
        return BigInt(r.amount)
      } catch {
        return ZERO
      }
    })
    const sumOf = (n: number) => rawAmounts.slice(0, n).reduce((s, v) => s + v, ZERO)
    topAccountConcentration = {
      accountsSampled: rows.length,
      top1Percent: pct(sumOf(1)),
      top10Percent: pct(sumOf(10)),
      top20Percent: pct(sumOf(20)),
      accounts: rows.slice(0, 20).map((r, i) => ({
        rank: i + 1,
        address: typeof r.address === 'string' ? r.address : '',
        amountRaw: typeof r.amount === 'string' ? r.amount : '0',
        percentOfSupply: pct(rawAmounts[i] ?? ZERO),
      })),
    }
    if (rawSupply == null) evidenceGaps.push('Top-account shares could not be expressed as a percent — supply unknown.')
    evidenceGaps.push('Concentration reflects the top token ACCOUNTS only (max 20), not a full holder count. AMM pool vaults and exchange custody accounts are included.')
  } else {
    const reason = !largestRes.ok ? largestRes.error : 'empty_response'
    evidenceGaps.push(`Top token accounts could not be read (${reason}) — concentration unavailable.`)
  }

  // ── Real, paginated holder-account count (Helius) — fetched above, alongside the largest-
  // accounts read (see this function's own header for why they now run concurrently). ──────────
  if (heliusHolders.called && !heliusHolders.success) evidenceGaps.push('Helius holder-account count did not resolve — holder count unavailable.')
  if (heliusHolders.success) evidenceGaps.push('Holder count reflects SPL token ACCOUNTS with a positive balance (AMM pool vaults and exchange custody accounts are included), not a KYC-verified unique-holder count.')
  if (heliusHolders.isLowerBound) evidenceGaps.push(`Holder count is a lower bound — capped at ${heliusHolders.pagesFetched} page(s) of accounts for cost control; the real count may be higher.`)

  return { topAccountConcentration, heliusHolders, evidenceGaps }
}
