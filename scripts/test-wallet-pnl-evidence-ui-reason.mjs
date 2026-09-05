// WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED — tests that buildWalletPnlViewModel's combined-
// unavailable reason text uses the real walletPnlEvidenceAudit.failureReason (e.g. "Open position
// only — no verified closed trades.", "No verified swaps found.", "Swap found, quote leg missing.")
// instead of the old generic "PnL unavailable due to missing evidence" — per this task's explicit
// UI requirement ("Do not just say 'missing evidence.'"). Never changes combinedStatus itself
// (still officialPnlStatus-gated) — additive reason text only, and only while combinedStatus is
// already 'unavailable'.
import assert from 'node:assert/strict'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`  FAIL: ${label}`) }
}

const { buildWalletPnlViewModel } = await import('../app/frontend/lib/buildWalletPnlViewModel.ts')
const { PNL_UNAVAILABLE_MESSAGE } = await import('../app/frontend/components/PnlStatusCard.tsx')

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

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
