// SOLANA WALLET DETAIL, DISCLOSED (Cluster Map "click a node" follow-up task). Powers the wallet
// detail panel opened by clicking a Cluster Map node — real, on-demand, cheap RPC reads only:
// getBalance (current SOL balance) and getSignaturesForAddress limit 1 (most recent activity).
// Deliberately Alchemy/Solana RPC only, never Helius Enhanced Transactions — this is triggered
// per-click and must stay cheap; "first activity" for the creator/funding-wallet nodes is instead
// carried over from the Deep Cluster Check evidence already gathered for those specific nodes
// (see clusterAnalyzer.ts), never re-fetched here.

import { solanaRpc, type RpcFetch } from './rpcClient.ts'

export type SolanaWalletSnapshot = {
  address: string
  balanceResolved: boolean
  balanceSol: number | null
  lastActivityResolved: boolean
  lastActivitySignature: string | null
  lastActivityTimestamp: string | null
  errorReason: string | null
}

export async function fetchSolanaWalletSnapshot(address: string, rpcUrl: string, fetchImpl: RpcFetch): Promise<SolanaWalletSnapshot> {
  const [balanceRes, sigRes] = await Promise.all([
    solanaRpc<{ value?: number }>(rpcUrl, 'getBalance', [address], fetchImpl),
    solanaRpc<Array<{ signature?: string; blockTime?: number | null }>>(rpcUrl, 'getSignaturesForAddress', [address, { limit: 1 }], fetchImpl),
  ])

  const balanceResolved = balanceRes.ok && typeof balanceRes.result?.value === 'number'
  const balanceSol = balanceResolved ? (balanceRes.result!.value as number) / 1_000_000_000 : null

  const rows = sigRes.ok && Array.isArray(sigRes.result) ? sigRes.result : []
  const latest = rows[0]
  const lastActivityResolved = typeof latest?.signature === 'string'
  const lastActivitySignature = lastActivityResolved ? latest!.signature! : null
  const lastActivityTimestamp = lastActivityResolved && typeof latest?.blockTime === 'number' ? new Date(latest.blockTime * 1000).toISOString() : null

  const errorReason = !balanceResolved && !lastActivityResolved
    ? (balanceRes.ok ? 'no_signature_history_found' : balanceRes.error)
    : null

  return { address, balanceResolved, balanceSol, lastActivityResolved, lastActivitySignature, lastActivityTimestamp, errorReason }
}
