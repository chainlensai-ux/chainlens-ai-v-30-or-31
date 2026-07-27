// MODULE — receiptSwapDecoder: bounded forensic classification of examined receipts.
//
// GOAL, DISCLOSED: production proof showed 10 receipts fetched, 0 Aerodrome swaps decoded (7
// plain_transfer_no_swap_event, 2 pool_not_validated_by_factory, 1 contradictory_legs) — this
// module answers "what was each of these 10 transactions actually doing" WITHOUT changing
// selection or decoding, and WITHOUT a single new provider call: every field here is derived
// purely offline from (a) the exact raw logs already fetched this scan (via decodeLogs.ts's
// existing pure decoder, called again in-process on data already in memory — never re-fetched)
// and (b) the exact factory-validation attempts decodeReceiptSwap already made this scan (recorded
// via RecordingPoolValidator below, a pass-through wrapper — never a second isValidPool call).
//
// NO NEW ABI SUPPORT, DISCLOSED: `unsupportedSwapLikeTopic0` only ever surfaces the raw topic0 hex
// string of a log this module doesn't recognize — it never attempts to decode it, never adds a new
// signature constant, never classifies its semantics beyond "not one of our known topics".
//
// SHADOW/DEBUG-ONLY, DISCLOSED: this is purely additive diagnostic output, bounded to at most 10
// samples (matching the receipt-acquisition cap) — never fed into FIFO/pricing/PnL/canonical
// events/router inference, never used to change which candidates are selected or how they decode.

import { decodeLogs } from './decodeLogs'
import {
  CLASSIC_SWAP_TOPIC0, CLASSIC_MINT_TOPIC0, CLASSIC_BURN_TOPIC0,
  SLIPSTREAM_SWAP_TOPIC0, SLIPSTREAM_MINT_TOPIC0, SLIPSTREAM_BURN_TOPIC0,
  ERC20_TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0,
} from './signatures'
import type { PoolValidator } from './poolValidator'
import type { RawReceiptLog, ReceiptDecodeResult, ReceiptSwapProtocol } from './types'

const KNOWN_TOPIC_LABELS: Record<string, string> = {
  [CLASSIC_SWAP_TOPIC0]: 'classic_swap',
  [CLASSIC_MINT_TOPIC0]: 'classic_mint',
  [CLASSIC_BURN_TOPIC0]: 'classic_burn',
  [SLIPSTREAM_SWAP_TOPIC0]: 'slipstream_swap',
  [SLIPSTREAM_MINT_TOPIC0]: 'slipstream_mint',
  [SLIPSTREAM_BURN_TOPIC0]: 'slipstream_burn',
  [ERC20_TRANSFER_TOPIC0]: 'erc20_transfer',
  [WETH_DEPOSIT_TOPIC0]: 'weth_deposit',
  [WETH_WITHDRAWAL_TOPIC0]: 'weth_withdrawal',
}

const MAX_UNSUPPORTED_TOPICS = 5
const MAX_CONTRADICTION_TRANSFERS = 10
export const MAX_FORENSIC_SAMPLES = 10

export type FactoryValidationAttempt = {
  protocol: ReceiptSwapProtocol
  poolAddress: string
  token0: string
  token1: string
  result: boolean
}

// Pass-through recorder — makes zero additional calls of its own; every call it records is a call
// the caller (decodeReceiptSwap, via its own validator dependency) was already going to make.
export function createRecordingPoolValidator(inner: PoolValidator, attempts: FactoryValidationAttempt[]): PoolValidator {
  return {
    async isValidPool(protocol, poolAddress, token0, token1) {
      const result = await inner.isValidPool(protocol, poolAddress, token0, token1)
      attempts.push({ protocol, poolAddress, token0, token1, result })
      return result
    },
  }
}

export type ContradictionDetail = {
  poolAddress: string
  incomingTransferCount: number
  outgoingTransferCount: number
  transfers: Array<{ logIndex: number; token: string; from: string; to: string; value: string }>
  contradiction: string
} | null

export type LikelyRoute =
  | 'aerodrome_classic'
  | 'aerodrome_slipstream'
  | 'uniswap_v2_like'
  | 'uniswap_v3_like'
  | 'aggregator_or_router'
  | 'ordinary_transfer'
  | 'unknown'

export type ReceiptForensicSample = {
  txHash: string
  candidatePriorityTier: number | null
  candidatePriorityReason: string | null
  logCount: number
  uniqueEmitterCount: number
  recognisedTopicCounts: Record<string, number>
  aerodromeSwapEventCount: number
  unsupportedSwapLikeTopic0: string[]
  candidatePoolAddresses: string[]
  factoryValidationAttempts: FactoryValidationAttempt[]
  transferCount: number
  wrapCount: number
  lpEventCount: number
  finalRejectionReason: string | null
  contradiction: ContradictionDetail
  likelyRoute: LikelyRoute
}

// Finds the specific "more/fewer than one incoming or outgoing transfer" contradiction for the
// FIRST pool that has a recognized swap event but doesn't resolve to exactly one in + one out
// transfer — the exact same ambiguity index.ts's resolvePoolLeg fails closed on, surfaced here for
// forensic visibility rather than re-derived with different logic.
function findContradiction(logs: RawReceiptLog[]): ContradictionDetail {
  const decoded = decodeLogs(logs)
  for (const swap of decoded.swaps) {
    const incoming = decoded.transfers.filter((t) => t.to === swap.poolAddress && t.value > BigInt('0'))
    const outgoing = decoded.transfers.filter((t) => t.from === swap.poolAddress && t.value > BigInt('0'))
    if (incoming.length === 1 && outgoing.length === 1 && incoming[0].token !== outgoing[0].token) continue
    const relevant = [...incoming, ...outgoing].slice(0, MAX_CONTRADICTION_TRANSFERS)
    const contradiction = incoming.length !== 1
      ? `expected exactly 1 incoming transfer into pool ${swap.poolAddress}, found ${incoming.length}`
      : outgoing.length !== 1
        ? `expected exactly 1 outgoing transfer from pool ${swap.poolAddress}, found ${outgoing.length}`
        : `incoming and outgoing transfer share the same token (${incoming[0].token}) at pool ${swap.poolAddress}`
    return {
      poolAddress: swap.poolAddress,
      incomingTransferCount: incoming.length,
      outgoingTransferCount: outgoing.length,
      transfers: relevant.map((t) => ({ logIndex: t.logIndex, token: t.token, from: t.from, to: t.to, value: t.value.toString() })),
      contradiction,
    }
  }
  return null
}

function classifyLikelyRoute(params: {
  aerodromeSwapEventCount: number
  hasClassicSwap: boolean
  hasSlipstreamSwap: boolean
  factoryValidationAttempts: FactoryValidationAttempt[]
  lpEventCount: number
  transferCount: number
  uniqueEmitterCount: number
}): LikelyRoute {
  const { hasClassicSwap, hasSlipstreamSwap, factoryValidationAttempts, lpEventCount, transferCount, uniqueEmitterCount } = params

  if (hasClassicSwap) {
    const attemptedNotValidated = factoryValidationAttempts.some((a) => a.protocol === 'aerodrome_classic' && !a.result)
    return attemptedNotValidated ? 'uniswap_v2_like' : 'aerodrome_classic'
  }
  if (hasSlipstreamSwap) {
    const attemptedNotValidated = factoryValidationAttempts.some((a) => a.protocol === 'aerodrome_slipstream' && !a.result)
    return attemptedNotValidated ? 'uniswap_v3_like' : 'aerodrome_slipstream'
  }
  if (lpEventCount > 0) return 'unknown'
  if (transferCount >= 2 && uniqueEmitterCount >= 2) return 'aggregator_or_router'
  if (transferCount > 0) return 'ordinary_transfer'
  return 'unknown'
}

export type ClassifyReceiptForensicsInput = {
  txHash: string
  candidatePriorityTier: number | null
  candidatePriorityReason: string | null
  logs: RawReceiptLog[]
  decodeResult: ReceiptDecodeResult
  factoryValidationAttempts: FactoryValidationAttempt[]
}

// PURE, offline — reuses decodeLogs.ts's own decoder (already in-memory logs, no I/O) rather than
// re-deriving log classification with separate logic.
export function classifyReceiptForensics(input: ClassifyReceiptForensicsInput): ReceiptForensicSample {
  const { logs, decodeResult, factoryValidationAttempts } = input
  const decoded = decodeLogs(logs)

  const recognisedTopicCounts: Record<string, number> = {}
  const unsupportedSwapLikeTopic0: string[] = []
  const seenUnsupported = new Set<string>()
  const emitters = new Set<string>()

  for (const log of logs) {
    emitters.add(log.address.toLowerCase())
    const topic0 = (log.topics[0] ?? '').toLowerCase()
    const label = KNOWN_TOPIC_LABELS[topic0]
    if (label) {
      recognisedTopicCounts[label] = (recognisedTopicCounts[label] ?? 0) + 1
    } else if (topic0 && !seenUnsupported.has(topic0) && unsupportedSwapLikeTopic0.length < MAX_UNSUPPORTED_TOPICS) {
      seenUnsupported.add(topic0)
      unsupportedSwapLikeTopic0.push(topic0)
    }
  }

  const hasClassicSwap = decoded.swaps.some((s) => s.protocol === 'aerodrome_classic')
  const hasSlipstreamSwap = decoded.swaps.some((s) => s.protocol === 'aerodrome_slipstream')

  const finalRejectionReason = decodeResult.ok ? null : decodeResult.rejection.reason
  const contradiction = finalRejectionReason === 'contradictory_legs' ? findContradiction(logs) : null

  const likelyRoute = classifyLikelyRoute({
    aerodromeSwapEventCount: decoded.swaps.length,
    hasClassicSwap,
    hasSlipstreamSwap,
    factoryValidationAttempts,
    lpEventCount: decoded.lpEvents.length,
    transferCount: decoded.transfers.length,
    uniqueEmitterCount: emitters.size,
  })

  return {
    txHash: input.txHash,
    candidatePriorityTier: input.candidatePriorityTier,
    candidatePriorityReason: input.candidatePriorityReason,
    logCount: logs.length,
    uniqueEmitterCount: emitters.size,
    recognisedTopicCounts,
    aerodromeSwapEventCount: decoded.swaps.length,
    unsupportedSwapLikeTopic0,
    candidatePoolAddresses: [...new Set(decoded.swaps.map((s) => s.poolAddress))],
    factoryValidationAttempts,
    transferCount: decoded.transfers.length,
    wrapCount: decoded.nativeWraps.length,
    lpEventCount: decoded.lpEvents.length,
    finalRejectionReason,
    contradiction,
    likelyRoute,
  }
}
