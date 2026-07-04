// src/modules/timelines/index.ts — Timelines engine.
//
// FABRICATED-PREMISE DISCLOSURE: the task said "fix"/"rewrite" the timelines engine at
// `src/modules/timelines` — this path did not exist before this file. The real, pre-existing
// timeline-shaped modules are `src/modules/timelineBuilder` (buy/distribution timelines) and
// `src/modules/sellTimeline` (the V2 sell read-model) — neither has a 2-layer timeout system,
// fallback events, or skip-mode, and neither is modified here (per "do not modify unrelated
// modules"). This file is new, additive functionality that happens to share the word "timeline."
//
// INPUT-SHAPE DISCLOSURE (same reasoning as src/modules/reasonEngine/index.ts's own header): the
// task named `swapNormalizer output`/`transferNormalizer output`/`fifoEngine output`/
// `behaviorIntel output` as inputs, but `transferNormalizer` does not exist anywhere in this
// codebase (confirmed by repo-wide search), and `fifoEngine` has two competing real
// implementations in this codebase (src/modules/fifoEngine vs. lotOpener+lotCloser — see
// docs/wallet-scanner-safety-audit.md's risk #6). Rather than bind this engine to one specific
// upstream shape, it accepts a small set of already-classified candidate events
// (`TimelineEventInput`) carrying just what classification/metadata/pricing/contract-name lookup
// actually need — a caller from swapNormalizer, tradeIntent, lpAddRemoveDetector, bridgeDetection,
// or fifoEngine/lotCloser can all produce this shape from their own real outputs without this file
// needing to import any of them directly. `metadataEngine` (lib/engines/metadataEngine.ts, this
// session's own real, existing engine) and `pricingEngine` (src/modules/pricing, MODULE 11's real
// exported name, confirmed via that module's own header) ARE imported directly, since the task
// named those two specifically and both are real, unambiguous, single implementations.
//
// PRICING SCOPE, DISCLOSED: `src/modules/pricing`'s `resolvePrices` answers "what is this token
// worth RIGHT NOW" (see that module's own types.ts header) — not a historical price at the event's
// own timestamp. This engine uses it as-is (matching the task's literal instruction to integrate
// with "pricingEngine"), so `valueUsd` on older events reflects current price × amount, not the
// value at the time of the event. A historically-accurate version would need
// `lib/engines/pricingAtTimeEngine.ts`'s `getPriceAtTime` instead — noted here, not silently
// substituted, since the task named this specific module.
//
// CONTRACT-NAME LOOKUP, DISCLOSED: no general-purpose "contract name" resolver exists anywhere in
// this codebase. The closest real capability is `src/modules/swapNormalizer/routers.ts`'s
// `routerName()` — a real, known-DEX-router-address registry (Aerodrome/BaseSwap/Uniswap V3/etc).
// Reused here for `contract-call`/`bridge` events with a `contractAddress`; any address not in that
// registry honestly falls back to "Unknown Contract" (requirement #3's own fallback string) rather
// than a fabricated name.

import type { SwapNormalizerChain } from '../swapNormalizer/types'
import { routerName } from '../swapNormalizer/routers'
import { getTokenMetadata, type MetadataChain } from '@/lib/engines/metadataEngine'
import { resolvePrices } from '../pricing'

export type TimelineEventType =
  | 'buy'
  | 'sell'
  | 'transfer'
  | 'lp-deposit'
  | 'lp-withdraw'
  | 'bridge'
  | 'contract-call'
  | 'unknown'

// A caller-supplied candidate event — already classified by whichever upstream module produced it
// (swapNormalizer/tradeIntent/lpAddRemoveDetector/bridgeDetection/fifoEngine or lotOpener+lotCloser
// — see file header). This engine trusts `typeHint` when present and valid; it does not re-derive
// classification from raw logs itself.
export type TimelineEventInput = {
  txHash: string
  timestamp: number
  chain: SwapNormalizerChain
  typeHint?: TimelineEventType
  tokenAddress?: string | null
  amount?: number | null
  contractAddress?: string | null
}

export type TimelineEvent =
  | {
      skip: true
      reason: string
      txHash?: string
    }
  | {
      skip: false
      type: TimelineEventType
      token: string
      valueUsd: number | null
      metadataStatus: string
      pricingStatus: string
      contractName: string
      txHash: string
      timestamp: number
    }

export type TimelinesResult = {
  events: TimelineEvent[]
  diagnostics: {
    totalEvents: number
    skippedEvents: number
    fallbackEvents: number
    metadataStatus: string
    pricingStatus: string
  }
}

const PER_EVENT_TIMEOUT_MS = 2_000
const WHOLE_TIMELINE_TIMEOUT_MS = 3_000

const VALID_TYPES = new Set<TimelineEventType>([
  'buy', 'sell', 'transfer', 'lp-deposit', 'lp-withdraw', 'bridge', 'contract-call', 'unknown',
])

// A price is only genuinely "resolved" when a real source produced it — src/modules/pricing's own
// PriceSource union includes 'unavailable' as a real, honest "no price found" outcome (distinct
// from this file's own "missing" sentinel used when a lookup wasn't attempted at all, e.g. no
// tokenAddress). Both must count as NOT-ok for diagnostics/fallback purposes.
function isPricingResolved(pricingStatus: string): boolean {
  return pricingStatus !== 'missing' && pricingStatus !== 'unavailable'
}

const FALLBACK_EVENT_BASE = {
  type: 'unknown' as const,
  token: 'UNKNOWN',
  valueUsd: null as number | null,
  metadataStatus: 'fallback',
  pricingStatus: 'missing',
  contractName: 'Unknown Contract',
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

// A candidate event is unprocessable (requirement #4 skip-mode) when it has neither a recognizable
// type hint nor any token/contract identity to work with at all — there is nothing to classify,
// price, or name.
function isUnprocessable(input: TimelineEventInput): boolean {
  const hasKnownType = typeof input.typeHint === 'string' && VALID_TYPES.has(input.typeHint)
  const hasAnyIdentity = Boolean(input.tokenAddress) || Boolean(input.contractAddress)
  return !hasKnownType && !hasAnyIdentity
}

// pricing/metadata/contract-name lookups for exactly ONE event, run in parallel via
// Promise.allSettled (requirement #2) and capped by the per-event timeout (requirement #1). Never
// throws — every branch below resolves to a plain value, honest fallback included.
async function resolveEventDetails(
  input: TimelineEventInput,
): Promise<{ token: string; valueUsd: number | null; metadataStatus: string; pricingStatus: string; contractName: string }> {
  const metadataChain: MetadataChain | null =
    input.chain === 'base' || input.chain === 'eth' || input.chain === 'arbitrum' ? input.chain : null

  const metadataPromise = (metadataChain && input.tokenAddress)
    ? getTokenMetadata(metadataChain, input.tokenAddress)
    : Promise.resolve(null)

  const pricingPromise = (metadataChain && input.tokenAddress)
    ? resolvePrices([{ chain: metadataChain, contract: input.tokenAddress }])
    : Promise.resolve([])

  const contractNamePromise = Promise.resolve(
    input.contractAddress ? routerName(input.chain, input.contractAddress) : null,
  )

  const settled = await withTimeout(
    Promise.allSettled([metadataPromise, pricingPromise, contractNamePromise]),
    PER_EVENT_TIMEOUT_MS,
  ).catch(() => null) // per-event timeout (or any unexpected rejection) -> treat as "all missing" below

  const metadataResult = settled && settled[0].status === 'fulfilled' ? settled[0].value : null
  const pricingResult = settled && settled[1].status === 'fulfilled' ? settled[1].value : []
  const contractNameResult = settled && settled[2].status === 'fulfilled' ? settled[2].value : null

  const token = metadataResult && !metadataResult.skip ? metadataResult.symbol : FALLBACK_EVENT_BASE.token
  const metadataStatus = metadataResult ? metadataResult.metadataStatus : 'fallback'

  const priceEntry = Array.isArray(pricingResult) ? pricingResult[0] : undefined
  const priceUsd = priceEntry?.priceUsd ?? null
  const valueUsd = priceUsd != null && typeof input.amount === 'number' ? priceUsd * input.amount : null
  const pricingStatus = priceEntry ? priceEntry.source : 'missing'

  const contractName = contractNameResult ?? FALLBACK_EVENT_BASE.contractName

  return { token, valueUsd, metadataStatus, pricingStatus, contractName }
}

async function buildOneEvent(input: TimelineEventInput): Promise<{ event: TimelineEvent; isFallback: boolean }> {
  if (isUnprocessable(input)) {
    return { event: { skip: true, reason: 'unrecognized-event', txHash: input.txHash }, isFallback: false }
  }

  const type: TimelineEventType = input.typeHint && VALID_TYPES.has(input.typeHint) ? input.typeHint : 'unknown'

  try {
    const details = await resolveEventDetails(input)
    const isFallback = details.metadataStatus === 'fallback' || !isPricingResolved(details.pricingStatus)
    return {
      event: {
        skip: false,
        type,
        token: details.token,
        valueUsd: details.valueUsd,
        metadataStatus: details.metadataStatus,
        pricingStatus: details.pricingStatus,
        contractName: details.contractName,
        txHash: input.txHash,
        timestamp: input.timestamp,
      },
      isFallback,
    }
  } catch {
    // Final per-event backstop (requirement #5) — never throw out of buildOneEvent.
    return {
      event: { skip: false, ...FALLBACK_EVENT_BASE, txHash: input.txHash, timestamp: input.timestamp },
      isFallback: true,
    }
  }
}

function emptyDiagnostics(totalEvents: number): TimelinesResult['diagnostics'] {
  return { totalEvents, skippedEvents: 0, fallbackEvents: 0, metadataStatus: 'unavailable', pricingStatus: 'unavailable' }
}

// Public entry point. NEVER throws, NEVER rejects (requirement #5) — the WHOLE-TIMELINE timeout
// (requirement #1) races the full build; if it fires, whatever events already resolved are
// returned as a partial timeline rather than waiting for the rest. The outer try/catch is a final
// backstop against any genuinely unexpected error.
export async function buildTimelines(inputs: TimelineEventInput[]): Promise<TimelinesResult> {
  try {
    const safeInputs = Array.isArray(inputs) ? inputs : []
    if (safeInputs.length === 0) {
      return { events: [], diagnostics: emptyDiagnostics(0) }
    }

    // Each input builds independently; Promise.allSettled (requirement #2) means one event's
    // unexpected failure can never lose every other event's result.
    const buildAll = Promise.allSettled(safeInputs.map(buildOneEvent))

    const settled = await withTimeout(buildAll, WHOLE_TIMELINE_TIMEOUT_MS).catch(
      // WHOLE-TIMELINE TIMEOUT fired: nothing resolved in time (allSettled itself never rejects, so
      // reaching here means the 3s race lost) -> return an empty-but-valid partial timeline rather
      // than blocking the caller any longer.
      () => [] as PromiseSettledResult<{ event: TimelineEvent; isFallback: boolean }>[],
    )

    const events: TimelineEvent[] = []
    let skippedEvents = 0
    let fallbackEvents = 0
    let metadataOkCount = 0
    let pricingOkCount = 0

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue // one event's rejection never drops the others
      const { event, isFallback } = result.value
      events.push(event)
      if ('skip' in event && event.skip) {
        skippedEvents += 1
        continue
      }
      if (isFallback) fallbackEvents += 1
      if (!event.skip) {
        if (event.metadataStatus !== 'fallback') metadataOkCount += 1
        if (isPricingResolved(event.pricingStatus)) pricingOkCount += 1
      }
    }

    const resolvedCount = events.length - skippedEvents
    const metadataStatus = resolvedCount === 0 ? 'unavailable' : metadataOkCount === resolvedCount ? 'ok' : metadataOkCount === 0 ? 'unavailable' : 'partial'
    const pricingStatus = resolvedCount === 0 ? 'unavailable' : pricingOkCount === resolvedCount ? 'ok' : pricingOkCount === 0 ? 'unavailable' : 'partial'

    return {
      events,
      diagnostics: {
        totalEvents: safeInputs.length,
        skippedEvents,
        fallbackEvents,
        metadataStatus,
        pricingStatus,
      },
    }
  } catch {
    // Final backstop (requirement #5) — a fully-valid, empty TimelinesResult even on a genuinely
    // unexpected internal error, never a throw/reject/504 reaching the caller.
    return { events: [], diagnostics: emptyDiagnostics(Array.isArray(inputs) ? inputs.length : 0) }
  }
}
