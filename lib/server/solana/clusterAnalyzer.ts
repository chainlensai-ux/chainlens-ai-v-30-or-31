// SOLANA CLUSTER MAP / DEV INTELLIGENCE GRAPH, DISCLOSED (Dev Intelligence engine completion —
// upgraded from a creator-trace-plus-authorities read into a full relationship graph). DEEP MODE
// ONLY — never called on a normal scan; only when the caller explicitly runs Deep Cluster Check
// (mirrors deepCreatorAnalyzer.ts's own opt-in contract, see that module's header for the cost
// disclosure).
//
// WHAT THIS RESOLVES, REAL EVIDENCE ONLY, EACH FROM A PROVIDER ALREADY WIRED INTO THIS ENGINE:
//  - Creator wallet + fee-payer edge to the mint — Helius Enhanced Transactions (deepCreatorAnalyzer.ts).
//  - Funding wallet chain, up to TWO real hops — who first sent SOL into the creator wallet, and
//    who first sent SOL into THAT wallet — Helius Enhanced Transactions (fetchHeliusWalletFundingTrace,
//    called once per hop, bounded).
//  - Mint authority / freeze authority nodes — Alchemy/Solana RPC getAccountInfo (mintAnalyzer.ts),
//    only added when that authority is actually still active. A wallet that appears in MULTIPLE
//    roles (e.g. the creator still holds mint authority) is merged into ONE node carrying every
//    role's evidence — that merge IS the "shared authority" discovery, verified by address
//    equality, never by heuristic.
//  - LP pool node — Solana RPC getAccountInfo pool-owner read (poolAnalyzer.ts), when confirmed.
//  - Top holder nodes — the real getTokenLargestAccounts sample (holderAnalyzer.ts) with each
//    token ACCOUNT's real address, plus ONE getMultipleAccounts (jsonParsed) call resolving each
//    account's OWNER wallet. An account owned by the verified pool address is a REAL LP VAULT
//    (cross-provider agreement: DexScreener's pool address confirmed against Alchemy's on-chain
//    owner read). An account owned by the creator/funder is a REAL insider-holding discovery.
//  - Prior launch-shaped events — a bounded recent-activity sample of the creator wallet
//    (fetchHeliusCreatorRecentLaunches). SAMPLE ONLY, permanently: presented as "observed in the
//    creator's most recent activity", never as a full launch history.
//
// CONFIDENCE, DISCLOSED: computed from evidence quality — relationship count, whether signature
// pagination genuinely reached genesis, cross-provider agreement (vault identification), and the
// fraction of nodes verified at high confidence. 'low' appears only when evidence is genuinely
// thin, never as a default placeholder. Same for risk: 'unknown' only when fewer than two real
// risk signals resolved.
//
// WHAT THIS DELIBERATELY DOES NOT DO, DISCLOSED (see `unresolvedRelationships` in the result for
// the user-facing version of this list): Metaplex UPDATE AUTHORITY requires deriving the metadata
// PDA, which needs ed25519 on-curve checks — no Solana SDK exists in this codebase's dependencies,
// so it is reported as unresolvable rather than guessed. TREASURY / EXCHANGE / MARKET-MAKER wallet
// labels require a wallet-labeling provider this codebase does not have. CROSS-MINT shared-signer /
// shared-ATA-creation relationships require indexing every candidate wallet's full history
// (unbounded, no indexer). FULL launch history requires the same. Claiming any of those from a
// shallow read would be fabricated evidence; each is disclosed with its reason instead.

import type { SolanaCreatorTraceResult } from '../solanaProviders.ts'
import {
  fetchHeliusWalletFundingTrace,
  fetchHeliusCreatorRecentLaunches,
  type SolanaWalletFundingTraceResult,
  type SolanaCreatorRecentLaunchesResult,
} from '../solanaProviders.ts'
import { solanaRpc, type RpcFetch } from './rpcClient.ts'
import type { SolanaPoolProgram, SolanaTopAccountShare } from './types.ts'

export type SolanaClusterRelationship =
  | 'funding_wallet' | 'first_sol_sender' | 'shared_fee_payer'
  | 'mint_authority' | 'freeze_authority' | 'lp_creation' | 'pumpfun_migration'
  | 'holds_supply' | 'vault_of' | 'prior_launch'

export type SolanaClusterEdge = {
  id: string
  from: string
  to: string
  relationship: SolanaClusterRelationship
  evidence: string
  signature: string | null
}

export type SolanaClusterNodeRole =
  | 'mint' | 'creator_wallet' | 'funding_wallet' | 'mint_authority' | 'freeze_authority' | 'lp_pool'
  | 'top_holder' | 'lp_vault' | 'prior_mint'
export type SolanaClusterNodeConfidence = 'high' | 'medium' | 'low'
export type SolanaClusterNodeRisk = 'elevated' | 'standard' | 'neutral' | 'unknown'

export type SolanaClusterNode = {
  id: string
  address: string
  label: string
  role: SolanaClusterNodeRole
  confidence: SolanaClusterNodeConfidence
  risk: SolanaClusterNodeRisk
  evidence: string[]
  /**
   * This node's REAL share of tracked supply, when that is a meaningful and measured fact for it —
   * i.e. top-holder, LP-vault, and any wallet whose owner-verified token account(s) were found in
   * the getTokenLargestAccounts sample (including a creator/funder/authority that also turns out to
   * hold supply). Summed across every token account resolving to the same owner, exactly the value
   * already cited in that node's own evidence text.
   *
   * Null means NOT APPLICABLE OR NOT MEASURED, never "zero": the mint itself has no share of its
   * own supply, and a wallet outside the largest-accounts sample has an unmeasured (not absent)
   * balance. Consumers sizing a bubble by this MUST render null as a neutral default size, never as
   * an empty/minimal bubble that would read as a verified "holds nothing" claim.
   */
  supplyPercent: number | null
}

export type SolanaClusterConfidence = 'none' | 'low' | 'medium' | 'high'
export type SolanaClusterRiskLevel = 'unknown' | 'standard' | 'elevated'

export type SolanaClusterMap = {
  attempted: boolean
  /** True when Deep Creator Check resolved a likely creator wallet for this graph. */
  creatorResolved: boolean
  nodes: SolanaClusterNode[]
  edges: SolanaClusterEdge[]
  evidenceCount: number
  clusterConfidence: SolanaClusterConfidence
  /** Every reason the confidence landed where it did — real, evidence-cited, never generic. */
  confidenceFactors: string[]
  fundingPath: string[]
  /** Number of real funding hops verified (fundingPath.length - 1). 0 when only the creator wallet is known. */
  fundingDepth: number
  riskLevel: SolanaClusterRiskLevel
  riskReason: string
  /** Every individual risk signal that fed riskLevel — real, evidence-cited. */
  riskFactors: string[]
  summary: string
  fundingTrace: SolanaWalletFundingTraceResult | null
  recentLaunches: SolanaCreatorRecentLaunchesResult | null
  ownerResolution: { attempted: boolean; resolvedCount: number; errorReason: string | null }
  /** The relationships this engine genuinely cannot verify, each with the concrete reason why. */
  unresolvedRelationships: Array<{ label: string; reason: string }>
  /** Highest single-account share EXCLUDING accounts verified as pool-owned LP vaults. Null when holder data was unavailable. */
  vaultAdjustedTop1Percent: number | null
}

const FRESH_FUNDING_SOL_THRESHOLD = 0.05
const MAX_HOLDER_NODES = 15
const MAX_PRIOR_MINT_NODES = 5

const UNRESOLVED_RELATIONSHIPS: Array<{ label: string; reason: string }> = [
  { label: 'Update authority (Metaplex)', reason: 'Deriving the metadata PDA requires ed25519 on-curve math no dependency in this codebase provides — reported as unresolvable rather than guessed.' },
  { label: 'Treasury / Exchange / Market-maker labels', reason: 'No wallet-labeling provider is connected — classifying a wallet into these roles without one would be a fabricated label.' },
  { label: 'Cross-mint shared signers / shared ATA creation', reason: 'Requires indexing every candidate wallet\'s full transaction history across the chain — unbounded without an indexer this codebase does not have.' },
  { label: 'Full launch history', reason: 'Only a bounded recent-activity sample of the creator wallet is parsed — a complete launch history requires full-history indexing.' },
]

/** One getMultipleAccounts (jsonParsed) call resolving each top token ACCOUNT's owner wallet. */
async function resolveTokenAccountOwners(
  addresses: string[],
  rpcUrl: string,
  fetchImpl: RpcFetch,
): Promise<{ owners: Map<string, string>; attempted: boolean; errorReason: string | null }> {
  if (addresses.length === 0) return { owners: new Map(), attempted: false, errorReason: null }
  type MultiResp = { value?: Array<{ data?: { parsed?: { info?: { owner?: string } } } } | null> }
  const res = await solanaRpc<MultiResp>(rpcUrl, 'getMultipleAccounts', [addresses, { encoding: 'jsonParsed' }], fetchImpl)
  if (!res.ok) return { owners: new Map(), attempted: true, errorReason: res.error }
  const owners = new Map<string, string>()
  const rows = Array.isArray(res.result?.value) ? res.result.value : []
  rows.forEach((row, i) => {
    const owner = row?.data?.parsed?.info?.owner
    if (typeof owner === 'string' && owner.length > 0 && addresses[i]) owners.set(addresses[i], owner)
  })
  return { owners, attempted: true, errorReason: null }
}

export async function analyzeSolanaCluster(params: {
  mintAddress: string
  creatorTrace: SolanaCreatorTraceResult
  mintAuthority: string | null
  freezeAuthority: string | null
  /** Distinguishes "revoked" from "couldn't read" for the risk engine — never treat an unread authority as revoked. */
  authorityReadSucceeded?: boolean
  poolProgram: SolanaPoolProgram
  fetchImpl: RpcFetch
  /** The scan's own RPC endpoint — enables the one getMultipleAccounts owner-resolution call. Owner resolution is skipped (disclosed) when absent. */
  rpcUrl?: string | null
  /** The real getTokenLargestAccounts sample from holderAnalyzer — enables top-holder / LP-vault nodes. */
  topAccounts?: SolanaTopAccountShare[] | null
}): Promise<SolanaClusterMap> {
  const { mintAddress, creatorTrace, mintAuthority, freezeAuthority, poolProgram, fetchImpl } = params
  const authorityReadSucceeded = params.authorityReadSucceeded ?? (mintAuthority != null || freezeAuthority != null)
  const rpcUrl = params.rpcUrl ?? null
  const topAccounts = (params.topAccounts ?? []).filter((a) => a.address.length > 0).slice(0, MAX_HOLDER_NODES)
  const creatorWallet = creatorTrace.resolved.likelyCreatorWallet
  const creatorResolved = creatorWallet != null

  // ── Node store: one node per ADDRESS. A wallet appearing in multiple roles merges into the
  // first (highest-priority) role's node, appending the later role's evidence — that merge is the
  // real "shared authority / insider holding" discovery, by address equality. ──────────────────
  const nodesByAddress = new Map<string, SolanaClusterNode>()
  const edges: SolanaClusterEdge[] = []
  const addNode = (node: SolanaClusterNode): SolanaClusterNode => {
    const existing = nodesByAddress.get(node.address)
    if (!existing) { nodesByAddress.set(node.address, node); return node }
    existing.evidence.push(...node.evidence)
    // A merged node's risk keeps the more severe of the two reads.
    if (node.risk === 'elevated') existing.risk = 'elevated'
    return existing
  }
  const addEdge = (edge: SolanaClusterEdge) => { if (!edges.some((e) => e.id === edge.id)) edges.push(edge) }

  addNode({
    id: mintAddress, address: mintAddress, label: 'Token mint', role: 'mint', confidence: 'high', risk: 'neutral',
    evidence: ['This is the scanned mint account.'],
    supplyPercent: null, // Not applicable: a mint holds no share of its own supply.
  })

  // ── Creator wallet + parallel deep reads (funding hop 1, recent launches, owner resolution) ──
  let fundingTrace: SolanaWalletFundingTraceResult | null = null
  let fundingTraceHop2: SolanaWalletFundingTraceResult | null = null
  let recentLaunches: SolanaCreatorRecentLaunchesResult | null = null

  const ownerResolutionPromise = rpcUrl && topAccounts.length > 0
    ? resolveTokenAccountOwners(topAccounts.map((a) => a.address), rpcUrl, fetchImpl)
    : Promise.resolve({ owners: new Map<string, string>(), attempted: false, errorReason: null })

  if (creatorResolved && creatorWallet) {
    const creatorConfidence: SolanaClusterNodeConfidence = creatorTrace.reachedGenesis && creatorTrace.resolved.transactionSource ? 'high' : creatorTrace.reachedGenesis ? 'medium' : 'low'
    addNode({
      id: creatorWallet, address: creatorWallet, label: 'Creator wallet', role: 'creator_wallet', confidence: creatorConfidence, risk: 'unknown',
      evidence: [`Paid fees for this mint's earliest found transaction${creatorTrace.resolved.transactionSource ? ` (source: ${creatorTrace.resolved.transactionSource})` : ''}.`],
      supplyPercent: null, // Unmeasured here; set below only if this wallet also appears in the largest-accounts sample.
    })
    addEdge({
      id: `${creatorWallet}->${mintAddress}:shared_fee_payer`,
      from: creatorWallet, to: mintAddress, relationship: 'shared_fee_payer',
      evidence: `${creatorWallet} paid fees for this mint's earliest found transaction${creatorTrace.resolved.transactionSource ? ` (source: ${creatorTrace.resolved.transactionSource})` : ''}.`,
      signature: creatorTrace.resolved.earliestSignature,
    })
    ;[fundingTrace, recentLaunches] = await Promise.all([
      fetchHeliusWalletFundingTrace(creatorWallet, fetchImpl),
      fetchHeliusCreatorRecentLaunches(creatorWallet, mintAddress, fetchImpl),
    ])
  }
  const ownerResolution = await ownerResolutionPromise

  const fundingPath: string[] = creatorWallet ? [creatorWallet] : []

  // ── Funding hop 1 (+ hop 2 when hop 1 resolved) ──────────────────────────────
  if (creatorWallet && fundingTrace?.success && fundingTrace.resolved.fundingWallet) {
    const funder = fundingTrace.resolved.fundingWallet
    const amountLabel = fundingTrace.resolved.fundingAmountSol != null ? ` (${fundingTrace.resolved.fundingAmountSol.toFixed(4)} SOL)` : ''
    const isFresh = fundingTrace.resolved.fundingAmountSol != null && fundingTrace.resolved.fundingAmountSol <= FRESH_FUNDING_SOL_THRESHOLD
    addNode({
      id: funder, address: funder, label: 'Funding wallet', role: 'funding_wallet',
      confidence: fundingTrace.reachedGenesis ? 'medium' : 'low',
      risk: isFresh ? 'elevated' : 'standard',
      evidence: [`Sent the first SOL transfer into ${creatorWallet}${amountLabel}, found in that wallet's earliest transaction.`],
      supplyPercent: null, // Unmeasured here; set below only if this wallet also appears in the largest-accounts sample.
    })
    const creatorNode = nodesByAddress.get(creatorWallet)
    if (creatorNode) {
      creatorNode.risk = isFresh ? 'elevated' : 'standard'
      creatorNode.evidence.push(`Funded by ${funder}${amountLabel} — ${isFresh ? 'a rent-level amount, a pattern common to disposable deployer wallets' : 'above the disposable-wallet threshold this engine flags'}.`)
    }
    addEdge({
      id: `${funder}->${creatorWallet}:funding_wallet`,
      from: funder, to: creatorWallet, relationship: 'funding_wallet',
      evidence: `${funder} sent the first SOL transfer into ${creatorWallet}${amountLabel}, found in that wallet's earliest transaction.`,
      signature: fundingTrace.resolved.walletEarliestSignature,
    })
    fundingPath.unshift(funder)

    // Hop 2: who first funded the funder — one more bounded, real trace, never inferred.
    fundingTraceHop2 = await fetchHeliusWalletFundingTrace(funder, fetchImpl)
    if (fundingTraceHop2.success && fundingTraceHop2.resolved.fundingWallet && fundingTraceHop2.resolved.fundingWallet !== funder) {
      const funder2 = fundingTraceHop2.resolved.fundingWallet
      const amount2 = fundingTraceHop2.resolved.fundingAmountSol != null ? ` (${fundingTraceHop2.resolved.fundingAmountSol.toFixed(4)} SOL)` : ''
      addNode({
        id: funder2, address: funder2, label: 'Funding wallet (hop 2)', role: 'funding_wallet',
        confidence: fundingTraceHop2.reachedGenesis ? 'medium' : 'low', risk: 'neutral',
        evidence: [`Sent the first SOL transfer into ${funder}${amount2} — the second verified hop up the funding chain.`],
        supplyPercent: null, // Unmeasured here; set below only if this wallet also appears in the largest-accounts sample.
      })
      addEdge({
        id: `${funder2}->${funder}:funding_wallet`,
        from: funder2, to: funder, relationship: 'funding_wallet',
        evidence: `${funder2} sent the first SOL transfer into ${funder}${amount2}, found in that wallet's earliest transaction.`,
        signature: fundingTraceHop2.resolved.walletEarliestSignature,
      })
      fundingPath.unshift(funder2)
    }
  }

  // ── Mint / freeze authority — merged into an existing node when the address matches one ──────
  if (mintAuthority) {
    const merged = nodesByAddress.has(mintAuthority)
    addNode({
      id: mintAuthority, address: mintAuthority, label: 'Mint authority', role: 'mint_authority', confidence: 'high', risk: 'elevated',
      evidence: [`Verified on-chain as the active mint authority for ${mintAddress} — can mint additional supply at any time${merged ? '. SHARED ROLE: this wallet already appears in this graph in another verified role' : ''}.`],
      supplyPercent: null, // Unmeasured here; set below only if this wallet also appears in the largest-accounts sample.
    })
    addEdge({
      id: `${mintAuthority}->${mintAddress}:mint_authority`,
      from: mintAuthority, to: mintAddress, relationship: 'mint_authority',
      evidence: `${mintAuthority} is the active mint authority on this mint's own account (Alchemy/Solana RPC getAccountInfo).`,
      signature: null,
    })
  }
  if (freezeAuthority) {
    const merged = nodesByAddress.has(freezeAuthority)
    addNode({
      id: freezeAuthority, address: freezeAuthority, label: 'Freeze authority', role: 'freeze_authority', confidence: 'high', risk: 'elevated',
      evidence: [`Verified on-chain as the active freeze authority for ${mintAddress} — can freeze any holder's token account${merged ? '. SHARED ROLE: this wallet already appears in this graph in another verified role' : ''}.`],
      supplyPercent: null, // Unmeasured here; set below only if this wallet also appears in the largest-accounts sample.
    })
    addEdge({
      id: `${freezeAuthority}->${mintAddress}:freeze_authority`,
      from: freezeAuthority, to: mintAddress, relationship: 'freeze_authority',
      evidence: `${freezeAuthority} is the active freeze authority on this mint's own account (Alchemy/Solana RPC getAccountInfo).`,
      signature: null,
    })
  }

  // ── LP pool ──────────────────────────────────────────────────────────────────
  const poolAddress = poolProgram.resolved && poolProgram.poolAddress ? poolProgram.poolAddress : null
  if (poolAddress) {
    addNode({
      id: poolAddress, address: poolAddress, label: poolProgram.label ?? 'Pool (unrecognized program)', role: 'lp_pool',
      confidence: poolProgram.verdict === 'verified_official_pool' ? 'high' : 'low', risk: 'neutral',
      evidence: [`Pool account's owning program verified on-chain${poolProgram.label ? ` as ${poolProgram.label}` : ''} (Solana RPC getAccountInfo).`],
      supplyPercent: null, // The pool program account itself; its vault's real share is carried by the lp_vault node.
    })
    addEdge({
      id: `${mintAddress}->${poolAddress}:lp_creation`,
      from: mintAddress, to: poolAddress, relationship: 'lp_creation',
      evidence: `Primary liquidity pool for this mint, owning program verified on-chain${poolProgram.label ? ` as ${poolProgram.label}` : ''}.`,
      signature: null,
    })
    if (poolProgram.migratedFromPumpFun === true) {
      addEdge({
        id: `${mintAddress}->${poolAddress}:pumpfun_migration`,
        from: mintAddress, to: poolAddress, relationship: 'pumpfun_migration',
        evidence: 'Pool resolves to PumpSwap AMM — Pump.fun\'s exclusive post-graduation AMM, confirming migration off the bonding curve.',
        signature: null,
      })
    }
  }

  // ── Top holders + LP vaults (owner-resolved) ─────────────────────────────────
  // Aggregate accounts by resolved owner so one wallet with multiple token accounts becomes one
  // node, then classify: pool-owned = LP vault; existing-node-owned = insider holding (merged);
  // otherwise a top-holder node.
  let vaultAdjustedTop1Percent: number | null = null
  let insiderHoldingPercent = 0
  if (topAccounts.length > 0) {
    type OwnerAgg = { owner: string | null; accounts: SolanaTopAccountShare[]; totalPercent: number | null }
    const byOwner = new Map<string, OwnerAgg>()
    for (const acc of topAccounts) {
      const owner = ownerResolution.owners.get(acc.address) ?? null
      const key = owner ?? `ata:${acc.address}`
      const agg = byOwner.get(key) ?? { owner, accounts: [], totalPercent: null }
      agg.accounts.push(acc)
      if (acc.percentOfSupply != null) agg.totalPercent = (agg.totalPercent ?? 0) + acc.percentOfSupply
      byOwner.set(key, agg)
    }
    for (const agg of byOwner.values()) {
      const pctLabel = agg.totalPercent != null ? `${agg.totalPercent.toFixed(2)}%` : 'an unresolved share'
      const rankLabel = agg.accounts.map((a) => `#${a.rank}`).join(', ')
      const ataLabel = agg.accounts.map((a) => a.address).join(', ')
      const isVault = agg.owner != null && poolAddress != null && agg.owner === poolAddress
      if (isVault) {
        // Cross-provider agreement: DexScreener's pool address matches Alchemy's on-chain owner read.
        const ata = agg.accounts[0].address
        addNode({
          id: ata, address: ata, label: 'LP vault', role: 'lp_vault', confidence: 'high', risk: 'neutral',
          evidence: [`Token account ${rankLabel} holding ${pctLabel} of supply, owner-verified on-chain as the pool itself (${poolAddress}) — a real LP vault, not a whale.`],
          supplyPercent: agg.totalPercent, // Real measured share — the exact value cited in the evidence above.
        })
        addEdge({ id: `${ata}->${poolAddress}:vault_of`, from: ata, to: poolAddress, relationship: 'vault_of', evidence: `Token account's owner is the verified pool address — this is the pool's own vault.`, signature: null })
        addEdge({ id: `${ata}->${mintAddress}:holds_supply`, from: ata, to: mintAddress, relationship: 'holds_supply', evidence: `Holds ${pctLabel} of supply (pool-owned vault, verified via getMultipleAccounts owner read).`, signature: null })
        continue
      }
      if (agg.totalPercent != null) vaultAdjustedTop1Percent = Math.max(vaultAdjustedTop1Percent ?? 0, agg.totalPercent)
      const existing = agg.owner ? nodesByAddress.get(agg.owner) : undefined
      if (existing && agg.owner) {
        // Real insider-holding discovery: a wallet already in the graph (creator/funder/authority)
        // owns a top token account — verified by address equality from the owner read.
        existing.evidence.push(`ALSO holds ${pctLabel} of this token's supply (token account ${ataLabel}, rank ${rankLabel}) — owner-verified on-chain.`)
        // The node was created before its holdings were known (it entered the graph as a creator/
        // funder/authority). This is the point at which its share becomes a MEASURED fact, so the
        // previously-null supplyPercent is filled in with the real value.
        existing.supplyPercent = agg.totalPercent
        if (agg.totalPercent != null && agg.totalPercent >= 5) { existing.risk = 'elevated'; insiderHoldingPercent = Math.max(insiderHoldingPercent, agg.totalPercent) }
        addEdge({ id: `${agg.owner}->${mintAddress}:holds_supply`, from: agg.owner, to: mintAddress, relationship: 'holds_supply', evidence: `Holds ${pctLabel} of supply across token account(s) ${ataLabel} — owner-verified on-chain.`, signature: null })
        continue
      }
      const nodeAddr = agg.owner ?? agg.accounts[0].address
      const ownerKnown = agg.owner != null
      const dominant = agg.totalPercent != null && agg.totalPercent >= 20
      addNode({
        id: nodeAddr, address: nodeAddr, label: `Top holder (${rankLabel})`, role: 'top_holder',
        confidence: ownerKnown ? 'high' : 'low',
        risk: dominant ? 'elevated' : 'neutral',
        evidence: [ownerKnown
          ? `Owner wallet of token account ${rankLabel} (${ataLabel}), holding ${pctLabel} of supply — owner resolved via one on-chain getMultipleAccounts read.`
          : `Token account holding ${pctLabel} of supply — its owner wallet could not be resolved this scan (${ownerResolution.attempted ? `owner read failed: ${ownerResolution.errorReason ?? 'account not parsed'}` : 'owner resolution was not attempted — RPC endpoint unavailable to the cluster engine'}), so the account address itself is shown.`],
        supplyPercent: agg.totalPercent, // Real measured share — the exact value cited in the evidence above.
      })
      addEdge({ id: `${nodeAddr}->${mintAddress}:holds_supply`, from: nodeAddr, to: mintAddress, relationship: 'holds_supply', evidence: `Holds ${pctLabel} of supply${dominant ? ' — a dominant single-holder share, not identified as a pool vault' : ''}.`, signature: null })
    }
  }

  // ── Prior launch-shaped events (bounded recent sample — see fetchHeliusCreatorRecentLaunches) ──
  const launchEvents = recentLaunches?.success ? recentLaunches.events : []
  if (creatorWallet && launchEvents.length > 0) {
    const withMint = launchEvents.filter((e) => e.mint != null).slice(0, MAX_PRIOR_MINT_NODES)
    for (const ev of withMint) {
      const mint = ev.mint!
      addNode({
        id: mint, address: mint, label: 'Prior launch (recent sample)', role: 'prior_mint', confidence: 'medium', risk: 'neutral',
        evidence: [`A ${ev.type}${ev.source ? ` (${ev.source})` : ''} event naming this mint appears in the creator wallet's most recent activity sample${ev.timestamp ? ` at ${ev.timestamp}` : ''}. Sample-scoped evidence — not a full launch history.`],
        supplyPercent: null, // A different token's mint — a share of THIS token's supply is not applicable.
      })
      addEdge({ id: `${creatorWallet}->${mint}:prior_launch`, from: creatorWallet, to: mint, relationship: 'prior_launch', evidence: `Launch-shaped ${ev.type} event in the creator's recent activity sample.`, signature: ev.signature || null })
    }
  }

  const nodes = [...nodesByAddress.values()]
  const evidenceCount = edges.length
  const fundingDepth = Math.max(0, fundingPath.length - 1)

  // ── CONFIDENCE ENGINE — evidence quality, provider agreement, relationship count, verification
  // strength. Every factor is a real, checkable statement about THIS scan. ──────────────────────
  const confidenceFactors: string[] = []
  const highConfidenceNodes = nodes.filter((n) => n.confidence === 'high').length
  const highFraction = nodes.length > 1 ? highConfidenceNodes / nodes.length : 0
  const genesisCreator = creatorResolved && creatorTrace.reachedGenesis
  const vaultIdentified = nodes.some((n) => n.role === 'lp_vault')
  confidenceFactors.push(`${evidenceCount} verified relationship${evidenceCount === 1 ? '' : 's'} across ${nodes.length} node${nodes.length === 1 ? '' : 's'}.`)
  if (genesisCreator) confidenceFactors.push('Creator trace paginated all the way to genesis — the earliest transaction found is genuinely the first.')
  else if (creatorResolved) confidenceFactors.push('Creator trace did NOT reach genesis — an earlier transaction with a different fee payer may exist beyond the page cap.')
  else confidenceFactors.push('No creator wallet resolved — the funding chain and launch-sample reads could not run.')
  if (fundingTrace?.reachedGenesis) confidenceFactors.push('Funding trace reached the creator wallet\'s genesis.')
  if (ownerResolution.attempted && ownerResolution.errorReason == null) confidenceFactors.push(`Top-account owner resolution succeeded (${ownerResolution.owners.size} of ${topAccounts.length} owners read on-chain).`)
  else if (ownerResolution.attempted) confidenceFactors.push(`Top-account owner resolution failed (${ownerResolution.errorReason}) — holder nodes show account addresses, not owner wallets.`)
  if (vaultIdentified) confidenceFactors.push('Cross-provider agreement: an LP vault was identified by matching DexScreener\'s pool address against Alchemy\'s on-chain owner read.')
  confidenceFactors.push(`${highConfidenceNodes} of ${nodes.length} nodes verified at high confidence.`)

  let clusterConfidence: SolanaClusterConfidence
  if (evidenceCount === 0) clusterConfidence = 'none'
  else if (evidenceCount >= 8 && genesisCreator && highFraction >= 0.5 && (vaultIdentified || ownerResolution.owners.size > 0)) clusterConfidence = 'high'
  else if (evidenceCount >= 3 && (genesisCreator || ownerResolution.owners.size > 0)) clusterConfidence = 'medium'
  else clusterConfidence = 'low'

  // ── RISK ENGINE — creator history, funding quality, authority control, holder concentration,
  // LP ownership, linked launches. 'unknown' ONLY when fewer than two real signals resolved. ────
  const elevatedFactors: string[] = []
  const standardFactors: string[] = []
  let signalCount = 0

  if (fundingTrace?.success && fundingTrace.resolved.fundingAmountSol != null) {
    signalCount++
    if (fundingTrace.resolved.fundingAmountSol <= FRESH_FUNDING_SOL_THRESHOLD) {
      elevatedFactors.push(`The creator wallet was funded with only ${fundingTrace.resolved.fundingAmountSol.toFixed(4)} SOL — just enough for rent/fees, a pattern commonly seen with freshly-created, single-use "burner" deployer wallets.`)
    } else {
      standardFactors.push(`The creator wallet was funded with ${fundingTrace.resolved.fundingAmountSol.toFixed(4)} SOL, above the disposable-wallet threshold this engine flags (${FRESH_FUNDING_SOL_THRESHOLD} SOL).`)
    }
  }
  if (authorityReadSucceeded || mintAuthority || freezeAuthority) {
    signalCount++
    if (mintAuthority || freezeAuthority) {
      elevatedFactors.push(`An active ${mintAuthority && freezeAuthority ? 'mint AND freeze' : mintAuthority ? 'mint' : 'freeze'} authority wallet is part of this cluster — verified on-chain, a real supply/transfer risk.`)
    } else {
      standardFactors.push('Mint and freeze authorities are both revoked — no wallet in this cluster can inflate supply or freeze accounts.')
    }
  }
  if (insiderHoldingPercent > 0) {
    signalCount++
    elevatedFactors.push(`A wallet already in this cluster (creator/funder/authority) also holds ${insiderHoldingPercent.toFixed(2)}% of the token's supply — owner-verified insider holding.`)
  }
  if (vaultAdjustedTop1Percent != null) {
    signalCount++
    if (vaultAdjustedTop1Percent >= 40) {
      elevatedFactors.push(`The largest NON-VAULT holder controls ${vaultAdjustedTop1Percent.toFixed(2)}% of supply — pool vaults are already excluded from this figure, so this is a real concentration risk, not AMM custody.`)
    } else {
      standardFactors.push(`The largest non-vault holder controls ${vaultAdjustedTop1Percent.toFixed(2)}% of supply (pool vaults excluded).`)
    }
  }
  if (recentLaunches?.success) {
    signalCount++
    if (launchEvents.length >= 3) {
      elevatedFactors.push(`${launchEvents.length} launch-shaped events appear in the creator wallet's most recent activity sample — a serial-launch pattern in the sampled window (sample-scoped, not a full history).`)
    } else if (launchEvents.length > 0) {
      standardFactors.push(`${launchEvents.length} launch-shaped event${launchEvents.length === 1 ? '' : 's'} in the creator's recent activity sample (sample-scoped, not a full history).`)
    } else {
      standardFactors.push('No launch-shaped events in the creator\'s recent activity sample — NOT proof of no prior launches (the sample is bounded).')
    }
  }
  if (vaultIdentified) {
    standardFactors.push('LP supply is held in a pool-owned vault, verified on-chain — exit liquidity is in AMM custody, not a private wallet, for the verified share.')
  }

  const riskFactors = [...elevatedFactors, ...standardFactors]
  let riskLevel: SolanaClusterRiskLevel
  let riskReason: string
  if (signalCount < 2) {
    riskLevel = 'unknown'
    riskReason = `Insufficient evidence to assess cluster risk — only ${signalCount} of the risk signals this engine reads (funding quality, authority control, holder concentration, insider holdings, launch sample) resolved for this scan.`
  } else if (elevatedFactors.length > 0) {
    riskLevel = 'elevated'
    riskReason = elevatedFactors.join(' ')
  } else {
    riskLevel = 'standard'
    riskReason = `${signalCount} risk signals resolved with no elevated finding: ${standardFactors.join(' ')}`
  }

  const summary = evidenceCount === 0
    ? 'No verified wallet relationships found.'
    : `${evidenceCount} verified relationship${evidenceCount === 1 ? '' : 's'} found across ${nodes.length} node${nodes.length === 1 ? '' : 's'}.`

  return {
    attempted: true,
    creatorResolved,
    nodes, edges, evidenceCount, clusterConfidence, confidenceFactors,
    fundingPath, fundingDepth, riskLevel, riskReason, riskFactors, summary,
    fundingTrace,
    recentLaunches,
    ownerResolution: { attempted: ownerResolution.attempted, resolvedCount: ownerResolution.owners.size, errorReason: ownerResolution.errorReason },
    unresolvedRelationships: [...UNRESOLVED_RELATIONSHIPS],
    vaultAdjustedTop1Percent,
  }
}
