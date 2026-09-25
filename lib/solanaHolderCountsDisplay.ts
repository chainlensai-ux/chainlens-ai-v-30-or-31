// Holder Map wording for Solana counts. Token accounts are never called holders; the unique-owner
// line only shows a number when the API marked it verified (complete pagination, every owner known).
// An owner is the token account's owner address: a person's wallet, an exchange, or a program PDA
// (pool vault authority, multisig), so it is never called a wallet.

export type SolanaHolderCountsView = {
  tokenAccountCount: number | null
  tokenAccountCountIsLowerBound: boolean
  uniqueOwnerCount: number | null
  uniqueOwnerStatus: 'verified' | 'partial' | 'unavailable'
  uniqueOwnerReason: string | null
  verifiedCustodyOwnerCount: number | null
}

const fmt = (n: number) => n.toLocaleString('en-US')

export function formatSolanaUniqueHolderLine(c: SolanaHolderCountsView | null | undefined): string {
  if (c && c.uniqueOwnerStatus === 'verified' && c.uniqueOwnerCount != null) {
    const custody = c.verifiedCustodyOwnerCount ?? 0
    const base = `${fmt(c.uniqueOwnerCount)} ${c.uniqueOwnerCount === 1 ? 'unique owner' : 'unique owners'}`
    return custody > 0
      ? `${base} (includes ${fmt(custody)} verified pool vault ${custody === 1 ? 'authority' : 'authorities'})`
      : base
  }
  if (c?.uniqueOwnerReason === 'token_account_pagination_cap_reached') return 'Unique holders unavailable'
  if (c?.uniqueOwnerReason === 'token_account_pagination_incomplete') {
    return 'Unique holders unavailable (not every token account was read, so owners cannot be fully counted)'
  }
  if (c?.uniqueOwnerReason === 'token_account_owner_missing') {
    return 'Unique holders unavailable (some token accounts came back without an owner)'
  }
  return 'Unique holders unavailable'
}

export function formatSolanaTokenAccountLine(c: SolanaHolderCountsView | null | undefined): string {
  if (!c || c.tokenAccountCount == null) return 'Token accounts with balance unavailable'
  const n = `${fmt(c.tokenAccountCount)}${c.tokenAccountCountIsLowerBound ? '+' : ''}`
  return `${n} token ${c.tokenAccountCount === 1 && !c.tokenAccountCountIsLowerBound ? 'account' : 'accounts'} with balance`
}

// Stat-card values for the Holder Map summary: just the number (or "Unavailable"), with the label
// rendered separately. Same verification rules as the line formatters above.
export function formatSolanaUniqueOwnerStat(c: SolanaHolderCountsView | null | undefined): string {
  return c && c.uniqueOwnerStatus === 'verified' && c.uniqueOwnerCount != null ? fmt(c.uniqueOwnerCount) : 'Unavailable'
}

export function formatSolanaTokenAccountStat(c: SolanaHolderCountsView | null | undefined): string {
  if (!c || c.tokenAccountCount == null) return 'Unavailable'
  return `${fmt(c.tokenAccountCount)}${c.tokenAccountCountIsLowerBound ? '+' : ''}`
}
