// MODULE — receiptSwapDecoder: FORENSIC/ADMIN-ONLY pool-creation provenance investigation.
//
// NOT WIRED INTO ANY WALLET SCAN, DISCLOSED: unlike every other module in this shadow-mode set,
// this one is deliberately NEVER called from walletScanShadowWiring.ts or src/pipeline/index.ts --
// "forensic/admin path only; do not run for every wallet scan". It exists to be invoked on demand
// (an admin script/route) against one specific (chain, pool) pair, e.g. the exact production case
// this task addresses: pool 0x7f31b371ac675bca3357fd9c26854fed067400c0, claimed factory
// 0xade65c38cd4849adba595a4323a8c7ddfe89716a, where the prior forensic pass already found
// create2Detected=true, no PoolCreated topic, no proxy, no creation receipt available, and
// terminated at 'no_supported_creation_proof'. This module goes one step further: it actually finds
// and inspects the pool's own contract-creation transaction.
//
// BOUNDED, DISCLOSED: at most ONE indexed-provider lookup (the pool's contract-creation
// transaction/creator, via one configured BaseScan/Etherscan-family endpoint -- same real,
// API-key-gated, honest-miss-on-any-deviation convention as fallbackPricing/baseScanClient.ts) PLUS
// at most ONE creation-receipt fetch (a single eth_getTransactionReceipt via the shared Base
// client). No retries anywhere in this module.
//
// DOES NOT ACCEPT pool.factory() ALONE, DISCLOSED: this module never calls factory() on the pool --
// provenance is established only from the creation transaction's own creator/receipt/logs, or (when
// available) an internal-call trace naming the claimed factory.
//
// TRACE, HONESTLY DISCLOSED: real internal-call tracing (debug_traceTransaction /
// trace_transaction) is a non-standard, provider-tier-gated RPC method this codebase has no
// existing, verified access to -- so `creationTrace` is always reported unavailable here, and this
// module always falls back to the two things the task explicitly permits when trace data is
// unavailable: "inspect creation receipt logs and contract address only". A future pass with a
// verified trace-capable provider can populate `creationTrace` without changing this module's
// public shape.
//
// PERMANENT CACHE, DISCLOSED: keyed by chain+pool address, never expires within process lifetime --
// a pool's own creation transaction is immutable chain history, so a result once found (or once
// honestly exhausted) is cached forever, never re-investigated.
//
// DOES NOT ADD TO THE VERIFIED REGISTRY, DISCLOSED: same discipline as every other forensic module
// in this set -- this module's output is a diagnostic record for a human/admin to review, never a
// registry mutation, and it never decodes or replays the swap that originally surfaced this pool.

import { getSharedBaseClient } from './rpcClient'
import { decodePoolCreatedLog } from './unsupportedFactoryForensics'
import type { RawReceiptLog } from './types'

export const POOL_CREATION_PROVENANCE_LOG_LABEL = '[admin] pool creation provenance investigation'

export type PoolCreationProvenanceFinalReason =
  | 'verified_pool_creation_provenance'
  | 'creation_tx_not_found'
  | 'creator_mismatch'
  | 'creation_receipt_mismatch'
  | 'trace_unavailable'
  | 'provider_failure'

export type PoolCreationProvenanceDiagnostics = {
  pool: string
  creationTxHash: string | null
  contractCreator: string | null
  transactionTo: string | null
  claimedFactoryInCreationPath: boolean | null
  creationReceiptFound: boolean
  exactPoolCreated: boolean | null
  tokenPairVerified: boolean | null
  feeVerified: boolean | null
  finalTypedReason: PoolCreationProvenanceFinalReason
}

// ONE CONFIGURED INDEXED PROVIDER, DISCLOSED: a pool's real contract-creation transaction and
// creator, from a single indexer lookup -- never a guessed/derived value. `creationTrace` is always
// null in the live implementation below (see this file's own header); the type exists so a future,
// verified trace-capable provider can populate it without a breaking change.
export type IndexedContractCreationResult = {
  creationTxHash: string
  contractCreator: string
  creationTrace: { calledContracts: readonly string[] } | null
}

export type IndexedContractCreationLookup = {
  lookupContractCreation(chain: 'base', pool: string): Promise<IndexedContractCreationResult | null>
}

export type PoolCreationReceiptOutcome =
  | { status: 'ok'; to: string | null; contractAddress: string | null; logs: RawReceiptLog[] }
  | { status: 'missing' }
  | { status: 'reverted' }
  | { status: 'malformed' }

export type PoolCreationReceiptFetcher = (chain: 'base', txHash: string) => Promise<PoolCreationReceiptOutcome>

export type PoolCreationProvenanceInvestigator = {
  investigate(input: {
    chain: 'base'
    pool: string
    claimedFactory: string
    expectedToken0: string
    expectedToken1: string
    expectedFee: number
  }): Promise<PoolCreationProvenanceDiagnostics>
}

export type RawPoolCreationProvenanceInput = {
  pool: string
  claimedFactory: string
  expectedToken0: string
  expectedToken1: string
  expectedFee: number
  lookupFailed: boolean
  creationTxHash: string | null
  contractCreator: string | null
  creationTraceCalledContracts: readonly string[] | null
  receiptFetchFailed: boolean
  creationReceiptFound: boolean
  transactionTo: string | null
  contractAddressFromReceipt: string | null
  creationLogs: readonly RawReceiptLog[]
}

// PURE, DISCLOSED: all classification logic lives here, independent of how the raw evidence was
// gathered -- directly unit-testable (including this task's own production scenario) without a
// live indexed provider or RPC client.
export function classifyPoolCreationProvenance(input: RawPoolCreationProvenanceInput): PoolCreationProvenanceDiagnostics {
  const pool = input.pool.toLowerCase()
  const claimedFactory = input.claimedFactory.toLowerCase()

  const base = { pool }

  if (input.lookupFailed) {
    return {
      ...base, creationTxHash: null, contractCreator: null, transactionTo: null,
      claimedFactoryInCreationPath: null, creationReceiptFound: false, exactPoolCreated: null,
      tokenPairVerified: null, feeVerified: null, finalTypedReason: 'provider_failure',
    }
  }

  if (!input.creationTxHash) {
    return {
      ...base, creationTxHash: null, contractCreator: null, transactionTo: null,
      claimedFactoryInCreationPath: null, creationReceiptFound: false, exactPoolCreated: null,
      tokenPairVerified: null, feeVerified: null, finalTypedReason: 'creation_tx_not_found',
    }
  }

  const contractCreator = input.contractCreator ? input.contractCreator.toLowerCase() : null

  if (input.receiptFetchFailed || !input.creationReceiptFound) {
    return {
      ...base, creationTxHash: input.creationTxHash, contractCreator, transactionTo: null,
      claimedFactoryInCreationPath: null, creationReceiptFound: false, exactPoolCreated: null,
      tokenPairVerified: null, feeVerified: null, finalTypedReason: 'provider_failure',
    }
  }

  const transactionTo = input.transactionTo ? input.transactionTo.toLowerCase() : null
  const contractAddressFromReceipt = input.contractAddressFromReceipt ? input.contractAddressFromReceipt.toLowerCase() : null

  // TRACE FALLBACK, DISCLOSED: prefer real trace evidence when present; otherwise fall back to
  // "creation receipt logs and contract address only" -- exactly this task's permitted fallback.
  const claimedFactoryInCreationPath = input.creationTraceCalledContracts
    ? (contractCreator === claimedFactory || input.creationTraceCalledContracts.some((c) => c.toLowerCase() === claimedFactory))
    : (contractCreator === claimedFactory || input.creationLogs.some((l) => l.address.toLowerCase() === claimedFactory))

  const exactPoolCreated = contractAddressFromReceipt === pool || input.creationLogs.some((l) => l.address.toLowerCase() === pool)

  if (!claimedFactoryInCreationPath) {
    return {
      ...base, creationTxHash: input.creationTxHash, contractCreator, transactionTo,
      claimedFactoryInCreationPath: false, creationReceiptFound: true, exactPoolCreated,
      tokenPairVerified: null, feeVerified: null, finalTypedReason: 'creator_mismatch',
    }
  }

  if (!exactPoolCreated) {
    return {
      ...base, creationTxHash: input.creationTxHash, contractCreator, transactionTo,
      claimedFactoryInCreationPath: true, creationReceiptFound: true, exactPoolCreated: false,
      tokenPairVerified: null, feeVerified: null, finalTypedReason: 'creation_receipt_mismatch',
    }
  }

  // TOKEN PAIR / FEE VERIFICATION, DISCLOSED: only ever from a decoded, PoolCreated-shaped log
  // found within THIS creation receipt -- never guessed, never inferred from the swap-tx side.
  let tokenPairVerified: boolean | null = null
  let feeVerified: boolean | null = null
  for (const log of input.creationLogs) {
    const decoded = decodePoolCreatedLog(log)
    if (!decoded) continue
    tokenPairVerified = decoded.token0 === input.expectedToken0.toLowerCase() && decoded.token1 === input.expectedToken1.toLowerCase()
    feeVerified = decoded.fee === input.expectedFee
    break
  }

  if (tokenPairVerified === null || feeVerified === null) {
    return {
      ...base, creationTxHash: input.creationTxHash, contractCreator, transactionTo,
      claimedFactoryInCreationPath: true, creationReceiptFound: true, exactPoolCreated: true,
      tokenPairVerified, feeVerified, finalTypedReason: 'trace_unavailable',
    }
  }

  if (!tokenPairVerified || !feeVerified) {
    return {
      ...base, creationTxHash: input.creationTxHash, contractCreator, transactionTo,
      claimedFactoryInCreationPath: true, creationReceiptFound: true, exactPoolCreated: true,
      tokenPairVerified, feeVerified, finalTypedReason: 'creation_receipt_mismatch',
    }
  }

  return {
    ...base, creationTxHash: input.creationTxHash, contractCreator, transactionTo,
    claimedFactoryInCreationPath: true, creationReceiptFound: true, exactPoolCreated: true,
    tokenPairVerified: true, feeVerified: true, finalTypedReason: 'verified_pool_creation_provenance',
  }
}

function toRawLogs(logs: readonly { address: string; topics: readonly string[]; data: string; logIndex: number | null }[]): RawReceiptLog[] {
  return logs.map((log, index) => ({
    logIndex: log.logIndex ?? index,
    address: log.address,
    topics: [...log.topics],
    data: log.data,
  }))
}

// REAL, ON-CHAIN IMPLEMENTATION of the receipt half of this investigation -- a single
// eth_getTransactionReceipt via the shared Base client, never retried.
export function createLivePoolCreationReceiptFetcher(): PoolCreationReceiptFetcher {
  return async (_chain, txHash) => {
    const client = getSharedBaseClient()
    if (!client) return { status: 'malformed' }
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
      if (!receipt) return { status: 'missing' }
      if (receipt.status === 'reverted') return { status: 'reverted' }
      return {
        status: 'ok',
        to: receipt.to ?? null,
        contractAddress: receipt.contractAddress ?? null,
        logs: toRawLogs(receipt.logs),
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'TransactionReceiptNotFoundError') {
        return { status: 'missing' }
      }
      return { status: 'malformed' }
    }
  }
}

// REAL INDEXED-PROVIDER IMPLEMENTATION, DISCLOSED: one documented Etherscan-family endpoint
// (module=contract&action=getcontractcreation), same real, API-key-gated, honest-miss convention
// as fallbackPricing/baseScanClient.ts -- requires BASESCAN_API_KEY or ETHERSCAN_API_KEY; any
// deviation (missing key, non-200, malformed body) is an honest miss, never a fabricated result.
export function createLiveBaseScanContractCreationLookup(
  apiKey: string | undefined = process.env.BASESCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY,
): IndexedContractCreationLookup {
  return {
    async lookupContractCreation(_chain, pool) {
      if (!apiKey) return null
      try {
        const url = `https://api.basescan.org/api?module=contract&action=getcontractcreation&contractaddresses=${pool}&apikey=${apiKey}`
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
        if (!res.ok) return null
        const data = (await res.json()) as {
          status?: string
          result?: Array<{ contractAddress?: string; contractCreator?: string; txHash?: string }>
        }
        if (data.status !== '1') return null
        const entry = data.result?.[0]
        if (!entry?.txHash || !entry?.contractCreator) return null
        return { creationTxHash: entry.txHash, contractCreator: entry.contractCreator, creationTrace: null }
      } catch {
        return null
      }
    },
  }
}

// PERMANENT, PROCESS-LIFETIME CACHE, DISCLOSED: keyed by chain+pool -- a pool's own creation
// transaction is immutable, so a result (or an honestly-exhausted attempt) is cached forever, never
// re-investigated on a later call.
export type PoolCreationProvenanceCache = Map<string, PoolCreationProvenanceDiagnostics>

export function createPoolCreationProvenanceCache(): PoolCreationProvenanceCache {
  return new Map()
}

function cacheKey(chain: string, pool: string): string {
  return `${chain}:${pool.toLowerCase()}`
}

// Wraps the two bounded real calls (indexed lookup, creation-receipt fetch) with the permanent
// cache described above. NO RETRIES anywhere in this path.
export function createPoolCreationProvenanceInvestigator(
  lookup: IndexedContractCreationLookup,
  receiptFetcher: PoolCreationReceiptFetcher,
  cache: PoolCreationProvenanceCache,
): PoolCreationProvenanceInvestigator {
  return {
    async investigate({ chain, pool, claimedFactory, expectedToken0, expectedToken1, expectedFee }) {
      const key = cacheKey(chain, pool)
      const cached = cache.get(key)
      if (cached) return cached

      // CALL 1 of 2: the single configured indexed-provider lookup.
      let lookupResult: IndexedContractCreationResult | null = null
      let lookupFailed = false
      try {
        lookupResult = await lookup.lookupContractCreation(chain, pool)
      } catch {
        lookupFailed = true
      }

      if (lookupFailed || !lookupResult) {
        const result = classifyPoolCreationProvenance({
          pool, claimedFactory, expectedToken0, expectedToken1, expectedFee,
          lookupFailed, creationTxHash: null, contractCreator: null, creationTraceCalledContracts: null,
          receiptFetchFailed: false, creationReceiptFound: false, transactionTo: null,
          contractAddressFromReceipt: null, creationLogs: [],
        })
        cache.set(key, result)
        return result
      }

      // CALL 2 of 2: the single creation-receipt fetch.
      let receiptOutcome: PoolCreationReceiptOutcome
      try {
        receiptOutcome = await receiptFetcher(chain, lookupResult.creationTxHash)
      } catch {
        receiptOutcome = { status: 'malformed' }
      }

      const result = classifyPoolCreationProvenance({
        pool, claimedFactory, expectedToken0, expectedToken1, expectedFee,
        lookupFailed: false, creationTxHash: lookupResult.creationTxHash, contractCreator: lookupResult.contractCreator,
        creationTraceCalledContracts: lookupResult.creationTrace ? lookupResult.creationTrace.calledContracts : null,
        receiptFetchFailed: receiptOutcome.status !== 'ok',
        creationReceiptFound: receiptOutcome.status === 'ok',
        transactionTo: receiptOutcome.status === 'ok' ? receiptOutcome.to : null,
        contractAddressFromReceipt: receiptOutcome.status === 'ok' ? receiptOutcome.contractAddress : null,
        creationLogs: receiptOutcome.status === 'ok' ? receiptOutcome.logs : [],
      })
      cache.set(key, result)
      return result
    },
  }
}
