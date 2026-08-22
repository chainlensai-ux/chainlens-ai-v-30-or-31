// SOLANA CLUSTER MAP / LINKED WALLETS, DISCLOSED (Dev Intelligence "Cluster Map" follow-up —
// upgraded from a funding-path summary into a real, multi-node relationship graph). DEEP MODE
// ONLY — never called on a normal scan; only when the caller explicitly runs Deep Cluster Check
// (mirrors deepCreatorAnalyzer.ts's own opt-in contract, see that module's header for the full
// cost disclosure).
//
// WHAT THIS RESOLVES, REAL EVIDENCE ONLY, EACH FROM A PROVIDER ALREADY WIRED INTO THIS ENGINE:
//  - Creator wallet + fee-payer edge to the mint — Helius Enhanced Transactions (deepCreatorAnalyzer.ts).
//  - Funding wallet + first-SOL-sender edge into the creator wallet — Helius Enhanced Transactions
//    (fetchHeliusWalletFundingTrace).
//  - Mint authority / freeze authority nodes — Alchemy/Solana RPC getAccountInfo (mintAnalyzer.ts),
//    only added when that authority is actually still active (a revoked authority has no wallet).
//  - LP pool node + Pump.fun→PumpSwap migration edge — Solana RPC getAccountInfo pool-owner read
//    (poolAnalyzer.ts), only when the pool's owning program is confirmed.
//
// WHAT THIS DELIBERATELY DOES NOT DO, DISCLOSED: shared-signer / shared-token-creation /
// shared-ATA-creation / shared-authority-history relationships ACROSS OTHER MINTS, metadata
// authority, treasury, liquidity-wallet, and market-maker-wallet roles are not attempted —
// verifying any of those requires either indexing the full transaction history of every candidate
// wallet across the whole chain to find overlaps (unbounded, no indexer available), or a Metaplex
// metadata-account read this engine does not perform. Claiming those relationships from a shallow
// read would be exactly the fabricated evidence this engine's honesty contract forbids. When no
// relationship can be verified at all, this returns "No verified wallet relationships found." —
// never "Not supported", per this task's own instruction.

import type { SolanaCreatorTraceResult } from '../solanaProviders.ts'
import { fetchHeliusWalletFundingTrace, type SolanaWalletFundingTraceResult } from '../solanaProviders.ts'
import type { RpcFetch } from './rpcClient.ts'
import type { SolanaPoolProgram } from './types.ts'

export type SolanaClusterRelationship =
  | 'funding_wallet' | 'first_sol_sender' | 'shared_fee_payer'
  | 'mint_authority' | 'freeze_authority' | 'lp_creation' | 'pumpfun_migration'

export type SolanaClusterEdge = {
  id: string
  from: string
  to: string
  relationship: SolanaClusterRelationship
  evidence: string
  signature: string | null
}

export type SolanaClusterNodeRole = 'mint' | 'creator_wallet' | 'funding_wallet' | 'mint_authority' | 'freeze_authority' | 'lp_pool'
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
}

export type SolanaClusterConfidence = 'none' | 'low' | 'medium'
export type SolanaClusterRiskLevel = 'unknown' | 'standard' | 'elevated'

export type SolanaClusterMap = {
  attempted: boolean
  nodes: SolanaClusterNode[]
  edges: SolanaClusterEdge[]
  evidenceCount: number
  clusterConfidence: SolanaClusterConfidence
  fundingPath: string[]
  /** Number of real funding hops verified (fundingPath.length - 1). 0 when only the creator wallet is known. */
  fundingDepth: number
  riskLevel: SolanaClusterRiskLevel
  riskReason: string
  summary: string
  fundingTrace: SolanaWalletFundingTraceResult | null
}

const FRESH_FUNDING_SOL_THRESHOLD = 0.05

export async function analyzeSolanaCluster(params: {
  mintAddress: string
  creatorTrace: SolanaCreatorTraceResult
  mintAuthority: string | null
  freezeAuthority: string | null
  poolProgram: SolanaPoolProgram
  fetchImpl: RpcFetch
}): Promise<SolanaClusterMap> {
  const { mintAddress, creatorTrace, mintAuthority, freezeAuthority, poolProgram, fetchImpl } = params
  const creatorWallet = creatorTrace.resolved.likelyCreatorWallet

  if (!creatorWallet) {
    return {
      attempted: false,
      nodes: [], edges: [], evidenceCount: 0, clusterConfidence: 'none', fundingPath: [], fundingDepth: 0, riskLevel: 'unknown',
      riskReason: 'No relationship trace was attempted — a likely creator wallet was not resolved for this mint, so there is no wallet to trace funding for.',
      summary: 'No verified wallet relationships found.',
      fundingTrace: null,
    }
  }

  const fundingTrace = await fetchHeliusWalletFundingTrace(creatorWallet, fetchImpl)

  const mintNode: SolanaClusterNode = {
    id: mintAddress, address: mintAddress, label: 'Token mint', role: 'mint', confidence: 'high', risk: 'neutral',
    evidence: ['This is the scanned mint account.'],
  }

  const creatorConfidence: SolanaClusterNodeConfidence = creatorTrace.reachedGenesis && creatorTrace.resolved.transactionSource ? 'high' : creatorTrace.reachedGenesis ? 'medium' : 'low'
  const creatorNode: SolanaClusterNode = {
    id: creatorWallet, address: creatorWallet, label: 'Creator wallet', role: 'creator_wallet', confidence: creatorConfidence, risk: 'unknown',
    evidence: [`Paid fees for this mint's earliest found transaction${creatorTrace.resolved.transactionSource ? ` (source: ${creatorTrace.resolved.transactionSource})` : ''}.`],
  }

  const nodes: SolanaClusterNode[] = [mintNode, creatorNode]
  const edges: SolanaClusterEdge[] = [
    {
      id: `${creatorWallet}->${mintAddress}:shared_fee_payer`,
      from: creatorWallet, to: mintAddress, relationship: 'shared_fee_payer',
      evidence: `${creatorWallet} paid fees for this mint's earliest found transaction${creatorTrace.resolved.transactionSource ? ` (source: ${creatorTrace.resolved.transactionSource})` : ''}.`,
      signature: creatorTrace.resolved.earliestSignature,
    },
  ]

  let evidenceCount = 1
  const fundingPath = [creatorWallet]

  if (fundingTrace.success && fundingTrace.resolved.fundingWallet) {
    const funder = fundingTrace.resolved.fundingWallet
    const amountLabel = fundingTrace.resolved.fundingAmountSol != null ? ` (${fundingTrace.resolved.fundingAmountSol.toFixed(4)} SOL)` : ''
    const isFresh = fundingTrace.resolved.fundingAmountSol != null && fundingTrace.resolved.fundingAmountSol <= FRESH_FUNDING_SOL_THRESHOLD
    nodes.unshift({
      id: funder, address: funder, label: 'Funding wallet', role: 'funding_wallet',
      confidence: fundingTrace.reachedGenesis ? 'medium' : 'low',
      risk: isFresh ? 'elevated' : 'standard',
      evidence: [`Sent the first SOL transfer into ${creatorWallet}${amountLabel}, found in that wallet's earliest transaction.`],
    })
    creatorNode.risk = isFresh ? 'elevated' : 'standard'
    creatorNode.evidence.push(`Funded by ${funder}${amountLabel} — ${isFresh ? 'a rent-level amount, a pattern common to disposable deployer wallets' : 'above the disposable-wallet threshold this engine flags'}.`)
    edges.push({
      id: `${funder}->${creatorWallet}:funding_wallet`,
      from: funder, to: creatorWallet, relationship: 'funding_wallet',
      evidence: `${funder} sent the first SOL transfer into ${creatorWallet}${amountLabel}, found in that wallet's earliest transaction.`,
      signature: fundingTrace.resolved.walletEarliestSignature,
    })
    evidenceCount += 1
    fundingPath.unshift(funder)
  }

  if (mintAuthority) {
    nodes.push({
      id: mintAuthority, address: mintAuthority, label: 'Mint authority', role: 'mint_authority', confidence: 'high', risk: 'elevated',
      evidence: [`Verified on-chain as the active mint authority for ${mintAddress} — can mint additional supply at any time.`],
    })
    edges.push({
      id: `${mintAuthority}->${mintAddress}:mint_authority`,
      from: mintAuthority, to: mintAddress, relationship: 'mint_authority',
      evidence: `${mintAuthority} is the active mint authority on this mint's own account (Alchemy/Solana RPC getAccountInfo).`,
      signature: null,
    })
    evidenceCount += 1
  }
  if (freezeAuthority && freezeAuthority !== mintAuthority) {
    nodes.push({
      id: freezeAuthority, address: freezeAuthority, label: 'Freeze authority', role: 'freeze_authority', confidence: 'high', risk: 'elevated',
      evidence: [`Verified on-chain as the active freeze authority for ${mintAddress} — can freeze any holder's token account.`],
    })
    edges.push({
      id: `${freezeAuthority}->${mintAddress}:freeze_authority`,
      from: freezeAuthority, to: mintAddress, relationship: 'freeze_authority',
      evidence: `${freezeAuthority} is the active freeze authority on this mint's own account (Alchemy/Solana RPC getAccountInfo).`,
      signature: null,
    })
    evidenceCount += 1
  }

  if (poolProgram.resolved && poolProgram.poolAddress) {
    nodes.push({
      id: poolProgram.poolAddress, address: poolProgram.poolAddress, label: poolProgram.label ?? 'Pool (unrecognized program)', role: 'lp_pool',
      confidence: poolProgram.verdict === 'verified_official_pool' ? 'high' : 'low', risk: 'neutral',
      evidence: [`Pool account's owning program verified on-chain${poolProgram.label ? ` as ${poolProgram.label}` : ''} (Solana RPC getAccountInfo).`],
    })
    edges.push({
      id: `${mintAddress}->${poolProgram.poolAddress}:lp_creation`,
      from: mintAddress, to: poolProgram.poolAddress, relationship: 'lp_creation',
      evidence: `Primary liquidity pool for this mint, owning program verified on-chain${poolProgram.label ? ` as ${poolProgram.label}` : ''}.`,
      signature: null,
    })
    evidenceCount += 1
    if (poolProgram.migratedFromPumpFun === true) {
      edges.push({
        id: `${mintAddress}->${poolProgram.poolAddress}:pumpfun_migration`,
        from: mintAddress, to: poolProgram.poolAddress, relationship: 'pumpfun_migration',
        evidence: 'Pool resolves to PumpSwap AMM — Pump.fun\'s exclusive post-graduation AMM, confirming migration off the bonding curve.',
        signature: null,
      })
    }
  }

  const fundingDepth = fundingPath.length - 1
  const clusterConfidence: SolanaClusterConfidence =
    evidenceCount >= 2 && creatorTrace.reachedGenesis && fundingTrace.reachedGenesis ? 'medium' :
    evidenceCount >= 1 ? 'low' : 'none'

  let riskLevel: SolanaClusterRiskLevel = 'unknown'
  let riskReason = 'Insufficient evidence to assess funding-pattern risk.'
  if (fundingTrace.success && fundingTrace.resolved.fundingAmountSol != null) {
    if (fundingTrace.resolved.fundingAmountSol <= FRESH_FUNDING_SOL_THRESHOLD) {
      riskLevel = 'elevated'
      riskReason = `The creator wallet was funded with only ${fundingTrace.resolved.fundingAmountSol.toFixed(4)} SOL — just enough for rent/fees, a pattern commonly seen with freshly-created, single-use "burner" deployer wallets.`
    } else {
      riskLevel = 'standard'
      riskReason = `The creator wallet was funded with ${fundingTrace.resolved.fundingAmountSol.toFixed(4)} SOL, above the disposable-wallet threshold this engine flags (${FRESH_FUNDING_SOL_THRESHOLD} SOL).`
    }
  }
  // An active mint or freeze authority is itself a real, on-chain risk signal even when the
  // funding-pattern read is inconclusive — never let a node-level risk go unreflected at the
  // cluster level just because the funding hop didn't resolve.
  if (nodes.some((n) => (n.role === 'mint_authority' || n.role === 'freeze_authority') && n.risk === 'elevated') && riskLevel !== 'elevated') {
    riskLevel = 'elevated'
    riskReason = riskLevel === 'elevated' && riskReason.startsWith('Insufficient')
      ? 'An active mint or freeze authority wallet is part of this cluster — verified on-chain, a real supply/transfer risk independent of the funding-pattern read.'
      : riskReason
  }

  const summary = evidenceCount === 0
    ? 'No verified wallet relationships found.'
    : `${evidenceCount} verified relationship${evidenceCount === 1 ? '' : 's'} found across ${nodes.length} node${nodes.length === 1 ? '' : 's'}.`

  return {
    attempted: true,
    nodes, edges, evidenceCount, clusterConfidence, fundingPath, fundingDepth, riskLevel, riskReason, summary,
    fundingTrace,
  }
}
