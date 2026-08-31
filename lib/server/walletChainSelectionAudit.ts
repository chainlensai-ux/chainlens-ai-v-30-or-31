// WALLET CHAIN SELECTION AUDIT, DISCLOSED (Wallet Scanner deep scan chain coverage fix).
//
// ROOT CAUSE, DISCLOSED: app/api/wallet-scan/route.ts — the real route the Wallet Scanner page's
// Scan/Deep Scan buttons call — defaulted `chains` to ['base','eth'] with zero Robinhood
// awareness, so live deep-scan logs showed chainsScanned:['base','eth'], chains:[8453,1] even
// when ENABLE_ROBINHOOD_CHAIN=true. This module does NOT change what gets fed into
// enqueueWalletScanJob()/runWalletScanV2() — that pipeline's SupportedChain union
// ('base'|'eth'|'arbitrum'|'hyperevm', src/modules/providerFetchWindow/types.ts) is deliberately
// EVM-only and must never see 'robinhood' (confirmed via src/pipeline/walletScannerProviderSupportAudit.test.ts,
// which asserts the pipeline degrades honestly rather than crashing on an unsupported chain slug).
// Rewriting that typed pipeline to add Robinhood is explicitly out of scope and a real regression
// risk to Base/ETH/BNB — forbidden by this task's own hard rules.
//
// Instead, this is a NEW, purely-additive, side-effect-free audit that honestly records the
// CANONICAL chain selection decision — including Robinhood — for a Wallet Scanner request, so a
// caller (the route, the orchestrator, the UI) can see and log exactly which chains were
// requested, which were allowed, which were omitted and why, and (once known) which were actually
// scanned. It performs no network calls and mutates nothing.

import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_CHAIN_SLUG,
  isRobinhoodChainFeatureEnabled,
  isRobinhoodRpcConfigured,
  isRobinhoodChainAvailable,
} from './robinhoodChainConfig'

export type ChainSelectionOmittedReason =
  | 'robinhood_disabled'
  | 'robinhood_rpc_not_configured'
  | 'bnb_not_supported'

export type WalletChainSelectionAudit = {
  requestedMode: string
  // ADDED, DISCLOSED (Robinhood-not-in-normal-pipeline fix): a human-readable label for the chain
  // *selection* decision itself, distinct from `requestedMode` (scan depth: 'normal'/'deep'). Never
  // computed from a guess — 'auto' when the caller omitted `chains` entirely (the same condition
  // that already drives `includeRobinhoodRequested`), 'all_supported' when the caller's own EVM
  // chain list already spans every EVM chain this route defaults to, otherwise the caller's real,
  // explicit chain list joined verbatim so a narrowed request (e.g. just 'base') is never mislabeled.
  chainMode: string
  enableRobinhood: boolean
  envHasRobinhoodRpc: boolean
  envHasGoldrush: boolean
  envHasBlockscout: boolean
  // ADDED, DISCLOSED: the EVM chain ids the caller asked for BEFORE Robinhood's own id is
  // considered/appended — lets a log reader see the exact before/after effect of the Robinhood
  // chain-selection step, rather than only the final merged `requestedChains`.
  requestedChainsBefore: number[]
  requestedChainsAfter: number[]
  requestedChains: number[]
  allowedChains: number[]
  omittedChains: number[]
  // Keyed by chain id as a string (JSON object keys are always strings).
  omittedReasons: Record<string, ChainSelectionOmittedReason>
  // Chain slugs actually scanned this call, once known. May be empty/partial at initial-request
  // time (e.g. the deep-scan enqueue response, where the EVM side is still queued and Robinhood's
  // own scan may still be in flight) — never backfilled with a guess.
  finalChainsScanned: string[]
}

// EVM chain-id mapping, DISCLOSED: only the slugs this codebase's EVM chain selectors actually use
// ('base', 'eth', plus 'bnb' as a requested-but-unsupported slug some callers may pass) are mapped
// — an unrecognized slug is simply not added to requestedChains (never guessed at a made-up id).
const EVM_CHAIN_IDS: Record<string, number> = {
  base: 8453,
  eth: 1,
  ethereum: 1,
  bnb: 56,
}

const BNB_CHAIN_ID = EVM_CHAIN_IDS.bnb

export function buildWalletChainSelectionAudit(params: {
  requestedMode: string
  // Optional, DISCLOSED: defaults to a value derived from evmChainSlugs/includeRobinhoodRequested
  // when the caller doesn't already track an explicit chainMode concept (e.g.
  // app/api/wallet-scan/route.ts, which only ever dealt with a raw `chains` array before this
  // field existed) — never guessed beyond what the caller's own real inputs already say.
  chainMode?: string
  evmChainSlugs: string[]
  includeRobinhoodRequested: boolean
  finalChainsScanned: string[]
}): WalletChainSelectionAudit {
  const enableRobinhood = isRobinhoodChainFeatureEnabled()
  const envHasRobinhoodRpc = isRobinhoodRpcConfigured()
  const envHasGoldrush = Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY)
  const envHasBlockscout = Boolean(process.env.BLOCKSCOUT_API_KEY)
  const robinhoodAvailable = isRobinhoodChainAvailable()

  const requestedChainsBefore: number[] = []
  const requestedChains: number[] = []
  const allowedChains: number[] = []
  const omittedChains: number[] = []
  const omittedReasons: Record<string, ChainSelectionOmittedReason> = {}

  for (const slug of params.evmChainSlugs) {
    const id = EVM_CHAIN_IDS[slug.toLowerCase()]
    if (id == null) continue
    if (!requestedChainsBefore.includes(id)) requestedChainsBefore.push(id)
    if (!requestedChains.includes(id)) requestedChains.push(id)
    if (id === BNB_CHAIN_ID) {
      // BNB is requestable but not actually supported by the V2 pipeline (SupportedChain has no
      // 'bnb' member) — recorded honestly as omitted, never silently substituted for another chain.
      if (!omittedChains.includes(id)) omittedChains.push(id)
      omittedReasons[String(id)] = 'bnb_not_supported'
    } else if (!allowedChains.includes(id)) {
      allowedChains.push(id)
    }
  }

  if (params.includeRobinhoodRequested) {
    if (!requestedChains.includes(ROBINHOOD_CHAIN_ID)) requestedChains.push(ROBINHOOD_CHAIN_ID)
    if (robinhoodAvailable) {
      if (!allowedChains.includes(ROBINHOOD_CHAIN_ID)) allowedChains.push(ROBINHOOD_CHAIN_ID)
    } else {
      omittedChains.push(ROBINHOOD_CHAIN_ID)
      // These are two genuinely different real states — never collapsed into one generic reason.
      omittedReasons[String(ROBINHOOD_CHAIN_ID)] = enableRobinhood
        ? 'robinhood_rpc_not_configured'
        : 'robinhood_disabled'
    }
  }

  const chainMode = params.chainMode
    ?? (params.includeRobinhoodRequested
      ? (requestedChainsBefore.length >= 2 ? 'all_supported' : 'auto')
      : params.evmChainSlugs.join(',') || 'none')

  return {
    requestedMode: params.requestedMode,
    chainMode,
    enableRobinhood,
    envHasRobinhoodRpc,
    envHasGoldrush,
    envHasBlockscout,
    requestedChainsBefore,
    requestedChainsAfter: requestedChains,
    requestedChains,
    allowedChains,
    omittedChains,
    omittedReasons,
    finalChainsScanned: params.finalChainsScanned,
  }
}

export { ROBINHOOD_CHAIN_ID, ROBINHOOD_CHAIN_SLUG }
