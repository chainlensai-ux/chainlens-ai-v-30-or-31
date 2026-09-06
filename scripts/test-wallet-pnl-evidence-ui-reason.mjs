// WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED — tests that buildWalletPnlViewModel's combined-
// unavailable reason text uses the real walletPnlEvidenceAudit.failureReason (e.g. "Open position
// only — no verified closed trades.", "No verified swaps found.", "Swap found, quote leg missing.")
// instead of the old generic "PnL unavailable due to missing evidence" — per this task's explicit
// UI requirement ("Do not just say 'missing evidence.'"). Never changes combinedStatus itself
// (still officialPnlStatus-gated) — additive reason text only, and only while combinedStatus is
// already 'unavailable'.
//
// Wallet PnL publish Item 1: V2 closedLots:0 failureReason is diagnostic-only. When canonical
// recon/publicPnlGateAudit has real closed lots, official headline/sidebar copy comes from that
// gate (verified/structural coverage, unmatched, missing evidence) — never the V2 "no verified
// closed lot could be built" line. Combined status stays canonical (unavailable if gates fail).
import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`  FAIL: ${label}`) }
}

const {
  buildWalletPnlViewModel,
  buildOfficialUnavailableReason,
  isV2ZeroLotUnavailableCopy,
  resolveOfficialUnrealizedBoxStatus,
} = await import('../app/frontend/lib/buildWalletPnlViewModel.ts')
const { PNL_UNAVAILABLE_MESSAGE, GUARDRAIL_ABS_LIMIT } = await import('../app/frontend/components/PnlStatusCard.tsx')

const viewModelSrc = fs.readFileSync(new URL('../app/frontend/lib/buildWalletPnlViewModel.ts', import.meta.url), 'utf8')

function emptyPnlV2() {
  return { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [] }
}

function audit(overrides = {}) {
  return {
    walletAddress: '0xwallet', chainId: 8453, rawEvents: 3, transferEvents: 3, candidateSwapTxs: 0,
    receiptsFetched: 0, verifiedSwapCount: 0, likelySwapCount: 0, rejectedSwapCount: 0, rejectionReasons: {},
    oneLegTxCount: 0, quoteLegsRecovered: 0, nativeQuoteLegsRecovered: 0, stableQuoteLegsRecovered: 0,
    buysClassified: 0, sellsClassified: 0, openPositions: 0, closedLots: 0, fullyPricedClosedLots: 0,
    realizedPnlUsd: null, finalPnlStatus: 'unavailable', failureReason: null,
    ...overrides,
  }
}

const V2_ZERO_LOT_REASON = 'Sell activity was found but did not match any earlier buy in this wallet\'s recorded history — no verified closed lot could be built.'

function canonicalUnavailableRecon(overrides = {}) {
  const auditOverrides = overrides.publicPnlGateAudit ?? {}
  const rest = { ...overrides }
  delete rest.publicPnlGateAudit
  return {
    closedLots: 586,
    unmatchedBuys: 88,
    unmatchedSells: 184,
    realizedPnlUsd: 11354.01,
    unrealizedPnlUsd: -68.96,
    missingEvidenceCount: 344,
    publicPnlStatus: 'unavailable',
    publicPnlGateAudit: {
      verifiedLotCount: 242,
      fullyPricedLotCount: 242,
      pricingCoverage: 0.413,
      structuralCoverage: 1,
      unmatchedBuyCount: 88,
      unmatchedSellCount: 184,
      integrityTier: 'blocked',
      blockingReasons: [
        { rule: 'minimum_verified_pricing_coverage', threshold: '0.5', actualValue: '0.413' },
        { rule: 'unmatched_sells', threshold: '0', actualValue: '184' },
        { rule: 'unmatched_buys', threshold: '0', actualValue: '88' },
        { rule: 'missing_evidence_count', threshold: '0', actualValue: '344' },
      ],
      verifiedClosedLots: 242,
      structuralClosedLots: 586,
      verifiedPricingCoverage: 0.413,
      boundedSampleEligible: false,
      boundedSampleBlockingReasons: [
        { rule: 'minimum_verified_pricing_coverage', threshold: '0.5', actualValue: '0.413' },
      ],
      fullAvailabilityBlockingReasons: [
        { rule: 'minimum_verified_pricing_coverage', threshold: '0.5', actualValue: '0.413' },
        { rule: 'unmatched_sells', threshold: '0', actualValue: '184' },
        { rule: 'unmatched_buys', threshold: '0', actualValue: '88' },
        { rule: 'missing_evidence_count', threshold: '0', actualValue: '344' },
      ],
      ...auditOverrides,
    },
    ...rest,
  }
}

// 1. No audit at all -> unchanged legacy generic message (backward compatible, nothing fabricated).
{
  const vm = buildWalletPnlViewModel({ pnlV2: emptyPnlV2(), publicPnlStatus: 'unavailable' })
  check('no audit -> falls back to the generic PNL_UNAVAILABLE_MESSAGE', vm.combinedReason === PNL_UNAVAILABLE_MESSAGE)
}

// 2. Open-position-only audit -> the specific reason replaces the generic message.
{
  const vm = buildWalletPnlViewModel({
    pnlV2: emptyPnlV2(), publicPnlStatus: 'unavailable',
    walletPnlEvidenceAudit: audit({ buysClassified: 3, openPositions: 3, finalPnlStatus: 'open_position_only', failureReason: 'Open position only — no verified closed trades.' }),
  })
  check('open_position_only failureReason replaces the generic message', vm.combinedReason === 'Open position only — no verified closed trades.')
  check('never silently reverts to the old generic wording once a real reason exists', vm.combinedReason !== PNL_UNAVAILABLE_MESSAGE)
}

// 3. Transfer-only (no swaps decoded at all) -> "No verified swaps found."
{
  const vm = buildWalletPnlViewModel({
    pnlV2: emptyPnlV2(), publicPnlStatus: 'unavailable',
    walletPnlEvidenceAudit: audit({ finalPnlStatus: 'transfer_only', failureReason: 'No verified swaps were found for this wallet.' }),
  })
  check('transfer_only failureReason surfaces "No verified swaps" wording', /No verified swaps/.test(vm.combinedReason))
}

// 4. Quote leg missing -> real reason text, not the bare generic wording.
{
  const vm = buildWalletPnlViewModel({
    pnlV2: emptyPnlV2(), publicPnlStatus: 'unavailable',
    walletPnlEvidenceAudit: audit({ oneLegTxCount: 4, quoteLegsRecovered: 0, failureReason: 'Swap found, quote leg missing.' }),
  })
  check('quote-leg-missing failureReason surfaces verbatim', vm.combinedReason === 'Swap found, quote leg missing.')
}

// 5. walletPnlEvidenceAudit is reason-text-only — it never changes combinedStatus itself. Same
//    pnlV2/publicPnlStatus with vs. without an audit must yield the exact same combinedStatus
//    (officialPnlStatus/pnlV2 stay the sole authority for verified/partial/unavailable, per this
//    file's own "NO NEW PNL MATH" rule).
{
  const params = { pnlV2: emptyPnlV2(), publicPnlStatus: 'limited_verified_sample' }
  const without = buildWalletPnlViewModel(params)
  const withAudit = buildWalletPnlViewModel({ ...params, walletPnlEvidenceAudit: audit({ failureReason: 'Swap found, quote leg missing.' }) })
  check('walletPnlEvidenceAudit never changes combinedStatus (reason-text-only)', without.combinedStatus === withAudit.combinedStatus)
}

// 6. Item 1 — canonical recon with closed lots MUST override V2's zero-lot failureReason.
{
  const v2Audit = audit({
    sellsClassified: 12,
    closedLots: 0,
    fullyPricedClosedLots: 0,
    realizedPnlUsd: null,
    finalPnlStatus: 'unavailable',
    failureReason: V2_ZERO_LOT_REASON,
  })
  const recon = canonicalUnavailableRecon()
  const vm = buildWalletPnlViewModel({
    pnlV2: emptyPnlV2(),
    publicPnlStatus: 'unavailable',
    reconciliationSummary: recon,
    walletPnlEvidenceAudit: v2Audit,
  })
  check('Item 1: combinedStatus stays unavailable (gates not lowered)', vm.combinedStatus === 'unavailable')
  check('Item 1: combinedReason does not use V2 zero-lot copy', !isV2ZeroLotUnavailableCopy(vm.combinedReason))
  check('Item 1: combinedReason does not say no verified closed lot could be built', !/no verified closed lot/i.test(vm.combinedReason))
  check('Item 1: combinedReason reports 242 of 586 closed lots', /242 of 586 closed lots verified/.test(vm.combinedReason))
  check('Item 1: combinedReason reports 41.3% coverage', /41\.3% coverage/.test(vm.combinedReason))
  check('Item 1: combinedReason names the 50% pricing-coverage gate', /below the 50% gate/.test(vm.combinedReason))
  check('Item 1: combinedReason names unmatched sells', /184 unmatched sells/.test(vm.combinedReason))
  check('Item 1: combinedReason names unmatched buys', /88 unmatched buys/.test(vm.combinedReason))
  check('Item 1: combinedReason names missing evidence', /Missing evidence on 344 lot sides/.test(vm.combinedReason))
  check('Item 1: combined realized box uses the same official copy', vm.combinedRealizedBox.reason === vm.combinedReason)
  check('Item 1: combined realized box stays Unavailable (no invented sample)', vm.combinedRealizedBox.status === 'Unavailable')
  check('Item 1: combined realized box has no dollar figure', vm.combinedRealizedBox.value === null)
}

// 7. Item 1 — helper: V2 reason still used when canonical recon has ZERO closed lots.
{
  const reason = buildOfficialUnavailableReason({
    reconciliationSummary: canonicalUnavailableRecon({
      publicPnlGateAudit: { verifiedClosedLots: 0, structuralClosedLots: 0, verifiedPricingCoverage: null, unmatchedBuyCount: 0, unmatchedSellCount: 0 },
    }),
    walletPnlEvidenceAudit: audit({ failureReason: V2_ZERO_LOT_REASON }),
  })
  check('Item 1: V2 zero-lot copy is allowed only when canonical has zero closed lots', reason === V2_ZERO_LOT_REASON)
}

// 8. Source: never assign unavailable copy from V2 failureReason without the canonical gate.
{
  check(
    'Item 1 source: unavailable copy goes through buildOfficialUnavailableReason, not raw V2 failureReason',
    viewModelSrc.includes('buildOfficialUnavailableReason({ reconciliationSummary, walletPnlEvidenceAudit })')
      && !viewModelSrc.includes('walletPnlEvidenceAudit?.failureReason ?? PNL_UNAVAILABLE_MESSAGE'),
  )
}

function failedOfficialUnrealized(overrides = {}) {
  return {
    totalOpenPositions: 117,
    reconciledOpenPositions: 1,
    excludedOpenPositions: 116,
    cappedOpenPositions: 1,
    excludedCandidateMarketValueUsd: 0,
    excludedCandidateUnrealizedPnlUsd: 0,
    officialUnrealizedPnlUsd: -68.96,
    reconciliationStatus: 'failed',
    excludedPositions: [],
    reconciledPositionsByPriceSource: { provider_supplied: 1 },
    excludedReasonCounts: {},
    excludedClassificationCounts: { missing_price: 100, dust_spam: 16 },
    deadOrSpamPositionsCount: 16,
    reconciledMarketValueUsd: 40,
    reconciledCostBasisUsd: 108.96,
    unrealizedCoveragePercent: 0.85,
    openPositionCoveragePercent: 50,
    ...overrides,
  }
}

function hugeV2() {
  return {
    realizedPnlUsd: 2e9,
    unrealizedPnlUsd: 5e9,
    costBasis: [{ tokenAddress: '0xa', chainId: 8453, totalQuantity: 1, totalCostUsd: 2e9, averageCostUsd: 2e9 }],
    realized: [],
    unrealized: [],
    chainBreakdown: [{ chainId: 8453, realizedPnlUsd: 2e9, unrealizedPnlUsd: 5e9, costBasisUsd: 2e9 }],
  }
}

// 9. Item 2 — finite official unrealized with failed recon + unavailable realized gate is Partial, not Locked.
{
  const vm = buildWalletPnlViewModel({
    pnlV2: emptyPnlV2(),
    publicPnlStatus: 'unavailable',
    reconciliationSummary: canonicalUnavailableRecon(),
    unrealizedReconciliation: failedOfficialUnrealized(),
    walletPnlEvidenceAudit: audit({ closedLots: 0, failureReason: V2_ZERO_LOT_REASON }),
  })
  check('Item 2: combinedStatus stays unavailable (realized gates not lowered)', vm.combinedStatus === 'unavailable')
  check('Item 2: unrealized is Partial, not Locked', vm.unrealizedBox.status === 'Partial')
  check('Item 2: unrealized shows the official reconciled number', vm.unrealizedBox.value === '-$68.96')
  check('Item 2: unrealized reason is not the magnitude/stability lock copy', !/Magnitude\/stability guard blocked this figure/.test(vm.unrealizedBox.reason))
  check('Item 2: unrealized reason discloses failed recon', /failed/.test(vm.unrealizedBox.reason))
  check('Item 2: unrealized reason discloses excluded count', /116 of 117 positions excluded/.test(vm.unrealizedBox.reason))
  check('Item 2: unrealized reason discloses capped-to-balance count', /1 capped to canonical balance/.test(vm.unrealizedBox.reason))
}

// 10. Item 2 — V2's huge raw FIFO×price candidate must not lock a finite official unrealized.
{
  const vm = buildWalletPnlViewModel({
    pnlV2: hugeV2(),
    publicPnlStatus: 'unavailable',
    unrealizedReconciliation: failedOfficialUnrealized({ officialUnrealizedPnlUsd: -19.02 }),
  })
  check('Item 2: huge V2 magnitude does not Lock official unrealized', vm.unrealizedBox.status === 'Partial')
  check('Item 2: displayed unrealized is the official figure, not V2 5e9', vm.unrealizedBox.value === '-$19.02')
}

// 11. Item 2 — official magnitude itself above $1e9 still Locks (corruption threshold).
{
  const vm = buildWalletPnlViewModel({
    pnlV2: emptyPnlV2(),
    publicPnlStatus: 'ok',
    unrealizedReconciliation: failedOfficialUnrealized({
      officialUnrealizedPnlUsd: GUARDRAIL_ABS_LIMIT + 1,
      reconciliationStatus: 'ok',
      excludedOpenPositions: 0,
      totalOpenPositions: 1,
      reconciledOpenPositions: 1,
    }),
  })
  check('Item 2: corrupt official magnitude stays Locked', vm.unrealizedBox.status === 'Locked')
  check('Item 2: lock reason documents the $1e9 official-magnitude threshold', vm.unrealizedBox.reason.includes(String(GUARDRAIL_ABS_LIMIT)))
  check('Item 2: corrupt official number is not shown', vm.unrealizedBox.value === null)
}

// 12. Item 2 — no official figure + blocked still Locks (true missing).
{
  const vm = buildWalletPnlViewModel({
    pnlV2: emptyPnlV2(),
    publicPnlStatus: 'unavailable',
    unrealizedReconciliation: failedOfficialUnrealized({ officialUnrealizedPnlUsd: null, reconciliationStatus: 'not_reconciled' }),
  })
  check('Item 2: missing official unrealized stays Locked or Unavailable, never Partial-with-a-number', vm.unrealizedBox.status === 'Locked' || vm.unrealizedBox.status === 'Unavailable')
  check('Item 2: missing official unrealized shows no dollar figure', vm.unrealizedBox.value === null)
}

// 13. Item 2 helper: finite official + blocked realized gate → Partial.
{
  const status = resolveOfficialUnrealizedBoxStatus({
    canonicalSampleUnavailable: false,
    blocked: true,
    confidenceUnrealized: 'Partial',
    unrealizedReconciliation: failedOfficialUnrealized(),
  })
  check('Item 2 helper: blocked realized gate does not override finite official unrealized', status === 'Partial')
}

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
