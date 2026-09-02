// Wallet Scanner "Smart Money Score + PnL Evidence UI" simplification task — tests for:
//   1. provisional smart score always renders when a score exists (no blank "Not Yet Rated")
//   2. official score only renders when the real coverage/trade-count gate is met
//   3. Robinhood verified PnL shows inside the PnL boxes/chain rows
//   4. combined PnL can be locked while the Robinhood row is verified
//   5. no contradictory top badges
//   6. CORTEX and UI use the same PnL wording (one shared selector)
import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

const { computeSmartMoneyScore, MIN_VERIFIED_TRADES_FOR_OFFICIAL } = await import('../lib/engine/modules/smartMoney/computeSmartMoneyScore.ts')
const { buildWalletPnlViewModel, COMBINED_PNL_LOCKED_ROBINHOOD_VERIFIED_MESSAGE } = await import('../app/frontend/lib/buildWalletPnlViewModel.ts')

const smartScoreCardSrc = fs.readFileSync(new URL('../app/frontend/components/SmartMoneyScoreCard.tsx', import.meta.url), 'utf8')
const pnlCardSrc = fs.readFileSync(new URL('../app/frontend/components/PnlStatusCard.tsx', import.meta.url), 'utf8')
const walletReadBuilderSrc = fs.readFileSync(new URL('../app/frontend/lib/walletReadBuilder.ts', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')

function trade(overrides = {}) {
  return {
    realizedPnlUsd: 10, costBasisUsd: 100, closedAt: Date.now(), openedAt: Date.now() - 86_400_000, isVerified: true,
    ...overrides,
  }
}

console.log('Section A: provisional smart score always renders when a score exists')
{
  // Below the official gate (fewer than MIN_VERIFIED_TRADES_FOR_OFFICIAL), but with real behaviorV2
  // data, so provisionalBehaviorScore is non-null.
  const result = computeSmartMoneyScore({
    trades: Array.from({ length: 3 }, () => trade()),
    behaviorV2: { accumulationStyle: 'accumulator', rotationStyle: 'holding', memeBehavior: 'not_meme', farmingBehavior: 'not_farmer', stableRoutingBehavior: 'not_router' },
  })
  check('status is not_yet_rated below the gate', result.status === 'not_yet_rated')
  check('officialScore stays null below the gate', result.officialScore === null)
  check('provisionalBehaviorScore is a real number, not null', typeof result.provisionalBehaviorScore === 'number')

  // The card must show that provisional score prominently, not a bare "Not Yet Rated" headline.
  check('SmartMoneyScoreCard computes hasProvisionalScore and titles the card "Provisional Behaviour Score" when it is true', smartScoreCardSrc.includes("hasProvisionalScore") && smartScoreCardSrc.includes("'Provisional Behaviour Score'"))
  check('SmartMoneyScoreCard shows a "Not official" badge alongside the provisional score', smartScoreCardSrc.includes('label="Not official"'))
  check('SmartMoneyScoreCard states the real official-rating requirement using the real MIN_COVERAGE_PERCENT_FOR_OFFICIAL constant', smartScoreCardSrc.includes('Official rating requires at least {MIN_COVERAGE_PERCENT_FOR_OFFICIAL}% verified closed-history coverage.'))
}

console.log('\nSection B: official score only when the real coverage/trade-count gate is met')
{
  const belowGate = computeSmartMoneyScore({ trades: Array.from({ length: MIN_VERIFIED_TRADES_FOR_OFFICIAL - 1 }, () => trade()) })
  check('fewer than the minimum verified trades never produces an official score', belowGate.status === 'not_yet_rated' && belowGate.officialScore === null)

  const atGate = computeSmartMoneyScore({ trades: Array.from({ length: MIN_VERIFIED_TRADES_FOR_OFFICIAL }, (_, i) => trade({ closedAt: Date.now() - i * 3_600_000 })) })
  check('meeting both the trade count AND 100% coverage produces a real official score', atGate.status === 'official' && typeof atGate.officialScore === 'number')

  // A genuinely blank wallet (no trades, no behaviorV2) never fakes a provisional score either.
  const blank = computeSmartMoneyScore({ trades: [] })
  check('a wallet with zero real evidence anywhere gets a genuine null provisionalBehaviorScore (never fabricated)', blank.provisionalBehaviorScore === null)
}

console.log('\nSection C: Robinhood verified PnL shows inside the PnL boxes/chain rows, and combined PnL can be locked while it is verified')
{
  // Full, real shape required by selectRobinhoodPnlLaneStatus's strict gate (lib/walletScan/
  // canonicalWalletSelectors.ts) — every field the gate checks is present and passing, matching the
  // real Phase 3 sidecar output, never a loosened/partial fixture.
  const robinhoodVerified = {
    ok: true,
    pnl: { status: 'verified', realizedPnlUsd: 662.33, verifiedSwapCount: 5, matchedLotsCount: 12, message: '', reason: null },
    robinhoodPnlVerificationAudit: {
      source: 'robinhood_sidecar_phase3', chainId: 4663, status: 'verified',
      realizedPnlUsd: 662.33, verifiedSwapCount: 5, swapsFedToFifo: 5, fifoClosedLots: 12,
      priceEvidenceBothLegsCount: 5,
    },
  }
  const vm = buildWalletPnlViewModel({
    pnlV2: null, // Base/ETH genuinely inactive this scan
    publicPnlStatus: 'unavailable',
    robinhoodResult: robinhoodVerified,
    chainsScanned: [],
  })
  check('combinedStatus is "locked" when Base/ETH is not verified but Robinhood is', vm.combinedStatus === 'locked')
  check('combinedReason is the exact required replacement sentence', vm.combinedReason === COMBINED_PNL_LOCKED_ROBINHOOD_VERIFIED_MESSAGE)
  check('combinedReason is NOT the old generic "PnL unavailable due to missing evidence" message', vm.combinedReason !== 'PnL unavailable due to missing evidence')
  const rhRow = vm.chainRows.find((r) => r.chain === 'robinhood')
  check('a Robinhood chain row exists', rhRow != null)
  check('the Robinhood row status is "Verified"', rhRow.status === 'Verified')
  check('the Robinhood row shows the real, signed realized PnL value', rhRow.value === '+$662.33')
  check('robinhoodProof is populated with the real audit fields', vm.robinhoodProof != null && vm.robinhoodProof.verifiedSwaps === 5 && vm.robinhoodProof.closedLots === 12 && vm.robinhoodProof.source === 'Phase 3 sidecar')

  // Not-verified Robinhood must never show a fabricated number.
  const robinhoodNotVerified = { ok: true, pnl: { status: 'disabled', realizedPnlUsd: null, verifiedSwapCount: 0 } }
  const vm2 = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: robinhoodNotVerified, chainsScanned: [] })
  check('combinedStatus falls back to "unavailable" when neither lane is verified', vm2.combinedStatus === 'unavailable')
  const rhRow2 = vm2.chainRows.find((r) => r.chain === 'robinhood')
  check('a not-verified Robinhood row never shows a fabricated value', rhRow2.value === null)
  check('robinhoodProof is null when not verified', vm2.robinhoodProof === null)
}

console.log('\nSection D: no contradictory top badges — one combined status/reason drives the header')
{
  check('PnlStatusCard computes ONE pnlViewModel from buildWalletPnlViewModel', pnlCardSrc.includes('const pnlViewModel = buildWalletPnlViewModel('))
  check('the old separate "Active" badge is gone', !pnlCardSrc.includes("label={isActive ? 'Active' : 'Unavailable'}"))
  check('the old separate "Not reliable (magnitude)" top badge is gone', !pnlCardSrc.includes('label="Not reliable (magnitude)"'))
  check('the old separate "PnL unavailable" top badge is gone', !/label="PnL unavailable"/.test(pnlCardSrc))
  check('the header now renders exactly one combined-status badge sourced from pnlViewModel.combinedStatus', pnlCardSrc.includes('label={COMBINED_STATUS_LABEL[pnlViewModel.combinedStatus]}'))
}

console.log('\nSection E: CORTEX and UI use the same PnL wording')
{
  check('walletReadBuilder.ts carries pnlEvidenceSummary built from the SAME pnlViewModel.combinedReason', walletReadBuilderSrc.includes('reason: params.pnlViewModel.combinedReason'))
  check('page.tsx (CORTEX call site) calls buildWalletPnlViewModel with the same report fields PnlStatusCard reads', pageSrc.includes('const pnlViewModel = buildWalletPnlViewModel({') && pageSrc.includes('pnlViewModel,'))
  check('CORTEX and the main card both ultimately call the exported buildWalletPnlViewModel — one function, not two independent derivations', pnlCardSrc.includes("import { buildWalletPnlViewModel") && pageSrc.includes("import { buildWalletPnlViewModel } from '@/app/frontend/lib/buildWalletPnlViewModel'"))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
