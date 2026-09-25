// Solana Holder Map counts, with Solana semantics kept explicit.
//
// A token account (ATA or any other SPL account for the mint) is not a wallet. One owner can hold
// several accounts, and AMM vault accounts are owned by pool authorities, not people. So this
// module publishes two separate numbers and never relabels one as the other:
//   tokenAccountCount   positive-balance accounts for this exact mint (may be a lower bound)
//   uniqueOwnerCount    distinct owner addresses of those accounts, only when pagination was complete
// verifiedCustodyOwnerCount is the number of those owners that control a Stage 1 verified AMM vault
// account, so the UI can say the owner count includes pool authorities rather than calling them wallets.
// Pure. No provider calls; owners come from the same Helius pages already fetched for the count.

import type { SolanaHeliusHolderResult, SolanaUniqueOwnerStatus } from '../solanaProviders.ts'

export type SolanaHolderCounts = {
  basis: 'helius_das_token_accounts'
  tokenAccountCount: number | null
  tokenAccountCountIsLowerBound: boolean
  uniqueOwnerCount: number | null
  uniqueOwnerStatus: SolanaUniqueOwnerStatus
  uniqueOwnerReason: string | null
  /** Distinct owners of verified AMM vault token accounts among the counted accounts. Null unless uniqueOwnerCount is verified. */
  verifiedCustodyOwnerCount: number | null
  pagesFetched: number
}

export function buildSolanaHolderCounts(params: {
  heliusHolders: SolanaHeliusHolderResult | null | undefined
  verifiedVaultAccounts: ReadonlyArray<{ address: string }>
  ownerOf: (account: string) => string | null
}): SolanaHolderCounts {
  const h = params.heliusHolders
  if (!h || !h.success) {
    return {
      basis: 'helius_das_token_accounts',
      tokenAccountCount: null,
      tokenAccountCountIsLowerBound: false,
      uniqueOwnerCount: null,
      uniqueOwnerStatus: 'unavailable',
      uniqueOwnerReason: h?.uniqueOwnerReason ?? 'helius_token_accounts_unavailable',
      verifiedCustodyOwnerCount: null,
      pagesFetched: h?.pagesFetched ?? 0,
    }
  }
  const tokenAccountCount = h.tokenAccountCount ?? h.holderCount
  const verified = h.uniqueOwnerStatus === 'verified' && h.uniqueOwnerCount != null
  let verifiedCustodyOwnerCount: number | null = null
  if (verified) {
    const owners = new Set<string>()
    for (const v of params.verifiedVaultAccounts) {
      const o = params.ownerOf(v.address)
      if (o) owners.add(o)
    }
    verifiedCustodyOwnerCount = owners.size
  }
  return {
    basis: 'helius_das_token_accounts',
    tokenAccountCount,
    tokenAccountCountIsLowerBound: h.isLowerBound,
    uniqueOwnerCount: verified ? h.uniqueOwnerCount! : null,
    uniqueOwnerStatus: verified ? 'verified' : (h.uniqueOwnerStatus ?? 'partial'),
    uniqueOwnerReason: verified ? null : (h.uniqueOwnerReason ?? 'token_account_pagination_incomplete'),
    verifiedCustodyOwnerCount,
    pagesFetched: h.pagesFetched,
  }
}
