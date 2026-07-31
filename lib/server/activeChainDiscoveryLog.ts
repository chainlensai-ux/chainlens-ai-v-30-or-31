// MODULE — flat structured log line for one active-chain discovery pre-scan
// (activeChainDiscovery.ts), including the eth_getBalance call-count reduction it produced.

import type { ChainDiscoveryResult } from './activeChainDiscovery'

export const ACTIVE_CHAIN_DISCOVERY_LOG_LABEL = '[pipeline] active chain discovery pre-scan'

export type ActiveChainDiscoveryLogRecord = {
  route: string
  walletAddressHash: string
  candidateChains: string
  activeChains: string
  skippedInactiveChains: string
  ethGetBalanceCallsBefore: number
  ethGetBalanceCallsAfter: number
  evidenceSource: string
}

// NEVER LOGS THE RAW WALLET ADDRESS, DISCLOSED: a short, non-reversible hash identifies the wallet
// across log lines for correlation without exposing the address itself in plaintext logs.
function hashWallet(walletAddress: string): string {
  let hash = 0
  const lower = walletAddress.toLowerCase()
  for (let i = 0; i < lower.length; i += 1) {
    hash = (hash * 31 + lower.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// PURE, DISCLOSED: derives every field from the discovery result already produced — no I/O.
// "Before" is always candidateChains.length (the naive "check every supported chain" baseline this
// module replaces); "after" is the actual activeChains.length this pre-scan narrowed the real
// eth_getBalance work down to.
export function buildActiveChainDiscoveryLogRecord(route: string, result: ChainDiscoveryResult): ActiveChainDiscoveryLogRecord {
  return {
    route,
    walletAddressHash: hashWallet(result.walletAddress),
    candidateChains: result.candidateChains.join(','),
    activeChains: result.activeChains.join(','),
    skippedInactiveChains: result.skippedInactiveChains.join(','),
    ethGetBalanceCallsBefore: result.candidateChains.length,
    ethGetBalanceCallsAfter: result.activeChains.length,
    evidenceSource: result.evidenceSources.join(','),
  }
}
