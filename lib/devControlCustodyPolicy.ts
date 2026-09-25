// DEV CONTROL × LIQUIDITY CUSTODY POLICY, DISCLOSED.
//
// A deployer seeding initial liquidity sends tokens to the pool / PoolManager. The first-transfer
// graph correctly records that edge (e.g. `first_token_receiver_from_origin`), but a transfer
// INTO a verified liquidity-custody address is not evidence that the developer controls the
// tokens sitting there. Counting that address as an ordinary linked dev wallet inflated
// linkedWalletSupply / devClusterSupply (ASTEROID: V2 pair at rank 1 counted as ~10.31%).
//
// Policy (one canonical helper so supplyControl, the dev-cluster audit, the cluster map and
// CORTEX all read the same partition):
// - VERIFIED liquidity custody (holder row classification.kind === 'liquidity_custody') whose
//   ONLY link evidence is a token-seeding transfer from the origin is excluded from ordinary
//   linked-wallet supply, and reported separately with its evidence (never silently dropped).
// - Custody addresses with independent dev-control evidence (admin/proxy control, native
//   funding edges) stay counted, flagged `liquidityCustodyRole` so custody and developer-
//   controlled wallet are distinguishable.
// - Unclassified / unknown custody stays unknown and counts as before. Contracts are not
//   excluded for being contracts. Custody never proves the dev has no LP control — LP control /
//   lock evidence is a separate verdict and is not read or changed here.
// Pure: no provider calls.

import { finalizeDevClusterStatuses, type DevClusterDiagnosisAudit } from './devClusterDiagnosis'

export type DevControlLinkedWallet = {
  address: string
  reason?: string | null
  confidence?: 'high' | 'medium' | 'low' | string | null
}

export type DevControlHolderRow = {
  address?: string | null
  percent?: number | null
  rank?: number | null
  classification?: { kind?: string | null; role?: string | null; label?: string | null } | null
}

/** Link reasons that only prove tokens moved from the origin into the address (liquidity seeding looks identical). */
export const TOKEN_SEEDING_ONLY_LINK_REASONS: ReadonlySet<string> = new Set([
  'first_token_receiver_from_origin',
  'token_supply_transfer',
  'top_holder_direct_transfer',
])

export type CustodyExcludedLinkedWallet = {
  address: string
  custodyRole: string | null
  custodyLabel: string | null
  linkReason: string | null
  percent: number | null
  rank: number | null
  excludedFromDevSupply: true
  reason: 'verified_liquidity_custody_linked_only_by_token_seeding_transfer'
}

export type LinkedWalletWithCustodyFlag<W extends DevControlLinkedWallet> = W & {
  /** Set only when the address is verified liquidity custody AND has independent dev-control evidence. */
  liquidityCustodyRole?: string
  devControlBasis?: 'independent_dev_evidence_on_liquidity_custody_address'
}

const norm = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null

export function verifiedCustodyByAddress(holderRows: readonly DevControlHolderRow[]): Map<string, DevControlHolderRow> {
  const out = new Map<string, DevControlHolderRow>()
  for (const row of holderRows) {
    const a = norm(row.address)
    if (a && row.classification?.kind === 'liquidity_custody' && !out.has(a)) out.set(a, row)
  }
  return out
}

export function partitionLinkedWalletsForDevSupply<W extends DevControlLinkedWallet>(input: {
  linkedWallets: readonly W[]
  holderRows: readonly DevControlHolderRow[]
}): { countable: Array<LinkedWalletWithCustodyFlag<W>>; custodyExcluded: CustodyExcludedLinkedWallet[] } {
  const custody = verifiedCustodyByAddress(input.holderRows)
  if (custody.size === 0) return { countable: [...input.linkedWallets], custodyExcluded: [] }

  // An address may appear more than once with different reasons; judge its evidence as a whole.
  const reasonsByAddress = new Map<string, Set<string>>()
  for (const w of input.linkedWallets) {
    const a = norm(w.address)
    if (!a) continue
    const set = reasonsByAddress.get(a) ?? new Set<string>()
    set.add(w.reason ?? '')
    reasonsByAddress.set(a, set)
  }

  const countable: Array<LinkedWalletWithCustodyFlag<W>> = []
  const custodyExcluded: CustodyExcludedLinkedWallet[] = []
  const excludedSeen = new Set<string>()
  for (const w of input.linkedWallets) {
    const a = norm(w.address)
    const row = a ? custody.get(a) : undefined
    if (!a || !row) { countable.push(w); continue }
    const reasons = [...(reasonsByAddress.get(a) ?? [])]
    const seedingOnly = reasons.length > 0 && reasons.every((r) => TOKEN_SEEDING_ONLY_LINK_REASONS.has(r))
    if (seedingOnly) {
      if (!excludedSeen.has(a)) {
        excludedSeen.add(a)
        custodyExcluded.push({
          address: a,
          custodyRole: row.classification?.role ?? null,
          custodyLabel: row.classification?.label ?? null,
          linkReason: w.reason ?? null,
          percent: typeof row.percent === 'number' && Number.isFinite(row.percent) ? row.percent : null,
          rank: row.rank ?? null,
          excludedFromDevSupply: true,
          reason: 'verified_liquidity_custody_linked_only_by_token_seeding_transfer',
        })
      }
      continue
    }
    countable.push({
      ...w,
      liquidityCustodyRole: row.classification?.role ?? 'liquidity_custody',
      devControlBasis: 'independent_dev_evidence_on_liquidity_custody_address',
    })
  }
  return { countable, custodyExcluded }
}

/**
 * The dev-cluster audit computes its own cluster supply before Stage-1 custody annotation exists.
 * When the policy excluded custody addresses, align the audit with the canonical supplyControl
 * values so Dev Control labels, the cluster map and CORTEX cannot disagree. Returns the SAME
 * object when nothing was excluded (no drift for ordinary tokens); otherwise a copy (the input
 * may be a cached object).
 */
export function reconcileDevClusterAuditWithCustody(
  audit: DevClusterDiagnosisAudit,
  input: { custodyExcludedCount: number; countableLinkedCount: number; devClusterSupplyPercent: number | null },
): DevClusterDiagnosisAudit {
  if (input.custodyExcludedCount <= 0) return audit
  const g = audit.linkedWalletGraph
  const graphRanFound = g.graphStatus === 'ran_found'
  const next: DevClusterDiagnosisAudit = {
    ...audit,
    linkedWalletGraph: {
      ...g,
      linkedWalletSupplyPct: input.devClusterSupplyPercent,
      walletsMapped: g.walletsMapped == null ? null : input.countableLinkedCount,
      graphStatus: graphRanFound && input.countableLinkedCount === 0 ? 'ran_none' : g.graphStatus,
      liquidityCustodyExcluded: input.custodyExcludedCount,
    },
  }
  const finals = finalizeDevClusterStatuses(next)
  return { ...next, ...finals }
}
