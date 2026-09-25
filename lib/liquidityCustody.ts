/**
 * Token Scanner Stage-1 liquidity-custody annotations.
 *
 * Pure annotator: labels holder rows that match ALREADY-VERIFIED pool/reserve
 * custody addresses for the scanned token. Does NOT change Top-N percentages,
 * holder counts, LP proof, Dev Control, CORTEX, or risk.
 *
 * Hard rules:
 * - Classify as liquidity_custody only with chain-specific proof of reserve custody
 *   for the scanned token (never name-only heuristics).
 * - Pool address holding token reserves ≠ LP owner; LP-token holders and position
 *   NFT owners are out of scope here.
 * - V4 shared PoolManager: Robinhood only, and only with an exact bytes32 V4 poolId for the
 *   scanned token; never attribute the singleton balance to one pool (poolRef stays null).
 * - Solana: token-account owner field alone is NOT vault proof — require a verified vault
 *   address matched to the exact mint (already resolved elsewhere). Otherwise leave unclassified.
 * - Deduplicate custody addresses across multiple pools; never claim complete custody %
 *   unless coverage proves completeness (Stage 1 always reports partial/incomplete).
 */

export type LiquidityCustodyChain = 'eth' | 'base' | 'bnb' | 'robinhood' | 'solana'

export type LiquidityCustodyRole =
  | 'amm_pool_reserves'
  | 'protocol_vault'
  | 'v4_pool_manager'
  | 'solana_amm_vault'

export type HolderClassificationKind =
  | 'ordinary'
  | 'liquidity_custody'
  | 'unclassified'

export type HolderClassification = {
  kind: HolderClassificationKind
  role?: LiquidityCustodyRole
  label?: string
  evidence: string[]
}

export type AnnotatedHolderRow<T extends { address: string; percent?: number | null }> = T & {
  classification?: HolderClassification
}

export type LiquidityCustodyRow = {
  address: string
  role: LiquidityCustodyRole
  percentOfSupply: number | null
  evidence: string[]
  poolRef: string | null
  label: string
}

export type LiquidityCustodySummary = {
  status: 'verified' | 'partial' | 'none' | 'unavailable'
  rows: LiquidityCustodyRow[]
  /** Sum of verified custody percents among annotated holder rows. Null when no percents. */
  custodyPercentOfSupply: number | null
  /** Stage 1 never claims completeness — always false unless a future stage proves full coverage. */
  custodyCoverageComplete: false
  reason: string | null
  evidenceGaps: string[]
}

export type VerifiedCustodyCandidate = {
  /** Holder-list address to match (EVM checksum-insensitive; Solana base58 case-sensitive). */
  address: string
  role: LiquidityCustodyRole
  evidence: string[]
  poolRef?: string | null
  label: string
  /**
   * Must be true before the candidate is eligible. For V4 PoolManager this means a V4 pool
   * for the scanned token was resolved on this chain. For V2/V3 pair/pool contracts, true when
   * the pool address is a verified contract address for this token's market. For Solana vaults,
   * true only when vault was owner-matched to the verified pool for this mint.
   */
  tokenCustodyEstablished: boolean
}

export type EvmPoolCandidateInput = {
  address: string | null | undefined
  poolId?: string | null
  poolAddressType?: 'contract' | 'pool_id' | 'unknown' | string | null
  poolType?: string | null
  dexId?: string | null
  dexName?: string | null
}

/** Independently verified Robinhood Uniswap V4 PoolManager (see uniswapV4RobinhoodRpc.ts). */
export const ROBINHOOD_V4_POOL_MANAGER_ADDRESS = '0x8366a39cc670b4001a1121b8f6a443a643e40951'

const V2_LIKE = new Set(['v2', 'aerodrome'])

function normalizeEvm(address: string | null | undefined): string | null {
  if (typeof address !== 'string') return null
  const n = address.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(n) ? n : null
}

function normalizeSolana(address: string | null | undefined): string | null {
  if (typeof address !== 'string') return null
  const n = address.trim()
  // Base58 mint/account — keep case; reject empty / eth-shaped
  if (!n || /^0x/i.test(n) || n.length < 32 || n.length > 64) return null
  return n
}

function normalizeForChain(chain: LiquidityCustodyChain, address: string | null | undefined): string | null {
  return chain === 'solana' ? normalizeSolana(address) : normalizeEvm(address)
}

function isBytes32PoolId(poolId: string | null | undefined): boolean {
  return typeof poolId === 'string' && /^0x[a-f0-9]{64}$/i.test(poolId.trim())
}

/**
 * Exact scanned-token V4 pool evidence — not name-only market metadata.
 * Requires either an explicit uniswap_v4 poolType, or a valid bytes32 poolId with
 * V4-specific markers (pool_id address type and/or concentrated+uniswap_v4 dex).
 * Bare "uniswap" + pool_id is NOT enough (could be mis-typed V3).
 */
function isVerifiedV4PoolForToken(pool: EvmPoolCandidateInput): boolean {
  // Exact pool identity for the scanned token is mandatory — never name-only metadata.
  if (!isBytes32PoolId(pool.poolId)) return false
  const type = String(pool.poolType ?? '').toLowerCase()
  const dex = `${pool.dexId ?? ''} ${pool.dexName ?? ''}`.toLowerCase()
  const hasV4Dex = /uniswap[_-]?v4|uniswapv4|uniswap\s*v4/.test(dex)
  if (type === 'uniswap_v4') return true
  if (type === 'concentrated' && hasV4Dex) return true
  if (pool.poolAddressType === 'pool_id' && hasV4Dex) return true
  return false
}

function roleLabel(role: LiquidityCustodyRole): string {
  switch (role) {
    case 'amm_pool_reserves':
      return 'Liquidity custody (pool reserves)'
    case 'v4_pool_manager':
      return 'Protocol custody (V4 PoolManager)'
    case 'protocol_vault':
      return 'Protocol custody'
    case 'solana_amm_vault':
      return 'Liquidity custody (AMM vault)'
  }
}

/**
 * Build verified custody candidates from already-resolved EVM pool metadata.
 * No RPC. Dedupes by address (first evidence wins, later poolRefs appended to evidence).
 */
export function buildEvmCustodyCandidates(input: {
  chain: Exclude<LiquidityCustodyChain, 'solana'>
  tokenAddress: string
  pools: EvmPoolCandidateInput[]
}): VerifiedCustodyCandidate[] {
  const token = normalizeEvm(input.tokenAddress)
  if (!token) return []

  const byAddress = new Map<string, VerifiedCustodyCandidate>()

  const upsert = (c: VerifiedCustodyCandidate) => {
    if (!c.tokenCustodyEstablished) return
    const prev = byAddress.get(c.address)
    if (!prev) {
      byAddress.set(c.address, c)
      return
    }
    // Same custody address linked to multiple pools — keep one row, merge evidence/refs.
    const refs = new Set([prev.poolRef, c.poolRef].filter(Boolean) as string[])
    const evidence = [...prev.evidence]
    for (const e of c.evidence) {
      if (!evidence.includes(e)) evidence.push(e)
    }
    byAddress.set(c.address, {
      ...prev,
      evidence,
      poolRef: refs.size <= 1 ? (prev.poolRef ?? c.poolRef ?? null) : `${[...refs].join(',')}`,
      label: prev.label,
    })
  }

  const verifiedV4PoolIds: string[] = []

  for (const pool of input.pools) {
    const addr = normalizeEvm(pool.address)
    // Require explicit poolAddressType — do not infer "contract" from a bare address in
    // unverified market metadata (that would classify arbitrary contracts as custody).
    const addrType = pool.poolAddressType ?? 'unknown'
    const poolType = String(pool.poolType ?? 'unknown').toLowerCase()

    if (isVerifiedV4PoolForToken(pool) && isBytes32PoolId(pool.poolId)) {
      const id = pool.poolId!.trim().toLowerCase()
      if (!verifiedV4PoolIds.includes(id)) verifiedV4PoolIds.push(id)
    }

    // V2-like pair contract holds ERC-20 reserves of both tokens.
    if (
      addr
      && addrType === 'contract'
      && V2_LIKE.has(poolType)
      && addr !== token
    ) {
      upsert({
        address: addr,
        role: 'amm_pool_reserves',
        label: roleLabel('amm_pool_reserves'),
        poolRef: addr,
        tokenCustodyEstablished: true,
        evidence: [
          `holder_address_equals_verified_${poolType}_pool_contract`,
          `pool_address_type=contract`,
          `scanned_token=${token}`,
        ],
      })
      continue
    }

    // V3 / concentrated pool contracts hold token balances in-pool (not LP ERC-20 semantics).
    // Exclude uniswap_v4 (reserves live in PoolManager, not a per-pool contract holder).
    if (
      addr
      && addrType === 'contract'
      && (poolType === 'v3' || poolType === 'concentrated')
      && !isVerifiedV4PoolForToken(pool)
      && addr !== token
    ) {
      upsert({
        address: addr,
        role: 'amm_pool_reserves',
        label: roleLabel('amm_pool_reserves'),
        poolRef: addr,
        tokenCustodyEstablished: true,
        evidence: [
          `holder_address_equals_verified_${poolType}_pool_contract`,
          `pool_address_type=contract`,
          `scanned_token=${token}`,
        ],
      })
    }
  }

  // Robinhood V4: shared PoolManager — only with exact scanned-token V4 poolId evidence.
  // Never attribute the singleton balance to one pool (poolRef stays null).
  if (input.chain === 'robinhood' && verifiedV4PoolIds.length > 0) {
    upsert({
      address: ROBINHOOD_V4_POOL_MANAGER_ADDRESS,
      role: 'v4_pool_manager',
      label: roleLabel('v4_pool_manager'),
      poolRef: null,
      tokenCustodyEstablished: true,
      evidence: [
        'chain_verified_uniswap_v4_pool_manager',
        'scanned_token_has_verified_v4_pool',
        'shared_singleton_not_attributed_to_single_pool',
        `verified_v4_pool_ids=${verifiedV4PoolIds.join(',')}`,
        `scanned_token=${token}`,
      ],
    })
  }

  return [...byAddress.values()]
}

/**
 * Solana vault candidates — ONLY addresses already verified as vaults for this mint
 * (e.g. clusterMap lp_vault nodes where ATA owner === verified pool). Never treat
 * owner-program heuristics or pool address alone as vault proof for a token account.
 */
export function buildSolanaCustodyCandidates(input: {
  mintAddress: string
  verifiedVaultAccounts: Array<{ address: string; poolRef?: string | null; evidence?: string[] }>
}): VerifiedCustodyCandidate[] {
  const mint = normalizeSolana(input.mintAddress)
  if (!mint) return []
  const byAddress = new Map<string, VerifiedCustodyCandidate>()
  for (const v of input.verifiedVaultAccounts) {
    const addr = normalizeSolana(v.address)
    if (!addr || addr === mint) continue
    const prev = byAddress.get(addr)
    if (prev) {
      const evidence = [...prev.evidence]
      for (const e of v.evidence ?? []) {
        if (!evidence.includes(e)) evidence.push(e)
      }
      byAddress.set(addr, { ...prev, evidence })
      continue
    }
    byAddress.set(addr, {
      address: addr,
      role: 'solana_amm_vault',
      label: roleLabel('solana_amm_vault'),
      poolRef: v.poolRef ?? null,
      tokenCustodyEstablished: true,
      evidence: [
        'verified_vault_address_for_scanned_mint',
        ...(v.evidence ?? []),
        `scanned_mint=${mint}`,
      ],
    })
  }
  return [...byAddress.values()]
}

export function annotateLiquidityCustody<T extends { address: string; percent?: number | null }>(input: {
  chain: LiquidityCustodyChain
  holders: T[]
  candidates: VerifiedCustodyCandidate[]
}): {
  holders: AnnotatedHolderRow<T>[]
  liquidityCustody: LiquidityCustodySummary
  /** Snapshot of top1/10/20 inputs for regression — percentages on rows are untouched. */
  percentsUnchanged: true
} {
  const eligible = input.candidates.filter((c) => c.tokenCustodyEstablished)
  const candidateByAddr = new Map<string, VerifiedCustodyCandidate>()
  for (const c of eligible) {
    const key = normalizeForChain(input.chain, c.address)
    if (!key) continue
    if (!candidateByAddr.has(key)) candidateByAddr.set(key, { ...c, address: key })
  }

  const custodySeen = new Set<string>()
  const custodyRows: LiquidityCustodyRow[] = []
  const annotated: AnnotatedHolderRow<T>[] = input.holders.map((h) => {
    const key = normalizeForChain(input.chain, h.address)
    if (!key) {
      return {
        ...h,
        classification: { kind: 'unclassified', evidence: ['address_normalization_failed'] },
      }
    }
    const match = candidateByAddr.get(key)
    if (!match) {
      return {
        ...h,
        classification: { kind: 'ordinary', evidence: ['no_verified_liquidity_custody_match'] },
      }
    }
    const classification: HolderClassification = {
      kind: 'liquidity_custody',
      role: match.role,
      label: match.label,
      evidence: match.evidence,
    }
    if (!custodySeen.has(key)) {
      custodySeen.add(key)
      custodyRows.push({
        address: key,
        role: match.role,
        percentOfSupply: typeof h.percent === 'number' && Number.isFinite(h.percent) ? h.percent : null,
        evidence: match.evidence,
        poolRef: match.poolRef ?? null,
        label: match.label,
      })
    }
    return { ...h, classification }
  })

  const percents = custodyRows
    .map((r) => r.percentOfSupply)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  const custodyPercentOfSupply = percents.length > 0 ? percents.reduce((a, b) => a + b, 0) : null

  const evidenceGaps: string[] = []
  if (eligible.length === 0) {
    evidenceGaps.push(
      input.chain === 'solana'
        ? 'No verified AMM vault addresses were supplied for this mint — token accounts left unclassified (owner field alone is not vault proof).'
        : 'No verified pool/reserve custody candidates were resolved for this token.',
    )
  } else if (custodyRows.length === 0) {
    evidenceGaps.push('Verified custody candidates were available, but none appear in the returned holder sample.')
  }
  evidenceGaps.push('Custody coverage is incomplete by design in Stage 1 — only matches inside the returned holder sample are annotated; complete pool-universe coverage is not claimed.')

  let status: LiquidityCustodySummary['status']
  let reason: string | null
  if (input.holders.length === 0) {
    status = 'unavailable'
    reason = 'holder_rows_unavailable'
  } else if (custodyRows.length > 0) {
    status = 'partial'
    reason = 'verified_custody_matches_in_holder_sample'
  } else if (eligible.length === 0) {
    status = 'none'
    reason = 'no_verified_custody_candidates'
  } else {
    status = 'none'
    reason = 'candidates_not_present_in_holder_sample'
  }

  return {
    holders: annotated,
    liquidityCustody: {
      status,
      rows: custodyRows,
      custodyPercentOfSupply,
      custodyCoverageComplete: false,
      reason,
      evidenceGaps,
    },
    percentsUnchanged: true,
  }
}

/** Extract Solana lp_vault node addresses from an already-built cluster map (no new RPC). */
export function verifiedVaultsFromSolanaClusterMap(clusterMap: {
  nodes?: Array<{ address?: string | null; role?: string | null; evidence?: string[] | null }>
} | null | undefined): Array<{ address: string; poolRef?: string | null; evidence?: string[] }> {
  if (!clusterMap?.nodes?.length) return []
  const out: Array<{ address: string; poolRef?: string | null; evidence?: string[] }> = []
  for (const n of clusterMap.nodes) {
    if (n.role !== 'lp_vault' || typeof n.address !== 'string') continue
    out.push({
      address: n.address,
      evidence: Array.isArray(n.evidence) ? n.evidence.filter((e) => typeof e === 'string') : ['cluster_map_lp_vault_node'],
    })
  }
  return out
}

// ── Stage 2: ordinary holder concentration (excludes verified liquidity custody only) ─────────

export const ORDINARY_PERCENTAGES_UNAVAILABLE_REASON = 'holder_percentages_unavailable'

export type OrdinaryCoverageStatus = 'verified' | 'partial' | 'insufficient' | 'not_computed'

export type OrdinaryCoverage = {
  /**
   * `verified` means verified for the requested ordinary Top-N window ONLY
   * (see `verifiedScope`). It never implies `custodyCoverageComplete === true`
   * or complete knowledge of every liquidity-custody address for the token.
   */
  status: OrdinaryCoverageStatus
  /** Scope of `status`. Always the requested ordinary Top-N window from the holder sample. */
  verifiedScope: 'requested_ordinary_top_n_window'
  /** Always false: ordinary coverage never asserts a complete liquidity-custody census. */
  impliesCompleteCustodyCoverage: false
  excludedCustodyCount: number
  excludedCustodyPercent: number | null
  sourceRowCount: number
  requestedDepth: number
  reason: string
  evidence: string[]
}

export type OrdinaryConcentrationSeries = {
  ordinaryTop1: number | null
  ordinaryTop5: number | null
  ordinaryTop10: number | null
  ordinaryTop20: number | null
  ordinaryCoverage: OrdinaryCoverage
  /** Total-supply Top-N from the same rows — must stay bit-identical to legacy series. */
  totalTop1: number | null
  totalTop5: number | null
  totalTop10: number | null
  totalTop20: number | null
}

function sumTopN(rows: Array<{ percent?: number | null }>, n: number): number | null {
  if (rows.length === 0) return null
  let sum = 0
  const limit = Math.min(n, rows.length)
  for (let i = 0; i < limit; i++) {
    const p = rows[i]?.percent
    if (typeof p === 'number' && Number.isFinite(p)) sum += p
  }
  return sum
}

function isVerifiedLiquidityCustodyRow(row: {
  classification?: HolderClassification | null
}): boolean {
  const c = row.classification
  return (
    c?.kind === 'liquidity_custody'
    && Array.isArray(c.evidence)
    && c.evidence.length > 0
  )
}

/**
 * Stage-2 ordinary concentration: parallel Top-N that excludes ONLY verified
 * liquidity_custody rows. Denominator remains total token supply (row percents
 * unchanged). Does not invent rows. Does not imply LP lock/ownership.
 *
 * Coverage status is `verified` only when ranking depth and exclusion evidence
 * are sufficient for `requestedDepth` (default 10 — Ordinary Top 10). Otherwise partial /
 * insufficient / not_computed — never present as verified in UI.
 */
export function computeOrdinaryConcentration<
  T extends { address: string; percent?: number | null; classification?: HolderClassification | null },
>(input: {
  holders: T[]
  requestedDepth?: number
  /**
   * Solana Stage 2: pass false when no verified vault evidence exists — series
   * is not_computed (do not publish ordinary tops as if they were custody-aware).
   * EVM: omit / true after Stage-1 annotation has run.
   */
  custodyEvidenceAvailable?: boolean
}): OrdinaryConcentrationSeries {
  const requestedDepth = Math.max(1, Math.min(20, input.requestedDepth ?? 10))
  const holders = input.holders ?? []
  const emptyCoverage = (status: OrdinaryCoverageStatus, reason: string, evidence: string[] = []): OrdinaryCoverage => ({
    status,
    verifiedScope: 'requested_ordinary_top_n_window',
    impliesCompleteCustodyCoverage: false,
    excludedCustodyCount: 0,
    excludedCustodyPercent: null,
    sourceRowCount: holders.length,
    requestedDepth,
    reason,
    evidence,
  })

  const totalTop1 = sumTopN(holders, 1)
  const totalTop5 = sumTopN(holders, 5)
  const totalTop10 = sumTopN(holders, 10)
  const totalTop20 = sumTopN(holders, 20)

  if (input.custodyEvidenceAvailable === false) {
    return {
      ordinaryTop1: null,
      ordinaryTop5: null,
      ordinaryTop10: null,
      ordinaryTop20: null,
      ordinaryCoverage: emptyCoverage(
        'not_computed',
        'ordinary_series_requires_verified_custody_evidence',
        ['solana_or_gated_path_without_verified_vault_or_pool_evidence'],
      ),
      totalTop1,
      totalTop5,
      totalTop10,
      totalTop20,
    }
  }

  if (holders.length === 0) {
    return {
      ordinaryTop1: null,
      ordinaryTop5: null,
      ordinaryTop10: null,
      ordinaryTop20: null,
      ordinaryCoverage: emptyCoverage('not_computed', 'holder_rows_unavailable', ['no_holder_rows']),
      totalTop1,
      totalTop5,
      totalTop10,
      totalTop20,
    }
  }

  // Ordinary Top-N is a sum of real total-supply percentages. Rows without a usable percent
  // (no real total supply, transfer-evidence-not-current, unknown Solana mint supply) must not
  // be summed as 0 and published as a verified 0% — the series is unavailable instead.
  if (holders.some((h) => typeof h.percent !== 'number' || !Number.isFinite(h.percent))) {
    return {
      ordinaryTop1: null,
      ordinaryTop5: null,
      ordinaryTop10: null,
      ordinaryTop20: null,
      ordinaryCoverage: emptyCoverage('not_computed', ORDINARY_PERCENTAGES_UNAVAILABLE_REASON, ['holder_rows_missing_total_supply_percentages']),
      totalTop1,
      totalTop5,
      totalTop10,
      totalTop20,
    }
  }

  const ordinary: T[] = []
  const excluded: T[] = []
  const evidence: string[] = [
    'denominator_is_total_token_supply',
    'exclude_only_classification_kind_liquidity_custody_with_evidence',
    'unknown_unclassified_and_ordinary_rows_remain_included',
    'pool_custody_exclusion_does_not_imply_lp_lock_or_ownership',
    'coverage_scope_is_requested_ordinary_top_n_window_only',
    'does_not_imply_custody_coverage_complete',
  ]

  let unclassifiedInWindow = false
  let weakCustodyLabel = false
  const excludedAddresses = new Set<string>()
  let duplicateCustodyRows = 0

  for (let i = 0; i < holders.length; i++) {
    const row = holders[i]
    const kind = row.classification?.kind

    if (isVerifiedLiquidityCustodyRow(row)) {
      // Duplicate address rows are removed from ranking but counted once, so
      // excludedCustodyCount / excludedCustodyPercent never double-count supply.
      const key = String(row.address ?? '').toLowerCase()
      if (key && excludedAddresses.has(key)) {
        duplicateCustodyRows += 1
        continue
      }
      if (key) excludedAddresses.add(key)
      excluded.push(row)
      continue
    }

    if (kind === 'liquidity_custody') {
      // Labeled custody without evidence — must NOT exclude; coverage cannot be verified.
      weakCustodyLabel = true
      ordinary.push(row)
    } else if (kind === 'unclassified') {
      if (ordinary.length < requestedDepth) unclassifiedInWindow = true
      ordinary.push(row)
    } else {
      // ordinary or missing classification — include
      ordinary.push(row)
    }
  }

  const excludedCustodyCount = excluded.length
  const excludedPercents = excluded
    .map((r) => r.percent)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  const excludedCustodyPercent = excludedPercents.length > 0
    ? excludedPercents.reduce((a, b) => a + b, 0)
    : null

  if (duplicateCustodyRows > 0) {
    evidence.push(`duplicate_custody_address_rows_excluded_once=${duplicateCustodyRows}`)
  }
  if (excludedCustodyCount > 0) {
    evidence.push(`excluded_verified_custody_rows=${excludedCustodyCount}`)
    if (excludedCustodyPercent != null) {
      evidence.push(`excluded_custody_percent_of_supply=${excludedCustodyPercent}`)
    }
  }

  // Exact Top-N only when ≥ N ordinary rows exist. Never invent rows or soft-fill a short list
  // as if it were Top-N (partial status carries the reason; UI must not present as verified).
  const ordinaryTop1 = ordinary.length >= 1 ? sumTopN(ordinary, 1) : null
  const ordinaryTop5 = ordinary.length >= 5 ? sumTopN(ordinary, 5) : null
  const ordinaryTop10 = ordinary.length >= 10 ? sumTopN(ordinary, 10) : null
  const ordinaryTop20 = ordinary.length >= 20 ? sumTopN(ordinary, 20) : null

  const hasEnoughForDepth = ordinary.length >= requestedDepth

  // Completeness: count exclusions before collecting `requestedDepth` ordinary rows.
  let ordinaryCollected = 0
  let exclusionsBeforeDepth = 0
  let headEndIndex = 0
  for (let i = 0; i < holders.length; i++) {
    headEndIndex = i + 1
    if (isVerifiedLiquidityCustodyRow(holders[i])) {
      if (ordinaryCollected < requestedDepth) exclusionsBeforeDepth += 1
      continue
    }
    ordinaryCollected += 1
    if (ordinaryCollected >= requestedDepth) break
  }
  const headComplete = ordinaryCollected >= requestedDepth && holders.length >= headEndIndex

  let status: OrdinaryCoverageStatus
  let reason: string

  if (ordinary.length === 0) {
    status = 'insufficient'
    reason = excludedCustodyCount > 0
      ? 'all_sample_rows_were_verified_liquidity_custody'
      : 'no_ordinary_rows_with_usable_ranking'
    evidence.push(reason)
  } else if (
    headComplete
    && hasEnoughForDepth
    && !unclassifiedInWindow
    && !weakCustodyLabel
    && excluded.every((r) => isVerifiedLiquidityCustodyRow(r))
  ) {
    status = 'verified'
    reason = 'ordinary_top_n_window_verified_from_holder_sample_not_full_custody_census'
    evidence.push(
      `ordinary_rows_available=${ordinary.length}`,
      `exclusions_before_depth_${requestedDepth}=${exclusionsBeforeDepth}`,
      'holder_sample_head_complete_for_requested_depth',
      'no_unclassified_rows_in_ordinary_top_n_window',
    )
  } else if (!hasEnoughForDepth) {
    status = 'partial'
    reason = 'insufficient_ordinary_holder_depth_for_requested_n'
    evidence.push(
      `ordinary_rows_available=${ordinary.length}`,
      `requested_depth=${requestedDepth}`,
      'do_not_invent_missing_holder_rows',
    )
    if (unclassifiedInWindow) evidence.push('unclassified_rows_present_in_ranking_window')
    if (weakCustodyLabel) evidence.push('custody_label_without_evidence_kept_in_ordinary_series')
  } else {
    status = 'partial'
    reason = unclassifiedInWindow
      ? 'unclassified_rows_in_ranking_window_block_verified_ordinary_top_n'
      : weakCustodyLabel
        ? 'unverified_custody_label_in_sample_blocks_verified_ordinary_top_n'
        : 'ordinary_ranking_coverage_incomplete'
    if (unclassifiedInWindow) evidence.push('unclassified_rows_present_in_ranking_window')
    if (weakCustodyLabel) evidence.push('custody_label_without_evidence_kept_in_ordinary_series')
    if (!headComplete) evidence.push('holder_sample_head_incomplete_for_requested_depth')
  }

  return {
    ordinaryTop1,
    ordinaryTop5,
    ordinaryTop10,
    ordinaryTop20,
    ordinaryCoverage: {
      status,
      verifiedScope: 'requested_ordinary_top_n_window',
      impliesCompleteCustodyCoverage: false,
      excludedCustodyCount,
      excludedCustodyPercent,
      sourceRowCount: holders.length,
      requestedDepth,
      reason,
      evidence,
    },
    totalTop1,
    totalTop5,
    totalTop10,
    totalTop20,
  }
}
