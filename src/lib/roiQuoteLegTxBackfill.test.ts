// Tests for src/lib/roiQuoteLegTxBackfill.ts — targeted open/close-tx quote-leg recovery.
//
// Run with:
//   npx tsx --test src/lib/roiQuoteLegTxBackfill.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { NATIVE_ASSET_ADDRESS } from '../modules/providerFetchWindow/utils'
import { createPnlReconciliation } from './pnlReconciliation'
import {
  decodeWalletRelativeTransferLegs,
  lotsNeedingRoiQuoteLegTxBackfill,
  runRoiQuoteLegTxBackfill,
  type RoiQuoteLegTxReceiptLog,
} from './roiQuoteLegTxBackfill'
import {
  classifyVerifiedSampleRoiEligibility,
  persistRoiQuoteLegProofs,
  roiLotKey,
  ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION,
} from './verifiedSampleRoiEligibility'
import {
  buildManifestIdentity,
  isValidCanonicalPnlSampleManifest,
  readCanonicalPnlSampleManifest,
  writeCanonicalPnlSampleManifest,
  CANONICAL_LOT_IDENTITY_SCHEMA_VERSION,
  type CanonicalPnlSampleManifest,
  type CanonicalSampleManifestKvLike,
} from './canonicalPnlSampleManifest'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const WETH = '0x4200000000000000000000000000000000000006'
const EOA_A = '0x1111111111111111111111111111111111111111'
const EOA_B = '0x2222222222222222222222222222222222222222'
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const WETH_DEPOSIT_TOPIC0 = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'

function pad(addr: string): string {
  return `0x${'0'.repeat(24)}${addr.replace(/^0x/, '').toLowerCase()}`
}

function transferLog(address: string, from: string, to: string, amount = BigInt(1)): RoiQuoteLegTxReceiptLog {
  return {
    address,
    topics: [TRANSFER_TOPIC0, pad(from), pad(to)],
    data: `0x${amount.toString(16)}`,
  }
}

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot-1',
    token: TOKEN,
    chain: 'base',
    openedAt: 1,
    closedAt: 2,
    openedTxHash: '0xbuy',
    closedTxHash: '0xsell',
    amount: 1,
    costBasisUsd: 100,
    proceedsUsd: 80,
    realizedPnlUsd: -20,
    evidenceQuality: 'verified',
    ...overrides,
  }
}

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'alchemy',
    chain: 'base',
    txHash: '0xtx',
    timestamp: '2025-01-01T00:00:00.000Z',
    fromAddress: EOA_A,
    toAddress: WALLET,
    contract: USDC,
    symbol: 'USDC',
    amount: 1000,
    amountRaw: '1000000000',
    tokenDecimals: 6,
    direction: 'inbound',
    ...overrides,
  }
}

function jsonKv(): CanonicalSampleManifestKvLike {
  const raw = new Map<string, string>()
  return {
    get: async <T>(key: string) => (raw.has(key) ? JSON.parse(raw.get(key)!) as T : null),
    set: async (key: string, value: unknown) => { raw.set(key, JSON.stringify(value)); return 'OK' },
  }
}

function seedManifest(): { identity: ReturnType<typeof buildManifestIdentity>; manifest: CanonicalPnlSampleManifest } {
  const identity = buildManifestIdentity({
    walletAddress: WALLET,
    chains: ['base'],
    configuredWindowDays: 90,
    matchedLotFingerprint: 'fp-backfill',
  })
  const manifest = {
    ...identity,
    lotIdentitySchemaVersion: CANONICAL_LOT_IDENTITY_SCHEMA_VERSION,
    manifestVersion: 1,
    priorManifestVersion: null,
    verifiedLotIdentityKeys: ['k1'],
    verifiedLotRecords: [],
    acceptedEvidenceIdentityKeys: [],
    verifiedLotIdentityFingerprint: 'id-fp',
    acceptedHistoricalPriceFingerprint: 'price-fp',
    realizedPnlFingerprint: 'pnl-fp',
    scanFingerprint: 'scan-fp',
    realizedPnlUsd: -70794.97,
    verifiedLotCount: 1,
    structuralLotCount: 1,
    verifiedPricingCoverage: 1,
    createdAt: 1,
    refreshedAt: 1,
    refreshReason: null,
  } satisfies CanonicalPnlSampleManifest
  assert.equal(isValidCanonicalPnlSampleManifest(manifest, identity), true)
  return { identity, manifest }
}

describe('decodeWalletRelativeTransferLegs', () => {
  it('emits opposite-direction non-stable ERC20 legs from the same receipt, never by symbol', () => {
    const events = decodeWalletRelativeTransferLegs({
      chain: 'base',
      txHash: '0xswap',
      walletAddress: WALLET,
      logs: [
        transferLog(USDC, WALLET, EOA_A, BigInt(1000)),
        transferLog(TOKEN, EOA_A, WALLET, BigInt(50)),
      ],
    })
    const token = events.find((row) => row.contract.toLowerCase() === TOKEN)
    const usdc = events.find((row) => row.contract.toLowerCase() === USDC)
    assert.equal(token?.direction, 'inbound')
    assert.equal(usdc?.direction, 'outbound')
    assert.equal(token?.symbol, '', 'must not invent a token symbol')
  })

  it('treats a WETH deposit as a native outbound leg', () => {
    const events = decodeWalletRelativeTransferLegs({
      chain: 'base',
      txHash: '0xwrap',
      walletAddress: WALLET,
      logs: [{ address: WETH, topics: [WETH_DEPOSIT_TOPIC0, pad(WALLET)], data: '0x1' }],
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]?.contract, NATIVE_ASSET_ADDRESS)
    assert.equal(events[0]?.direction, 'outbound')
  })
})

describe('targeted ROI quote-leg tx backfill', () => {
  const openTx = '0xhistusdcopen00000000000000000000000000000000000000000000000001'
  const closeTx = '0xhistbuy000000000000000000000000000000000000000000000000000002'
  const historicalUsdc = lot({
    lotId: 'historical-usdc',
    token: USDC,
    openedTxHash: openTx,
    closedTxHash: closeTx,
    openedAt: 10,
    closedAt: 20,
    amount: 400,
    costBasisUsd: 400,
    proceedsUsd: 400,
    realizedPnlUsd: 0,
  })
  const publishedRisk = lot({
    lotId: 'live-risk',
    token: TOKEN,
    openedTxHash: '0xlivebuy',
    closedTxHash: '0xlivesell',
    openedAt: 100,
    closedAt: 110,
    amount: 50,
    costBasisUsd: 1000,
    proceedsUsd: 700,
    realizedPnlUsd: -300,
  })
  const boundedEvents: NormalizedEvent[] = [
    event({ txHash: openTx, contract: USDC, direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET, amount: 400 }),
    event({ txHash: closeTx, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B, amount: 400 }),
    event({ txHash: '0xlivebuy', contract: TOKEN, symbol: 'CLANKER', direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET }),
    event({ txHash: '0xlivesell', contract: TOKEN, symbol: 'CLANKER', direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B }),
  ]

  it('HARD ASSERTION: first/full-history-missing counterpart is recovered from the targeted open/close receipt and replayed with zero provider calls', async () => {
    const first = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      normalizedEvents: boundedEvents,
    })
    const usdcRow = first.classifications.find((row) => row.lotKey === roiLotKey(historicalUsdc))
    assert.equal(usdcRow?.roiDenominatorDisposition, 'include_economic_position')
    assert.equal(usdcRow?.reason, 'independent_eoa_cex_or_mint')
    assert.equal(lotsNeedingRoiQuoteLegTxBackfill(first.classifications).length, 1)

    const kv = jsonKv()
    const fetchTxReceipt = async (chain: 'base' | 'eth' | 'arbitrum' | 'hyperevm', txHash: string) => {
      assert.equal(chain, 'base')
      if (txHash === openTx) {
        return { logs: [transferLog(USDC, EOA_A, WALLET, BigInt(400)), transferLog(TOKEN, WALLET, EOA_A, BigInt(12))] }
      }
      if (txHash === closeTx) {
        return { logs: [transferLog(USDC, WALLET, EOA_B, BigInt(400)), transferLog(TOKEN, EOA_B, WALLET, BigInt(12))] }
      }
      return null
    }

    const backfill = await runRoiQuoteLegTxBackfill({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      classifications: first.classifications,
      normalizedEvents: boundedEvents,
      walletAddress: WALLET,
      fetchTxReceipt,
      cacheKv: kv,
    })
    assert.equal(backfill.audit.lotsNeedingProof, 1)
    assert.equal(backfill.audit.uniqueTxsNeeded, 2)
    assert.equal(backfill.audit.providerCalls, 2)
    assert.equal(backfill.audit.quoteProofsRecovered, 1)
    assert.equal(backfill.audit.independentProofsRecovered, 0)
    assert.equal(backfill.audit.unresolvedAfterBackfill, 0)
    assert.equal(backfill.audit.capped, false)
    assert.equal(backfill.proofs[0]?.proofType, 'targeted_tx_backfill')
    assert.equal(backfill.proofs[0]?.disposition, 'exclude_quote_cash_leg')
    assert.ok(backfill.proofs[0]?.pairedTxHash === openTx || backfill.proofs[0]?.pairedTxHash === closeTx)
    assert.equal(backfill.proofs[0]?.pairedRiskToken, TOKEN)
    assert.equal(backfill.proofs[0]?.methodologyVersion, ROI_QUOTE_LEG_PROOF_METHODOLOGY_VERSION)

    const { identity, manifest } = seedManifest()
    await writeCanonicalPnlSampleManifest(kv, manifest)
    const fingerprints = {
      id: manifest.verifiedLotIdentityFingerprint,
      price: manifest.acceptedHistoricalPriceFingerprint,
      pnl: manifest.realizedPnlFingerprint,
      realized: manifest.realizedPnlUsd,
    }
    await persistRoiQuoteLegProofs(kv, identity, backfill.proofs)
    const stored = await readCanonicalPnlSampleManifest(kv, identity)
    assert.equal(stored.manifest?.verifiedLotIdentityFingerprint, fingerprints.id)
    assert.equal(stored.manifest?.acceptedHistoricalPriceFingerprint, fingerprints.price)
    assert.equal(stored.manifest?.realizedPnlFingerprint, fingerprints.pnl)
    assert.equal(stored.manifest?.realizedPnlUsd, fingerprints.realized)

    const secondCalls: string[] = []
    const second = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      normalizedEvents: boundedEvents,
      persistedProofs: stored.manifest?.roiQuoteLegProofs,
    })
    const replayed = second.classifications.find((row) => row.lotKey === roiLotKey(historicalUsdc))
    assert.equal(replayed?.roiDenominatorDisposition, 'exclude_quote_cash_leg')
    assert.equal(replayed?.reason, 'persisted_quote_cash')
    assert.equal(second.quoteCashLegLots.length, 1)
    assert.equal(second.unresolvedLots.length, 0)
    assert.equal(second.verifiedSampleRoiEligibleLots.length, 1)
    assert.equal(second.roiAvailable, true)

    const replayBackfill = await runRoiQuoteLegTxBackfill({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      classifications: second.classifications,
      normalizedEvents: boundedEvents,
      persistedProofs: stored.manifest?.roiQuoteLegProofs,
      walletAddress: WALLET,
      fetchTxReceipt: async (_chain, txHash) => {
        secondCalls.push(txHash)
        return null
      },
      cacheKv: kv,
    })
    assert.equal(replayBackfill.audit.lotsNeedingProof, 0)
    assert.equal(replayBackfill.audit.providerCalls, 0)
    assert.equal(secondCalls.length, 0, 'replayed persisted proof must not fetch receipts')
  })

  it('HARD ASSERTION: failed/timeout/capped lookup stays unresolved, never independent', async () => {
    const first = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      normalizedEvents: boundedEvents,
    })
    const backfill = await runRoiQuoteLegTxBackfill({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      classifications: first.classifications,
      normalizedEvents: boundedEvents,
      walletAddress: WALLET,
      fetchTxReceipt: async () => null,
    })
    assert.equal(backfill.audit.quoteProofsRecovered, 0)
    assert.equal(backfill.proofs.length, 0)
    assert.ok(backfill.unconfirmedLotKeys.includes(roiLotKey(historicalUsdc)))

    const forced = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      normalizedEvents: boundedEvents,
      forceUnresolvedLotKeys: backfill.unconfirmedLotKeys,
    })
    const usdcRow = forced.classifications.find((row) => row.lotKey === roiLotKey(historicalUsdc))
    assert.equal(usdcRow?.roiDenominatorDisposition, 'unresolved')
    assert.equal(usdcRow?.reason, 'unresolved_targeted_tx_backfill_unconfirmed')
    assert.equal(forced.roiAvailable, false)
  })

  it('confirms genuine EOA/CEX independent stables and persists that proof', async () => {
    const independentOpen = '0xeoain000000000000000000000000000000000000000000000000000000001'
    const independentClose = '0xeoaout00000000000000000000000000000000000000000000000000000002'
    const independent = lot({
      lotId: 'usdc-eoa',
      token: USDC,
      openedTxHash: independentOpen,
      closedTxHash: independentClose,
      openedAt: 1,
      closedAt: 2,
      amount: 5000,
      costBasisUsd: 5000,
      proceedsUsd: 5000,
      realizedPnlUsd: 0,
    })
    const events: NormalizedEvent[] = [
      event({ txHash: independentOpen, contract: USDC, direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET, amount: 5000 }),
      event({ txHash: independentClose, contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_B, amount: 5000 }),
    ]
    const first = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [independent],
      normalizedEvents: events,
    })
    const backfill = await runRoiQuoteLegTxBackfill({
      verifiedLots: [independent],
      classifications: first.classifications,
      normalizedEvents: events,
      walletAddress: WALLET,
      fetchTxReceipt: async (_chain, txHash) => {
        if (txHash === independentOpen) return { logs: [transferLog(USDC, EOA_A, WALLET, BigInt(5000))] }
        return { logs: [transferLog(USDC, WALLET, EOA_B, BigInt(5000))] }
      },
    })
    assert.equal(backfill.audit.independentProofsRecovered, 1)
    assert.equal(backfill.proofs[0]?.disposition, 'include_economic_position')
    assert.equal(backfill.proofs[0]?.proofType, 'targeted_tx_backfill')
  })

  it('caps unique provider calls and leaves unfetched lots unresolved', async () => {
    const first = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      normalizedEvents: boundedEvents,
    })
    const backfill = await runRoiQuoteLegTxBackfill({
      verifiedLots: [publishedRisk, historicalUsdc],
      structuralLots: [publishedRisk, historicalUsdc],
      classifications: first.classifications,
      normalizedEvents: boundedEvents,
      walletAddress: WALLET,
      maxProviderCalls: 1,
      fetchTxReceipt: async (_chain, txHash) => {
        if (txHash === openTx) return { logs: [transferLog(USDC, EOA_A, WALLET), transferLog(TOKEN, WALLET, EOA_A)] }
        if (txHash === closeTx) return { logs: [transferLog(USDC, WALLET, EOA_B), transferLog(TOKEN, EOA_B, WALLET)] }
        return null
      },
    })
    assert.equal(backfill.audit.capped, true)
    assert.equal(backfill.audit.uniqueTxsNeeded, 2)
    assert.ok(backfill.audit.providerCalls <= 1)
    assert.equal(backfill.unconfirmedLotKeys.length, 1)
  })

  it('does not fetch txs for lots already proven live or persisted', async () => {
    const quoteUsdc = lot({
      lotId: 'usdc-fifo',
      token: USDC,
      openedTxHash: '0xhistopen',
      closedTxHash: '0xlivebuy',
      openedAt: 10,
      closedAt: 100,
      amount: 1000,
      costBasisUsd: 1000,
      proceedsUsd: 1000,
      realizedPnlUsd: 0,
    })
    const risk = lot({
      lotId: 'token',
      token: TOKEN,
      openedTxHash: '0xlivebuy',
      closedTxHash: '0xlivesell',
      costBasisUsd: 1000,
      proceedsUsd: 700,
      realizedPnlUsd: -300,
    })
    const first = classifyVerifiedSampleRoiEligibility({
      verifiedLots: [risk, quoteUsdc],
      structuralLots: [risk, quoteUsdc],
      normalizedEvents: [
        event({ txHash: '0xlivebuy', contract: USDC, direction: 'outbound', fromAddress: WALLET, toAddress: EOA_A }),
        event({ txHash: '0xlivebuy', contract: TOKEN, direction: 'inbound', fromAddress: EOA_A, toAddress: WALLET }),
      ],
    })
    let calls = 0
    const backfill = await runRoiQuoteLegTxBackfill({
      verifiedLots: [risk, quoteUsdc],
      structuralLots: [risk, quoteUsdc],
      classifications: first.classifications,
      walletAddress: WALLET,
      fetchTxReceipt: async () => { calls += 1; return null },
    })
    assert.equal(first.quoteCashLegLots.length, 1)
    assert.equal(backfill.audit.lotsNeedingProof, 0)
    assert.equal(calls, 0)
  })

  it('HARD ASSERTION: production reconcile recovers the quote from targeted txs, persists, and bounded replay uses zero provider calls', async () => {
    const fifoEngineResult: FifoOutput = {
      matchedLots: [publishedRisk, historicalUsdc],
      unmatchedBuys: 0,
      unmatchedSells: 0,
      unmatchedBuyEvents: [],
      unmatchedSellEvents: [],
      realizedPnlUsd: -300,
      unrealizedPnlUsd: 0,
      costBasisUsd: 1400,
      publicPnlStatus: 'unavailable',
      integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
      unrealizedPnlExcludedTokens: [],
      unrealizedReconciliation: emptyUnrealizedReconciliation(),
    }
    const pnlEngineResult = {
      realizedPnlUsd: -300,
      closedLots: [],
      winLossRate: { wins: 0, losses: 1, evaluated: 1, rate: 0 },
      chainBreakdown: [],
      confidenceBasis: { high: 2, medium: 0, low: 0, aggregate: 'high' as const },
      evidenceMissingCount: 0,
    }
    let firstCalls = 0
    const kv = jsonKv()
    const first = createPnlReconciliation({
      logger: { warn() { /* silent */ } },
      roiQuoteLegTxBackfill: {
        walletAddress: WALLET,
        cacheKv: kv,
        fetchTxReceipt: async (_chain, txHash) => {
          firstCalls += 1
          if (txHash === openTx) return { logs: [transferLog(USDC, EOA_A, WALLET), transferLog(TOKEN, WALLET, EOA_A)] }
          if (txHash === closeTx) return { logs: [transferLog(USDC, WALLET, EOA_B), transferLog(TOKEN, EOA_B, WALLET)] }
          return null
        },
      },
    })
    const firstSummary = await first.reconcile({
      fifoEngineResult,
      pnlEngineResult,
      normalizedEvents: boundedEvents,
    })
    assert.equal(firstSummary.verifiedSamplePerformance.quoteCashLegExcludedLotCount, 1)
    assert.equal(firstSummary.verifiedSamplePerformance.unresolvedQuoteLegLotCount, 0)
    assert.equal(firstSummary.verifiedSamplePerformance.verifiedSampleRoiEligibleLotCount, 1)
    assert.equal(firstSummary.verifiedSamplePerformance.realizedPnlUsd, -300)
    assert.ok(firstCalls > 0)
    assert.equal(firstSummary.roiQuoteLegTxBackfillAudit?.quoteProofsRecovered, 1)
    const quoteProof = (firstSummary.roiQuoteLegProofsToPersist ?? []).find((row) => row.stableLotKey === roiLotKey(historicalUsdc))
    assert.equal(quoteProof?.proofType, 'targeted_tx_backfill')

    const { identity, manifest } = seedManifest()
    await writeCanonicalPnlSampleManifest(kv, manifest)
    await persistRoiQuoteLegProofs(kv, identity, firstSummary.roiQuoteLegProofsToPersist ?? [])
    const stored = await readCanonicalPnlSampleManifest(kv, identity)
    let secondCalls = 0
    const second = createPnlReconciliation({
      logger: { warn() { /* silent */ } },
      roiQuoteLegTxBackfill: {
        walletAddress: WALLET,
        cacheKv: kv,
        fetchTxReceipt: async () => { secondCalls += 1; return null },
      },
    })
    const secondSummary = await second.reconcile({
      fifoEngineResult,
      pnlEngineResult,
      normalizedEvents: boundedEvents,
      canonicalSampleSelector: async (lots) => ({
        publishedLots: [...lots],
        forcePublicPnlUnavailable: false,
        roiQuoteLegProofs: stored.manifest?.roiQuoteLegProofs,
      }),
    })
    assert.equal(secondSummary.verifiedSamplePerformance.quoteCashLegExcludedLotCount, 1)
    assert.equal(secondSummary.verifiedSamplePerformance.unresolvedQuoteLegLotCount, 0)
    assert.equal(secondSummary.verifiedSamplePerformance.verifiedSampleRoiEligibleLotCount, 1)
    assert.equal(secondSummary.verifiedSamplePerformance.realizedPnlUsd, firstSummary.verifiedSamplePerformance.realizedPnlUsd)
    assert.equal(secondCalls, 0)
    assert.equal(secondSummary.roiQuoteLegTxBackfillAudit?.providerCalls, 0)
    assert.equal(secondSummary.roiQuoteLegTxBackfillAudit?.lotsNeedingProof, 0)
  })
})
