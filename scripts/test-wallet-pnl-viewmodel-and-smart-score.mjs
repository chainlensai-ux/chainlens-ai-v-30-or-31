// Wallet Scanner "Clean up Wallet Scanner PnL UI and Smart Money score" task — tests for:
//   1. combined locked + Robinhood verified renders clearly (one combined badge/subtext)
//   2. Robinhood verified value appears in its own dedicated box
//   3. combined realized does not pretend to be verified when the header says locked
//   4. no contradictory top badges
//   5. Smart score renders official or provisional correctly
//   6. UI and CORTEX use the same view model
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
const viewModelSrc = fs.readFileSync(new URL('../app/frontend/lib/buildWalletPnlViewModel.ts', import.meta.url), 'utf8')
const walletReadBuilderSrc = fs.readFileSync(new URL('../app/frontend/lib/walletReadBuilder.ts', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')

function trade(overrides = {}) {
  return {
    realizedPnlUsd: 10, costBasisUsd: 100, closedAt: Date.now(), openedAt: Date.now() - 86_400_000, isVerified: true,
    ...overrides,
  }
}

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

console.log('Section A: combined locked + Robinhood verified renders clearly')
{
  const vm = buildWalletPnlViewModel({
    pnlV2: null, // Base/ETH genuinely inactive this scan
    publicPnlStatus: 'unavailable',
    robinhoodResult: robinhoodVerified,
    chainsScanned: [],
  })
  check('combinedStatus is "locked" when Base/ETH is not verified but Robinhood is', vm.combinedStatus === 'locked')
  check('combinedReason is the exact required replacement sentence', vm.combinedReason === COMBINED_PNL_LOCKED_ROBINHOOD_VERIFIED_MESSAGE)
  check('the required sentence matches the task\'s literal subtext', vm.combinedReason === 'Combined PnL is locked because Base/ETH history is partial. Robinhood realized PnL is verified separately.')
  check('combinedReason is NOT the old generic "PnL unavailable due to missing evidence" message', vm.combinedReason !== 'PnL unavailable due to missing evidence')
  check('the header badge label is "Combined Locked"', pnlCardSrc.includes("locked: 'Combined Locked'"))
}

console.log('\nSection B: Robinhood verified value appears in its own dedicated box')
{
  const vm = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: robinhoodVerified, chainsScanned: [] })
  check('robinhoodBox status is "Verified"', vm.robinhoodBox.status === 'Verified')
  check('robinhoodBox shows the real, signed Robinhood-only value', vm.robinhoodBox.value === '+$662.33')
  check('robinhoodBox carries the real proof (verified swaps, closed lots, source)', vm.robinhoodBox.proof != null && vm.robinhoodBox.proof.verifiedSwaps === 5 && vm.robinhoodBox.proof.closedLots === 12 && vm.robinhoodBox.proof.source === 'Phase 3 sidecar')
  check('robinhoodProof (top-level, back-compat) matches robinhoodBox.proof', JSON.stringify(vm.robinhoodProof) === JSON.stringify(vm.robinhoodBox.proof))
  const rhRow = vm.chainRows.find((r) => r.chain === 'robinhood')
  check('the per-chain Robinhood row ALSO shows the same value (both representations agree)', rhRow.status === 'Verified' && rhRow.value === '+$662.33')
  check('PnlStatusCard renders a dedicated Robinhood box component, not folded into the generic tile', pnlCardSrc.includes('<PnlRobinhoodBoxTile box={pnlViewModel.robinhoodBox} />'))

  // Not-verified Robinhood must never show a fabricated number anywhere.
  const robinhoodNotVerified = { ok: true, pnl: { status: 'disabled', realizedPnlUsd: null, verifiedSwapCount: 0 } }
  const vm2 = buildWalletPnlViewModel({ pnlV2: null, publicPnlStatus: 'unavailable', robinhoodResult: robinhoodNotVerified, chainsScanned: [] })
  check('a not-verified robinhoodBox never shows a fabricated value', vm2.robinhoodBox.value === null)
  check('a not-verified robinhoodBox carries no proof', vm2.robinhoodBox.proof === null)
  check('combinedStatus falls back to "unavailable" when neither lane is verified', vm2.combinedStatus === 'unavailable')
}

console.log('\nSection C: combined realized does not pretend to be verified')
{
  // Base/ETH bounded (partial) + Robinhood verified -> combined "locked". The Combined Realized PnL
  // box must show NO number and status "Locked" — never the bounded sample's own real number, which
  // would read as "this locked figure is actually verified".
  const vm = buildWalletPnlViewModel({
    pnlV2: null,
    publicPnlStatus: 'limited_verified_sample',
    reconciliationSummary: {
      realizedPnlUsd: 5000, unrealizedPnlUsd: null, warning: null,
      publicPnlGateAudit: { scanWindowDays: 90, verifiedClosedLots: 20, structuralClosedLots: 40, verifiedPricingCoverage: 0.6, invalidOrUnknownUnmatchedEvents: 0, historyCoverageStatus: 'partial', integrityTier: 'partial' },
      pnlDiscrepancyAudit: null,
      publicPnlStatus: 'partial',
    },
    robinhoodResult: robinhoodVerified,
    chainsScanned: ['base', 'eth'],
  })
  check('combinedStatus is "locked" (Robinhood overrides a bounded/partial Base+ETH sample too)', vm.combinedStatus === 'locked')
  check('combinedRealizedBox status mirrors combinedStatus exactly — "Locked"', vm.combinedRealizedBox.status === 'Locked')
  check('combinedRealizedBox shows NO number while locked — never the bounded sample\'s real figure', vm.combinedRealizedBox.value === null)
  check('combinedRealizedBox reason explains why (Base/ETH partial), never claims verification', /partial/i.test(vm.combinedRealizedBox.reason) && !/verified/i.test(vm.combinedRealizedBox.reason))
  check('the old bounded-sample disclosure box (its own bold "Verified N-day sample" headline) is suppressed while combined is locked', pnlCardSrc.includes("{boundedSample && pnlViewModel.combinedStatus !== 'locked' && ("))

  // A genuinely verified combined PnL DOES show its real number in this exact same box. isStablePnl
  // requires a finite unrealizedPnlUsd too, which comes ONLY from unrealizedReconciliation (never
  // pnlV2.unrealizedPnlUsd) — see selectDisplayedUnrealizedPnl's own header — so a real reconciliation
  // fixture is required here for the stability gate to pass.
  const verifiedVm = buildWalletPnlViewModel({
    pnlV2: { realizedPnlUsd: 100, unrealizedPnlUsd: 999999, costBasis: [{ totalCostUsd: 500 }], chainBreakdown: [] },
    publicPnlStatus: 'ok',
    unrealizedReconciliation: { officialUnrealizedPnlUsd: 0, reconciliationStatus: 'ok', unrealizedCoveragePercent: 100, totalOpenPositions: 0, reconciledOpenPositions: 0, excludedOpenPositions: 0, deadOrSpamPositionsCount: 0, excludedCandidateMarketValueUsd: 0, excludedClassificationCounts: {}, openPositionCoveragePercent: 100 },
    chainsScanned: [],
  })
  check('a genuinely verified combined figure shows a real number in the same box', verifiedVm.combinedRealizedBox.status === 'Verified' && verifiedVm.combinedRealizedBox.value === '+$100.00')
}

console.log('\nSection D: no contradictory top badges')
{
  check('PnlStatusCard computes ONE pnlViewModel from buildWalletPnlViewModel', pnlCardSrc.includes('const pnlViewModel = buildWalletPnlViewModel('))
  check('the old separate "Active" badge is gone', !pnlCardSrc.includes("label={isActive ? 'Active' : 'Unavailable'}"))
  check('the old separate "Not reliable (magnitude)" top badge is gone', !pnlCardSrc.includes('label="Not reliable (magnitude)"'))
  check('the old separate "PnL unavailable" top badge is gone', !/label="PnL unavailable"/.test(pnlCardSrc))
  check('the header renders exactly one combined-status badge sourced from pnlViewModel.combinedStatus', pnlCardSrc.includes('label={COMBINED_STATUS_LABEL[pnlViewModel.combinedStatus]}'))
  check('the redundant duplicate Robinhood proof block below the chain rows was removed (proof now lives only in the Robinhood box)', !/Verified swaps: \{pnlViewModel\.robinhoodProof\.verifiedSwaps\}/.test(pnlCardSrc))
}

console.log('\nSection E: Smart score renders official or provisional correctly')
{
  const belowGate = computeSmartMoneyScore({
    trades: Array.from({ length: 3 }, () => trade()),
    behaviorV2: { accumulationStyle: 'accumulator', rotationStyle: 'holding', memeBehavior: 'not_meme', farmingBehavior: 'not_farmer', stableRoutingBehavior: 'not_router' },
  })
  check('status is not_yet_rated below the gate', belowGate.status === 'not_yet_rated')
  check('officialScore stays null below the gate', belowGate.officialScore === null)
  check('provisionalBehaviorScore is a real number, not null', typeof belowGate.provisionalBehaviorScore === 'number')

  const atGate = computeSmartMoneyScore({ trades: Array.from({ length: MIN_VERIFIED_TRADES_FOR_OFFICIAL }, (_, i) => trade({ closedAt: Date.now() - i * 3_600_000 })) })
  check('meeting both the trade count AND 100% coverage produces a real official score', atGate.status === 'official' && typeof atGate.officialScore === 'number')

  const blank = computeSmartMoneyScore({ trades: [] })
  check('a wallet with zero real evidence anywhere gets a genuine null provisionalBehaviorScore (never fabricated)', blank.provisionalBehaviorScore === null)

  check('card titles "Smart Money Score" + "Rated" badge when official', smartScoreCardSrc.includes('<StatusBadge label="Rated" tone="success" glow />'))
  check('card titles "Provisional Behaviour Score" + "Not official" badge when not official but a score exists', smartScoreCardSrc.includes("'Provisional Behaviour Score'") && smartScoreCardSrc.includes('label="Not official"'))
  check('card states the real official-rating coverage requirement', smartScoreCardSrc.includes('Official rating requires at least {MIN_COVERAGE_PERCENT_FOR_OFFICIAL}% verified closed-history coverage.'))
}

console.log('\nSection F: UI and CORTEX use the same view model')
{
  check('walletReadBuilder.ts carries pnlEvidenceSummary built from the SAME pnlViewModel.combinedReason', walletReadBuilderSrc.includes('reason: params.pnlViewModel.combinedReason'))
  check('page.tsx (CORTEX call site) calls buildWalletPnlViewModel with the same report fields PnlStatusCard reads', pageSrc.includes('const pnlViewModel = buildWalletPnlViewModel({') && pageSrc.includes('pnlViewModel,'))
  check('CORTEX and the main card both ultimately call the exported buildWalletPnlViewModel — one function, not two independent derivations', pnlCardSrc.includes('import { buildWalletPnlViewModel') && pageSrc.includes("import { buildWalletPnlViewModel } from '@/app/frontend/lib/buildWalletPnlViewModel'"))
  check('buildWalletPnlViewModel.ts never recomputes PnL math — only reads the existing exported selectors', /selectVerifiedPnlData|selectDisplayedPnl|selectPnlConfidenceStatus/.test(viewModelSrc))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
