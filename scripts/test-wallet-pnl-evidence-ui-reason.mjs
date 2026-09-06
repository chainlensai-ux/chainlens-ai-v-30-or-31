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
} = await import('../app/frontend/lib/buildWalletPnlViewModel.ts')
const { PNL_UNAVAILABLE_MESSAGE } = await import('../app/frontend/components/PnlStatusCard.tsx')

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

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
