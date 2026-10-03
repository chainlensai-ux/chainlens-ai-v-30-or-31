// 13-closed-lot regression fixture for the Wallet Scanner historical-price completion audit.
// Shape mirrors the production scan: 13 closed lots, 4 verified (accepted evidence), 9 `missing_price`.
// Every quote leg is a real same-tx leg with an exact canonical address — nothing is inferred from a
// symbol and no current price is ever used. Shared by the regression test and by ad-hoc measurement.

import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { isCanonicalVerifiedPublishedLot } from '../lib/canonicalVerifiedLot'
import { lotIdentityVersion, buildAcceptedEvidenceEnvelope, writeAcceptedEvidence, type AcceptedEvidenceKvLike } from '../lib/acceptedEvidenceStore.ts'
import { __resetNativePriceResolverForTest, __seedAcceptedNativePriceForTest } from '../modules/nativePriceResolver/index.ts'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const WETH_BASE = '0x4200000000000000000000000000000000000006'
export const ETH_USD_DAY1 = 3000
export const ETH_USD_DAY2 = 3300
const DAY1 = '2026-03-01T12:00:00.000Z'
const DAY2 = '2026-03-02T12:00:00.000Z'

const tokenOf = (i: number) => `0x${(0xa000 + i).toString(16).padStart(40, '0')}`
const HOP = `0x${'b'.repeat(40)}` // a real intermediate hop token (no USD evidence of its own)
const FAKE_WETH = `0x${'c'.repeat(40)}` // a non-canonical token whose SYMBOL is "WETH"

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  const v: NormalizedEvent = {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: DAY1,
    fromAddress: '0xwallet', toAddress: '0xrouter', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '', tokenDecimals: 18, direction: 'inbound', ...o,
  }
  if (o.amountRaw === undefined) v.amountRaw = BigInt(Math.round(v.amount * 1e6)).toString() + '0'.repeat(v.tokenDecimals - 6)
  return v
}
const usdc = (tx: string, amount: number, ts: string) => ev({ txHash: tx, contract: USDC_BASE, symbol: 'USDC', tokenDecimals: 6, amount, amountRaw: String(Math.round(amount * 1e6)), direction: 'unknown', timestamp: ts, fromAddress: '0xrouter', toAddress: '0xpool' })
const weth = (tx: string, amount: number, ts: string) => ev({ txHash: tx, contract: WETH_BASE, symbol: 'WETH', amount, direction: 'unknown', timestamp: ts, fromAddress: '0xrouter', toAddress: '0xpool' })
const hop = (tx: string, amount: number, ts: string) => ev({ txHash: tx, contract: HOP, symbol: 'HOP', amount, direction: 'unknown', timestamp: ts, fromAddress: '0xpoolA', toAddress: '0xpoolB' })

export type FixtureLotKind =
  | 'accepted_evidence'
  | 'native_quote_behind_hop_leg'
  | 'transfer_in_entry'
  | 'token_to_token_only'
  | 'symbol_only_weth_entry'
  | 'out_of_bounds_derived_price'

export const FIXTURE_LOT_KINDS: FixtureLotKind[] = [
  'accepted_evidence', 'accepted_evidence', 'accepted_evidence', 'accepted_evidence',
  'native_quote_behind_hop_leg', 'native_quote_behind_hop_leg', 'native_quote_behind_hop_leg',
  'transfer_in_entry', 'transfer_in_entry',
  'token_to_token_only', 'token_to_token_only',
  'symbol_only_weth_entry',
  'out_of_bounds_derived_price',
]

export function buildFixtureEvents(): { events: NormalizedEvent[]; lots: Array<{ kind: FixtureLotKind; buy: NormalizedEvent; sell: NormalizedEvent }> } {
  const events: NormalizedEvent[] = []
  const lots: Array<{ kind: FixtureLotKind; buy: NormalizedEvent; sell: NormalizedEvent }> = []
  FIXTURE_LOT_KINDS.forEach((kind, index) => {
    const i = index + 1
    const token = tokenOf(i)
    const buyTx = `0xbuy${i}`
    const sellTx = `0xsell${i}`
    const buy = ev({ txHash: buyTx, contract: token, symbol: `T${i}`, amount: 1000, direction: 'inbound', timestamp: DAY1, fromAddress: '0xpool', toAddress: '0xwallet' })
    const sell = ev({ txHash: sellTx, contract: token, symbol: `T${i}`, amount: 1000, direction: 'outbound', timestamp: DAY2, fromAddress: '0xwallet', toAddress: '0xpool' })
    events.push(buy, sell)
    switch (kind) {
      case 'accepted_evidence':
        events.push(usdc(buyTx, 100, DAY1), usdc(sellTx, 150, DAY2))
        break
      case 'native_quote_behind_hop_leg':
        // Multi-hop route: TOKEN <-> HOP <-> WETH. The HOP leg is logged before the WETH leg.
        events.push(hop(buyTx, 50, DAY1), weth(buyTx, 0.1, DAY1), hop(sellTx, 60, DAY2), weth(sellTx, 0.12, DAY2))
        break
      case 'transfer_in_entry':
        // Entry is a plain transfer from another wallet: no quote leg exists in that transaction.
        buy.fromAddress = '0xfriend'
        events.push(usdc(sellTx, 80, DAY2))
        break
      case 'token_to_token_only':
        events.push(hop(buyTx, 40, DAY1), hop(sellTx, 45, DAY2))
        break
      case 'symbol_only_weth_entry':
        events.push(ev({ txHash: buyTx, contract: FAKE_WETH, symbol: 'WETH', amount: 5, direction: 'unknown', timestamp: DAY1, fromAddress: '0xrouter', toAddress: '0xpool' }))
        break
      case 'out_of_bounds_derived_price':
        buy.amount = 0.0000001
        buy.amountRaw = '100000000000'
        sell.amount = 0.0000001
        sell.amountRaw = '100000000000'
        events.push(usdc(buyTx, 500, DAY1), usdc(sellTx, 600, DAY2))
        break
    }
    lots.push({ kind, buy, sell })
  })
  // Unrelated open positions (never sold) with real same-tx quotes: these resolve requirements but
  // can never complete a closed lot.
  for (let j = 0; j < 6; j++) {
    const tx = `0xopen${j}`
    events.push(ev({ txHash: tx, contract: tokenOf(100 + j), symbol: `O${j}`, amount: 10, direction: 'inbound', timestamp: DAY1 }), weth(tx, 0.05, DAY1))
  }
  return { events, lots }
}

export function fakeAcceptedEvidenceKv(): AcceptedEvidenceKvLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

export async function seedAcceptedEvidenceForVerifiedLots(kv: AcceptedEvidenceKvLike, lots: ReturnType<typeof buildFixtureEvents>['lots'], now: number, onlySide?: 'entry' | 'exit', kinds: FixtureLotKind[] = ['accepted_evidence']): Promise<void> {
  for (const { kind, buy, sell } of lots) {
    if (!kinds.includes(kind)) continue
    const version = lotIdentityVersion({ chain: buy.chain, token: buy.contract, openedTxHash: buy.txHash, closedTxHash: sell.txHash, openedAt: Date.parse(buy.timestamp), closedAt: Date.parse(sell.timestamp), amount: buy.amount })
    for (const side of ['entry', 'exit'] as const) {
      if (onlySide && side !== onlySide) continue
      const e = side === 'entry' ? buy : sell
      const identity = { chain: e.chain, token: e.contract, txHash: e.txHash, side, timestamp: Date.parse(e.timestamp), lotIdentityVersion: version }
      const value = side === 'entry' ? 100 : 150
      // The production writer, so the test also proves writer and fast-path reader agree on the key.
      await writeAcceptedEvidence(kv, buildAcceptedEvidenceEnvelope({ identity, priceUsd: value, valueUsd: value, source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now }))
    }
  }
}

export type FixtureRun = Awaited<ReturnType<typeof runHistoricalCompletionFixture>>

export async function runHistoricalCompletionFixture(options: { seed?: (kv: AcceptedEvidenceKvLike, lots: ReturnType<typeof buildFixtureEvents>['lots'], now: number) => Promise<void> } = {}) {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(Date.parse(DAY1), ETH_USD_DAY1, 'coingecko_native_coin_history')
  __seedAcceptedNativePriceForTest(Date.parse(DAY2), ETH_USD_DAY2, 'coingecko_native_coin_history')
  const { events, lots } = buildFixtureEvents()
  const kv = fakeAcceptedEvidenceKv()
  const now = Date.parse('2026-03-05T00:00:00.000Z')
  await seedAcceptedEvidenceForVerifiedLots(kv, lots, now)
  if (options.seed) await options.seed(kv, lots, now)
  let externalHistoricalCalls = 0
  // No external historical provider knows any of these tokens — every price must come from real
  // same-tx evidence or accepted evidence.
  const nullSource: PriceSourceFn = () => { externalHistoricalCalls += 1; return null }
  const warnings: Array<{ tag: string; payload: unknown }> = []
  const originalWarn = console.warn
  console.warn = (tag: unknown, payload?: unknown) => { warnings.push({ tag: String(tag), payload }) }
  const priorPaprika = process.env.COINPAPRIKA_HISTORICAL_ENABLED
  process.env.COINPAPRIKA_HISTORICAL_ENABLED = 'false'
  let lookups
  try {
    lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: { primary: nullSource, fallback: nullSource }, acceptedEvidenceKv: kv, now: () => now })
  } finally {
    console.warn = originalWarn
    if (priorPaprika === undefined) delete process.env.COINPAPRIKA_HISTORICAL_ENABLED
    else process.env.COINPAPRIKA_HISTORICAL_ENABLED = priorPaprika
  }
  const sells = events.filter((e) => e.direction === 'outbound')
  const { matchedLots } = matchLotsFIFO(buildLots(events, [], lookups.priceUsdLookup), sells, lookups.priceUsdLookup)
  const verifiedLots = matchedLots.filter((l) => isCanonicalVerifiedPublishedLot(l))
  const find = (tag: string) => warnings.find((w) => w.tag === tag)?.payload as Record<string, unknown> | undefined
  const coverage = find('[historical-quote-leg-coverage]') ?? {}
  const lostCoverage = find('[accepted-evidence-lost-coverage]')
  return {
    lots,
    lookups,
    matchedLots,
    closedLots: matchedLots.length,
    verifiedLots: verifiedLots.length,
    verifiedTokens: new Set(verifiedLots.map((l) => l.token.toLowerCase())),
    coveragePct: Math.round((verifiedLots.length / matchedLots.length) * 10000) / 100,
    sameTxRequirementsResolved: coverage.requirementsSatisfiedBySameTxQuote as number,
    lotsCompletedBySameTxQuote: coverage.actualLotsCompletedByQuote as number,
    rejectionReasonCounts: coverage.rejectionReasonCounts as Record<string, number>,
    externalHistoricalCalls,
    acceptedEvidenceReused: lookups.acceptedEvidenceSkipAudit.pricingRequirementsRemovedByAcceptedEvidence,
    acceptedEvidenceMissingSides: lookups.manifestFastPathAudit.lostCoverageSides.length,
    lostCoverage,
    warnings,
  }
}
