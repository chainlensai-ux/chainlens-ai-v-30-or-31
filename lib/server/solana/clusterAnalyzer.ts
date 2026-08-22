// SOLANA CLUSTER MAP / LINKED WALLETS, DISCLOSED (Dev Intelligence "Cluster Map" + "Linked
// Wallets" tabs follow-up task). DEEP MODE ONLY — never called on a normal scan; only when the
// caller explicitly runs Deep Cluster Check (mirrors deepCreatorAnalyzer.ts's own opt-in contract,
// see that module's header for the full cost disclosure).
//
// WHAT THIS RESOLVES, REAL EVIDENCE ONLY: given the mint's likely creator wallet (fee payer of the
// mint's earliest found transaction — from deepCreatorAnalyzer.ts), this traces exactly ONE further
// hop: who first sent that wallet SOL (fetchHeliusWalletFundingTrace). That gives a real, two-node
// funding path: funding wallet → creator wallet → mint, each edge backed by a specific signature.
//
// WHAT THIS DELIBERATELY DOES NOT DO, DISCLOSED: shared-signer / shared-fee-payer / shared-token-
// creation / shared-LP-creation / shared-ATA-creation / shared-migration / shared-authority-history
// relationships ACROSS OTHER MINTS are not attempted — verifying any of those requires indexing the
// full transaction history of every candidate wallet across the whole chain to find overlaps, which
// is unbounded work this codebase has no indexer for. Claiming those relationships from a shallow
// read would be exactly the fabricated evidence this engine's honesty contract forbids. When no
// relationship can be verified at all, this returns "No verified wallet relationships found." —
// never "Not supported", per this task's own instruction.

import type { SolanaCreatorTraceResult } from '../solanaProviders.ts'
import { fetchHeliusWalletFundingTrace, type SolanaWalletFundingTraceResult } from '../solanaProviders.ts'
import type { RpcFetch } from './rpcClient.ts'

export type SolanaClusterEdge = {
  from: string
  to: string
  relationship: 'funding_wallet' | 'first_sol_sender' | 'shared_fee_payer'
  evidence: string
  signature: string | null
}

export type SolanaClusterNode = {
  address: string
  label: string
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
  riskLevel: SolanaClusterRiskLevel
  riskReason: string
  summary: string
  fundingTrace: SolanaWalletFundingTraceResult | null
}

const FRESH_FUNDING_SOL_THRESHOLD = 0.05

export async function analyzeSolanaCluster(params: {
  mintAddress: string
  creatorTrace: SolanaCreatorTraceResult
  fetchImpl: RpcFetch
}): Promise<SolanaClusterMap> {
  const { mintAddress, creatorTrace, fetchImpl } = params
  const creatorWallet = creatorTrace.resolved.likelyCreatorWallet

  if (!creatorWallet) {
    return {
      attempted: false,
      nodes: [], edges: [], evidenceCount: 0, clusterConfidence: 'none', fundingPath: [], riskLevel: 'unknown',
      riskReason: 'No relationship trace was attempted — a likely creator wallet was not resolved for this mint, so there is no wallet to trace funding for.',
      summary: 'No verified wallet relationships found.',
      fundingTrace: null,
    }
  }

  const fundingTrace = await fetchHeliusWalletFundingTrace(creatorWallet, fetchImpl)

  const nodes: SolanaClusterNode[] = [{ address: creatorWallet, label: 'Likely creator wallet' }]
  const edges: SolanaClusterEdge[] = [
    {
      from: creatorWallet,
      to: mintAddress,
      relationship: 'shared_fee_payer',
      evidence: `${creatorWallet} paid fees for this mint's earliest found transaction${creatorTrace.resolved.transactionSource ? ` (source: ${creatorTrace.resolved.transactionSource})` : ''}.`,
      signature: creatorTrace.resolved.earliestSignature,
    },
  ]

  let evidenceCount = 1
  const fundingPath = [creatorWallet]

  if (fundingTrace.success && fundingTrace.resolved.fundingWallet) {
    const funder = fundingTrace.resolved.fundingWallet
    nodes.unshift({ address: funder, label: 'Funding wallet (first SOL sender)' })
    edges.push({
      from: funder,
      to: creatorWallet,
      relationship: 'funding_wallet',
      evidence: `${funder} sent the first SOL transfer into ${creatorWallet}${fundingTrace.resolved.fundingAmountSol != null ? ` (${fundingTrace.resolved.fundingAmountSol.toFixed(4)} SOL)` : ''}, found in that wallet's earliest transaction.`,
      signature: fundingTrace.resolved.walletEarliestSignature,
    })
    evidenceCount += 1
    fundingPath.unshift(funder)
  }

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

  const summary = evidenceCount === 0
    ? 'No verified wallet relationships found.'
    : `${evidenceCount} verified relationship${evidenceCount === 1 ? '' : 's'} found: ${fundingPath.map((a) => `${a.slice(0, 4)}…${a.slice(-4)}`).join(' → ')} → mint.`

  return {
    attempted: true,
    nodes, edges, evidenceCount, clusterConfidence, fundingPath, riskLevel, riskReason, summary,
    fundingTrace,
  }
}
