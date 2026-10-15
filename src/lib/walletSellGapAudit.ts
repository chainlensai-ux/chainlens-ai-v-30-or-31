// Sell-gap audit (logging only): why a wallet shows buys but few/no sells. Read-only — mirrors the
// exact predicates the sell timeline and the receipt selector already use, never decides anything.
//
//   [wallet-sell-gap-audit]        per outbound event: why it did not become a sell; wallet-not-party
//                                  raw events (which provider produced them, from/to); native ETH
//                                  history per chain (did the internal-transfer pull work?).
//   [receipt-selector-sell-audit]  receipt selector by chain, what happened to every outbound-exit
//                                  candidate (selected? fetched within budget? decoded?), and which
//                                  candidates the Tier-1 two-signal rule left with one weak signal.
import type { NormalizedEvent } from '../modules/normalization/types'
import type { RawProviderEvent } from '../modules/providerFetchWindow/types'
import { groupEventsByTx, isSellShaped, outboundConfidence } from '../modules/sellTimeline/utils'
import { isBuyPaymentLeg, isQuoteAssetEvent } from './tradeLegRole'
import type { CandidateSelectionResult, CandidateTxEvidence, CompletionSignalName } from '../modules/receiptSwapDecoder/candidateSelector'

const SAMPLE_LIMIT = 25

export type OutboundNonSellReason =
  | 'chain_inactive'
  | 'buy_payment_leg'
  | 'no_inbound_in_tx'
  | 'inbound_same_token_only'

export type SellGapAuditInput = {
  wallet: string
  buys: number
  sells: number
  normalizedEvents: readonly NormalizedEvent[]
  activeChains: ReadonlySet<string>
  knownDexRouterAddresses: ReadonlySet<string>
  verifiedSwapTxKeys: ReadonlySet<string>
  providerResults: ReadonlyArray<{
    chain: string
    rawEvents: readonly RawProviderEvent[]
    alchemyNativeHistory?: { events: number; calls: number; failedCalls: number; moreAvailable: boolean; lastError?: string | null } | null
  }>
  persistedDrops: ReadonlyArray<{ chain: string; eventsDropped: ReadonlyArray<{ txHash: string; reason: string; fromAddress?: string; toAddress?: string; contract?: string; symbol?: string | null; originalProvider?: string }> }>
}

/** Same decision as sellTimeline's buildEntriesFromOutboundEvents, returning the reason instead. */
export function explainOutboundSellDecision(
  event: NormalizedEvent,
  sameTxEvents: readonly NormalizedEvent[],
  ctx: Pick<SellGapAuditInput, 'activeChains' | 'knownDexRouterAddresses' | 'verifiedSwapTxKeys'>,
): OutboundNonSellReason | 'sell' {
  if (!ctx.activeChains.has(event.chain)) return 'chain_inactive'
  if (isBuyPaymentLeg(event, sameTxEvents)) return 'buy_payment_leg'
  const receiptProvesSwap = ctx.verifiedSwapTxKeys.has(`${event.chain}:${event.txHash.toLowerCase()}`)
  const sameTxPaired = isSellShaped(event, [...sameTxEvents])
  const counterpartyIsKnownRouter = ctx.knownDexRouterAddresses.has(event.toAddress.toLowerCase())
  if (receiptProvesSwap || outboundConfidence(sameTxPaired, counterpartyIsKnownRouter)) return 'sell'
  return sameTxEvents.some((e) => e.direction === 'inbound') ? 'inbound_same_token_only' : 'no_inbound_in_tx'
}

export function buildSellGapAudit(input: SellGapAuditInput) {
  const wallet = input.wallet.toLowerCase()
  const byTx = groupEventsByTx([...input.normalizedEvents])
  const outbound = input.normalizedEvents.filter((e) => e.direction === 'outbound')
  const byReason: Record<string, number> = {}
  const samples: Array<Record<string, unknown>> = []
  let sellDecisions = 0
  for (const event of outbound) {
    const sameTx = byTx.get(event.txHash) ?? [event]
    const reason = explainOutboundSellDecision(event, sameTx, input)
    if (reason === 'sell') { sellDecisions += 1; continue }
    byReason[reason] = (byReason[reason] ?? 0) + 1
    if (samples.length < SAMPLE_LIMIT) {
      samples.push({
        chain: event.chain, txHash: event.txHash, symbol: event.symbol, contract: event.contract, amount: event.amount,
        counterparty: event.toAddress, reason, isQuoteAsset: isQuoteAssetEvent(event),
        counterpartyIsKnownRouter: input.knownDexRouterAddresses.has(event.toAddress.toLowerCase()),
        sameTxLegs: {
          inbound: sameTx.filter((e) => e.direction === 'inbound').map((e) => e.symbol),
          outbound: sameTx.filter((e) => e.direction === 'outbound').length,
          walletNotParty: sameTx.filter((e) => e.direction === 'unknown').length,
        },
      })
    }
  }

  const walletNotPartyFresh: Array<Record<string, unknown>> = []
  const walletNotPartyByProvider: Record<string, number> = {}
  for (const r of input.providerResults) {
    for (const e of r.rawEvents) {
      if ((e.fromAddress ?? '').toLowerCase() === wallet || (e.toAddress ?? '').toLowerCase() === wallet) continue
      const key = `${r.chain}:${e.provider}:${(e.contract ?? '').toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? 'native' : 'token'}`
      walletNotPartyByProvider[key] = (walletNotPartyByProvider[key] ?? 0) + 1
      if (walletNotPartyFresh.length < SAMPLE_LIMIT) {
        walletNotPartyFresh.push({ chain: r.chain, provider: e.provider, txHash: e.txHash, from: e.fromAddress, to: e.toAddress, contract: e.contract, symbol: e.symbol, amountRaw: e.amountRaw })
      }
    }
  }

  return {
    wallet,
    buys: input.buys,
    sells: input.sells,
    outboundEvents: outbound.length,
    outboundSellDecisions: sellDecisions,
    outboundNonSells: outbound.length - sellDecisions,
    outboundNonSellByReason: byReason,
    outboundNonSellSamples: samples,
    walletNotPartyFreshByProvider: walletNotPartyByProvider,
    walletNotPartyFreshSamples: walletNotPartyFresh,
    walletNotPartyPersistedDrops: input.persistedDrops.flatMap((d) => d.eventsDropped.filter((x) => x.reason === 'wallet_not_party').map((x) => ({ chain: d.chain, ...x }))).slice(0, SAMPLE_LIMIT),
    alchemyNativeHistoryByChain: Object.fromEntries(input.providerResults.map((r) => [r.chain, r.alchemyNativeHistory ?? null])),
  }
}

/** Logged when a wallet has buys but almost no sells (or WALLET_DEBUG=1). */
export function shouldLogSellGap(buys: number, sells: number): boolean {
  return process.env.WALLET_DEBUG === '1' || (buys > 0 && sells * 10 < buys)
}

export type ReceiptSelectorSellAuditInput = {
  evidence: readonly CandidateTxEvidence[]
  selection: CandidateSelectionResult
  strictSignalsByTx: ReadonlyMap<string, CompletionSignalName[]>
  fetchedTxHashes: ReadonlySet<string>
  exactSwapTxHashes: ReadonlySet<string>
  proofByTxHash: ReadonlyMap<string, string>
  receiptsFetched: number
}

const isOutboundExit = (e: CandidateTxEvidence) => e.isUnmatchedOutboundExit === true || (e.missingClosedLotSide === 'exit' && e.hasPriorBuyInventory === true)

export function buildReceiptSelectorSellAudit(input: ReceiptSelectorSellAuditInput) {
  const evidenceByChain: Record<string, { total: number; outboundExit: number; inboundOnly: number; paired: number }> = {}
  for (const e of input.evidence) {
    const row = (evidenceByChain[e.chain] ??= { total: 0, outboundExit: 0, inboundOnly: 0, paired: 0 })
    row.total += 1
    const hasIn = e.legs.some((l) => l.direction === 'inbound')
    const hasOut = e.legs.some((l) => l.direction === 'outbound')
    if (isOutboundExit(e)) row.outboundExit += 1
    if (hasIn && !hasOut) row.inboundOnly += 1
    if (hasIn && hasOut) row.paired += 1
  }

  const position = new Map(input.selection.selected.map((s, i) => [s.txHash.toLowerCase(), { index: i, tier: s.priorityTier, reason: s.priorityReason }]))
  const exitCandidates = input.evidence.filter((e) => e.chain === 'base' && isOutboundExit(e)).map((e) => {
    const tx = e.txHash.toLowerCase()
    const sel = position.get(tx)
    return {
      txHash: e.txHash,
      selectedPosition: sel?.index ?? null,
      tier: sel?.tier ?? null,
      priorityReason: sel?.reason ?? null,
      receiptFetched: input.fetchedTxHashes.has(tx),
      decodedExactSwap: input.exactSwapTxHashes.has(tx),
      receiptOutcome: input.proofByTxHash.get(tx) ?? null,
      routerOrCounterparty: e.routerOrCounterpartyAddress,
      strictSignals: input.strictSignalsByTx.get(tx) ?? [],
    }
  })

  const weak = input.evidence.filter((e) => e.chain === 'base' && e.missingClosedLotSide !== null && (input.strictSignalsByTx.get(e.txHash.toLowerCase())?.length ?? 0) === 1)
  return {
    selectorTransactionsConsidered: input.selection.selectorTransactionsConsidered,
    selectorReasonCounts: input.selection.selectorReasonCounts,
    evidenceByChain,
    receiptsFetched: input.receiptsFetched,
    selectedCount: input.selection.selected.length,
    baseOutboundExitCandidates: {
      total: exitCandidates.length,
      selected: exitCandidates.filter((c) => c.selectedPosition !== null).length,
      receiptFetched: exitCandidates.filter((c) => c.receiptFetched).length,
      decodedExactSwap: exitCandidates.filter((c) => c.decodedExactSwap).length,
      samples: exitCandidates.slice(0, SAMPLE_LIMIT),
    },
    tier1SingleWeakSignal: {
      total: weak.length,
      bySide: { entry: weak.filter((e) => e.missingClosedLotSide === 'entry').length, exit: weak.filter((e) => e.missingClosedLotSide === 'exit').length },
      // A weak-signal exit candidate is not lost if another path (prior inventory / one-sided outbound) still selected it.
      exitStillSelected: weak.filter((e) => e.missingClosedLotSide === 'exit' && position.has(e.txHash.toLowerCase())).length,
      exitNotSelected: weak.filter((e) => e.missingClosedLotSide === 'exit' && !position.has(e.txHash.toLowerCase())).map((e) => e.txHash).slice(0, SAMPLE_LIMIT),
    },
    tier1Diagnostics: input.selection.tier1Diagnostics,
  }
}
