// MODULE — roiQuoteLegTxBackfill
//
// TARGETED, DISCLOSED: recovers missing ROI quote-leg identities for verified stablecoin lots that
// have neither live FIFO/event proof nor a matching persisted proof. The original 72-quote audit
// used a one-off full-history FIFO dump that was never stored; bounded scans cannot re-prove those
// counterparts without re-fetching the whole wallet. This module does NOT paginate history. It
// fetches only the already-known open/close transaction hashes on those unproven lots, deduped,
// capped, and cached, and inspects wallet-relative ERC20 / WETH-wrap transfer legs in that receipt.
//
// PROOF STANDARD, UNCHANGED: a stable lot is excluded only when the same-tx opposite-direction
// non-stable economic leg is present (address-checked, never symbol-guessed). A genuine
// EOA/CEX/mint movement with no opposite risk asset remains eligible. Failed, timed-out, or capped
// lookups stay unresolved — never guessed into the denominator. Live FIFO/event proof still wins;
// persisted proofs still replay; this backfill only fills missing proof.
//
// FIFO matching, lot pricing, accepted evidence, canonical sample membership/values, displayed
// sample PnL, and the UI are not modified.

import type { MatchedLot } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { SupportedChain } from '../modules/providerFetchWindow/types'
import { NATIVE_ASSET_ADDRESS } from '../modules/providerFetchWindow/utils'
import { isCanonicalWethAddress } from '../modules/quoteLegPricing/index'
import {
  ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION,
  classifyVerifiedSampleRoiEligibility,
  type PersistedRoiQuoteLegProof,
  type VerifiedSampleRoiLotClassification,
} from './verifiedSampleRoiEligibility'

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const WETH_DEPOSIT_TOPIC0 = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'
const WETH_WITHDRAWAL_TOPIC0 = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'
const ZERO = '0x0000000000000000000000000000000000000000'

// Strict per-scan live-call cap. Unique open/close hashes are fetched at most once (request-scope
// + durable cache). A wallet whose unproven stables need more unique txs than this cap leaves the
// remainder unresolved rather than paginating history.
export const MAX_ROI_QUOTE_TX_BACKFILL_CALLS = 80
const DEFAULT_CONCURRENCY = 3
const DUMMY_UNMATCHED_TX_PREFIX = 'roi-unmatched-'

export type RoiQuoteLegTxBackfillAudit = {
  lotsNeedingProof: number
  uniqueTxsNeeded: number
  cacheHits: number
  providerCalls: number
  quoteProofsRecovered: number
  independentProofsRecovered: number
  unresolvedAfterBackfill: number
  capped: boolean
}

export const EMPTY_ROI_QUOTE_LEG_TX_BACKFILL_AUDIT: RoiQuoteLegTxBackfillAudit = {
  lotsNeedingProof: 0,
  uniqueTxsNeeded: 0,
  cacheHits: 0,
  providerCalls: 0,
  quoteProofsRecovered: 0,
  independentProofsRecovered: 0,
  unresolvedAfterBackfill: 0,
  capped: false,
}

export type RoiQuoteLegTxReceiptLog = {
  address: string
  topics: string[]
  data: string
  logIndex?: number
}

export type RoiQuoteLegTxReceiptFetcher = (
  chain: SupportedChain,
  txHash: string,
) => Promise<{ logs: readonly RoiQuoteLegTxReceiptLog[] } | null>

export type RoiQuoteLegTxBackfillCache = {
  get: <T>(key: string) => Promise<T | null | undefined>
  set: (key: string, value: unknown) => Promise<unknown>
}

export type RoiQuoteLegTxBackfillResult = {
  events: NormalizedEvent[]
  proofs: PersistedRoiQuoteLegProof[]
  unconfirmedLotKeys: string[]
  audit: RoiQuoteLegTxBackfillAudit
}

function topicAddress(topic: string | undefined): string | null {
  if (typeof topic !== 'string' || topic.length < 40) return null
  return `0x${topic.slice(-40)}`.toLowerCase()
}

function isFetchableTxHash(txHash: string): boolean {
  const normalized = txHash.toLowerCase()
  if (!normalized.startsWith('0x') || normalized.length < 10) return false
  if (normalized.startsWith(DUMMY_UNMATCHED_TX_PREFIX)) return false
  return true
}

export function roiQuoteLegTxBackfillCacheKey(chain: SupportedChain, txHash: string): string {
  return `v1:roi-quote-leg-tx-backfill:${chain}:${txHash.toLowerCase()}`
}

function receiptRpcUrl(chain: SupportedChain): string | null {
  if (chain === 'eth') {
    const explicit = process.env.ETH_RPC_URL
    if (explicit && /^https?:\/\//.test(explicit)) return explicit
    const key = process.env.ALCHEMY_ETHEREUM_KEY
    return key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : null
  }
  if (chain === 'base') {
    const explicit = process.env.BASE_RPC_URL ?? process.env.ALCHEMY_BASE_RPC_URL
    if (explicit && /^https?:\/\//.test(explicit)) return explicit
    const key = process.env.ALCHEMY_BASE_KEY
    if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
    return 'https://mainnet.base.org'
  }
  return null
}

const RECEIPT_TIMEOUT_MS = 4000

// One eth_getTransactionReceipt per unique (chain, tx). Never paginates. Unsupported chains,
// timeouts, RPC errors, missing/reverted receipts all resolve to null (unresolved, never guessed).
export async function fetchRoiQuoteLegTxReceipt(
  chain: SupportedChain,
  txHash: string,
): Promise<{ logs: RoiQuoteLegTxReceiptLog[] } | null> {
  const url = receiptRpcUrl(chain)
  if (!url) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RECEIPT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
    })
    if (!res.ok) return null
    const json = await res.json().catch(() => null) as { result?: { status?: string; logs?: RoiQuoteLegTxReceiptLog[] } | null } | null
    if (!json?.result || json.result.status === '0x0' || !Array.isArray(json.result.logs)) return null
    return { logs: json.result.logs }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function isProvenWithoutBackfill(reason: VerifiedSampleRoiLotClassification['reason']): boolean {
  return reason === 'fifo_paired_quote_cash'
    || reason === 'event_paired_quote_cash'
    || reason === 'persisted_quote_cash'
    || reason === 'persisted_independent'
}

export function lotsNeedingRoiQuoteLegTxBackfill(
  classifications: readonly VerifiedSampleRoiLotClassification[],
): VerifiedSampleRoiLotClassification[] {
  return classifications.filter((row) => (
    row.reason !== 'non_stable_economic_position'
    && !isProvenWithoutBackfill(row.reason)
  ))
}

// PURE: decode wallet-relative ERC20 Transfer logs and WETH wrap/unwrap native legs from an
// already-fetched receipt. Never infers a token from its symbol. Amount is unused by the ROI
// classifier (pairing is direction + address-verified non-stable), so a missing/unparseable amount
// still emits the leg — the economic identity is the transfer itself.
export function decodeWalletRelativeTransferLegs(params: {
  chain: SupportedChain
  txHash: string
  walletAddress: string
  logs: readonly RoiQuoteLegTxReceiptLog[]
  timestampIso?: string
}): NormalizedEvent[] {
  const wallet = params.walletAddress.toLowerCase()
  const timestamp = params.timestampIso ?? '1970-01-01T00:00:00.000Z'
  const events: NormalizedEvent[] = []
  for (const log of params.logs) {
    const topic0 = log.topics[0]?.toLowerCase()
    const address = log.address.toLowerCase()
    if (topic0 === TRANSFER_TOPIC0 && log.topics.length >= 3) {
      const from = topicAddress(log.topics[1])
      const to = topicAddress(log.topics[2])
      if (!from || !to) continue
      if (from !== wallet && to !== wallet) continue
      let amountRaw: string | null = null
      if (typeof log.data === 'string' && /^0x[0-9a-fA-F]+$/.test(log.data) && log.data.length > 2) {
        try { amountRaw = BigInt(log.data).toString() } catch { amountRaw = null }
      }
      events.push({
        provider: 'alchemy',
        chain: params.chain,
        txHash: params.txHash,
        timestamp,
        fromAddress: from,
        toAddress: to,
        contract: address,
        symbol: '',
        amount: 1,
        amountRaw,
        tokenDecimals: 18,
        direction: to === wallet ? 'inbound' : 'outbound',
      })
      continue
    }
    if (topic0 === WETH_DEPOSIT_TOPIC0 && log.topics.length >= 2 && isCanonicalWethAddress(params.chain, address)) {
      const dst = topicAddress(log.topics[1])
      if (dst !== wallet) continue
      events.push({
        provider: 'alchemy',
        chain: params.chain,
        txHash: params.txHash,
        timestamp,
        fromAddress: wallet,
        toAddress: address,
        contract: NATIVE_ASSET_ADDRESS,
        symbol: '',
        amount: 1,
        amountRaw: null,
        tokenDecimals: 18,
        direction: 'outbound',
      })
      continue
    }
    if (topic0 === WETH_WITHDRAWAL_TOPIC0 && log.topics.length >= 2 && isCanonicalWethAddress(params.chain, address)) {
      const src = topicAddress(log.topics[1])
      if (src !== wallet) continue
      events.push({
        provider: 'alchemy',
        chain: params.chain,
        txHash: params.txHash,
        timestamp,
        fromAddress: address,
        toAddress: wallet,
        contract: NATIVE_ASSET_ADDRESS,
        symbol: '',
        amount: 1,
        amountRaw: null,
        tokenDecimals: 18,
        direction: 'inbound',
      })
    }
  }
  return events
}

function cachedEvents(raw: unknown): NormalizedEvent[] | null {
  if (raw === null || typeof raw !== 'object') return null
  const events = (raw as { events?: unknown }).events
  if (!Array.isArray(events)) return null
  const out: NormalizedEvent[] = []
  for (const item of events) {
    if (item === null || typeof item !== 'object') continue
    const event = item as Partial<NormalizedEvent>
    if (typeof event.chain !== 'string' || typeof event.txHash !== 'string') continue
    if (typeof event.contract !== 'string') continue
    if (event.direction !== 'inbound' && event.direction !== 'outbound' && event.direction !== 'unknown') continue
    out.push({
      provider: event.provider === 'goldrush' ? 'goldrush' : 'alchemy',
      chain: event.chain as SupportedChain,
      txHash: event.txHash,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : '1970-01-01T00:00:00.000Z',
      fromAddress: typeof event.fromAddress === 'string' ? event.fromAddress : ZERO,
      toAddress: typeof event.toAddress === 'string' ? event.toAddress : ZERO,
      contract: event.contract,
      symbol: typeof event.symbol === 'string' ? event.symbol : '',
      amount: typeof event.amount === 'number' && Number.isFinite(event.amount) ? event.amount : 1,
      amountRaw: typeof event.amountRaw === 'string' ? event.amountRaw : null,
      tokenDecimals: typeof event.tokenDecimals === 'number' ? event.tokenDecimals : 18,
      direction: event.direction,
    })
  }
  return out
}

async function mapWithConcurrencyLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  const workerCount = Math.min(limit, items.length)
  if (workerCount === 0) return results
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function uniqueTxsForLots(rows: readonly VerifiedSampleRoiLotClassification[]): Array<{ chain: SupportedChain; txHash: string }> {
  const seen = new Set<string>()
  const out: Array<{ chain: SupportedChain; txHash: string }> = []
  for (const row of rows) {
    for (const txHash of [row.openedTxHash, row.closedTxHash]) {
      if (!isFetchableTxHash(txHash)) continue
      const key = `${row.chain}:${txHash.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ chain: row.chain, txHash })
    }
  }
  out.sort((a, b) => {
    const chain = a.chain.localeCompare(b.chain)
    return chain !== 0 ? chain : a.txHash.toLowerCase().localeCompare(b.txHash.toLowerCase())
  })
  return out
}

function backfillProofFromRow(row: VerifiedSampleRoiLotClassification): PersistedRoiQuoteLegProof | null {
  if (row.roiDenominatorDisposition === 'exclude_quote_cash_leg') {
    const pairedAtOpen = row.fifoPairAtOpen || row.eventPairAtOpen
    return {
      stableLotKey: row.lotKey,
      disposition: 'exclude_quote_cash_leg',
      pairedRiskToken: (pairedAtOpen ? row.openingCounterAsset : row.closingCounterAsset) ?? null,
      pairedTxHash: pairedAtOpen ? row.openedTxHash : row.closedTxHash,
      proofType: 'targeted_tx_backfill',
      methodologyVersion: ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION,
    }
  }
  if (row.roiDenominatorDisposition === 'include_economic_position' && (row.isIndependentStablecoinTrade || row.reason === 'independent_eoa_cex_or_mint')) {
    return {
      stableLotKey: row.lotKey,
      disposition: 'include_economic_position',
      pairedRiskToken: null,
      pairedTxHash: null,
      proofType: 'targeted_tx_backfill',
      methodologyVersion: ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION,
    }
  }
  return null
}

export async function runRoiQuoteLegTxBackfill(params: {
  verifiedLots: readonly MatchedLot[]
  structuralLots?: readonly MatchedLot[]
  classifications: readonly VerifiedSampleRoiLotClassification[]
  normalizedEvents?: readonly NormalizedEvent[]
  persistedProofs?: readonly PersistedRoiQuoteLegProof[]
  walletAddress: string
  fetchTxReceipt: RoiQuoteLegTxReceiptFetcher
  cacheKv?: RoiQuoteLegTxBackfillCache | null
  maxProviderCalls?: number
  concurrency?: number
}): Promise<RoiQuoteLegTxBackfillResult> {
  const needing = lotsNeedingRoiQuoteLegTxBackfill(params.classifications)
  const uniqueTxs = uniqueTxsForLots(needing)
  const maxCalls = params.maxProviderCalls ?? MAX_ROI_QUOTE_TX_BACKFILL_CALLS
  const capped = uniqueTxs.length > maxCalls
  const toFetch = uniqueTxs.slice(0, maxCalls)
  const audit: RoiQuoteLegTxBackfillAudit = {
    ...EMPTY_ROI_QUOTE_LEG_TX_BACKFILL_AUDIT,
    lotsNeedingProof: needing.length,
    uniqueTxsNeeded: uniqueTxs.length,
    capped,
    unresolvedAfterBackfill: needing.length,
  }
  if (needing.length === 0 || toFetch.length === 0) {
    return { events: [], proofs: [], unconfirmedLotKeys: needing.map((row) => row.lotKey), audit }
  }

  const requestCache = new Map<string, NormalizedEvent[] | null>()
  const inFlight = new Map<string, Promise<NormalizedEvent[] | null>>()
  const fetchedOk = new Set<string>()
  const events: NormalizedEvent[] = []
  let cacheHits = 0
  let providerCalls = 0

  const loadTx = async (chain: SupportedChain, txHash: string): Promise<NormalizedEvent[] | null> => {
    const key = `${chain}:${txHash.toLowerCase()}`
    if (requestCache.has(key)) return requestCache.get(key) ?? null
    const pending = inFlight.get(key)
    if (pending) return pending
    const task = (async () => {
      const cacheKey = roiQuoteLegTxBackfillCacheKey(chain, txHash)
      if (params.cacheKv) {
        try {
          const stored = cachedEvents(await params.cacheKv.get<unknown>(cacheKey))
          if (stored) {
            cacheHits += 1
            requestCache.set(key, stored)
            return stored
          }
        } catch { /* durable cache miss — fetch live */ }
      }
      providerCalls += 1
      let decoded: NormalizedEvent[] | null = null
      try {
        const receipt = await params.fetchTxReceipt(chain, txHash)
        if (receipt) {
          decoded = decodeWalletRelativeTransferLegs({
            chain,
            txHash,
            walletAddress: params.walletAddress,
            logs: receipt.logs,
          })
        }
      } catch {
        decoded = null
      }
      requestCache.set(key, decoded)
      if (decoded && params.cacheKv) {
        try { await params.cacheKv.set(cacheKey, { events: decoded }) } catch { /* persist is best-effort */ }
      }
      return decoded
    })()
    inFlight.set(key, task)
    try {
      return await task
    } finally {
      inFlight.delete(key)
    }
  }

  const fetched = await mapWithConcurrencyLimit(toFetch, params.concurrency ?? DEFAULT_CONCURRENCY, async (item) => {
    const decoded = await loadTx(item.chain, item.txHash)
    const key = `${item.chain}:${item.txHash.toLowerCase()}`
    if (decoded) {
      fetchedOk.add(key)
      events.push(...decoded)
    }
    return decoded
  })
  void fetched

  audit.cacheHits = cacheHits
  audit.providerCalls = providerCalls

  const unconfirmedLotKeys: string[] = []
  const confirmedLots: VerifiedSampleRoiLotClassification[] = []
  for (const row of needing) {
    const openOk = !isFetchableTxHash(row.openedTxHash) || fetchedOk.has(`${row.chain}:${row.openedTxHash.toLowerCase()}`)
    const closeOk = !isFetchableTxHash(row.closedTxHash) || fetchedOk.has(`${row.chain}:${row.closedTxHash.toLowerCase()}`)
    if (openOk && closeOk) confirmedLots.push(row)
    else unconfirmedLotKeys.push(row.lotKey)
  }

  if (confirmedLots.length === 0) {
    audit.unresolvedAfterBackfill = needing.length
    return { events, proofs: [], unconfirmedLotKeys, audit }
  }

  const mergedEvents = [...(params.normalizedEvents ?? []), ...events]
  const post = classifyVerifiedSampleRoiEligibility({
    verifiedLots: params.verifiedLots,
    structuralLots: params.structuralLots ?? params.verifiedLots,
    normalizedEvents: mergedEvents,
    persistedProofs: params.persistedProofs,
  })

  const confirmedKeySet = new Set(confirmedLots.map((row) => row.lotKey))
  const proofs: PersistedRoiQuoteLegProof[] = []
  let quoteProofsRecovered = 0
  let independentProofsRecovered = 0
  for (const row of post.classifications) {
    if (!confirmedKeySet.has(row.lotKey)) continue
    const proof = backfillProofFromRow(row)
    if (!proof) continue
    proofs.push(proof)
    if (proof.disposition === 'exclude_quote_cash_leg') quoteProofsRecovered += 1
    else independentProofsRecovered += 1
  }

  audit.quoteProofsRecovered = quoteProofsRecovered
  audit.independentProofsRecovered = independentProofsRecovered
  audit.unresolvedAfterBackfill = needing.length - quoteProofsRecovered - independentProofsRecovered
  return { events, proofs, unconfirmedLotKeys, audit }
}
