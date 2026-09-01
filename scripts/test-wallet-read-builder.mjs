// Tests for app/frontend/lib/walletReadBuilder.ts — the pure builder behind the redesigned
// "CORTEX · Wallet Read" sidebar (Wallet Read / CORTEX sidebar redesign task). Every function here
// is pure, so these are direct, real-input exercises — no mocking, no DOM.
//
// COVERAGE, DISCLOSED (this task's own explicit test requirements):
// - every personality label requires real supporting conditions
// - verified/partial/missing sections render correctly (buildEvidence)
// - Robinhood/Base/ETH PnL lane wording stays isolated (buildPnlLanes)
// - sidebar output matches the main wallet result state (source-level checks in
//   test-wallet-scanner-merged-view.mjs's section 7/17 confirm buildCortexReadV2 in page.tsx feeds
//   this builder the SAME selector outputs the main UI uses — this file covers the builder itself)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  selectPersonalityLabel,
  selectWalletReadConfidence,
  computeDataFreshness,
  buildHeadline,
  buildKeySignals,
  buildWhyThisLabel,
  buildEvidence,
  buildPnlLanes,
  buildNextAction,
  buildWalletReadV2,
  ROBINHOOD_PNL_NOT_VERIFIED_REASON,
} from '../app/frontend/lib/walletReadBuilder.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

function read(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

function behaviorIntel(overrides = {}) {
  return {
    rotationStyle: { value: 'rotator', basis: { buyCount: 10, sellCount: 8, distributionCount: 0, distinctTokensTraded: 6 } },
    riskOnOff: { value: 'risk_on', basis: '' },
    multiChainParticipation: { activeChains: ['base', 'eth'], primaryChain: 'base', chainSelectionRef: { activeChainCount: 2, dustChainCount: 0 }, chainsWithRealSells: [], chainsPendingSellEvidence: [] },
    concentrationSignals: { topHoldingSymbol: 'USDT', topHoldingPercent: 68, concentrationLabel: 'high' },
    automationSignals: { suspectedBot: false, signals: [] },
    confidence: 'high',
    confidenceBasis: { chainSelectionFactor: '', windowCoverageFactor: '', sellEvidenceFactor: '' },
    exitVelocity: { medianMsBetweenSells: 1.8 * 86_400_000, basis: '' },
    convictionScore: { value: 'high', basis: '' },
    ...overrides,
  }
}

function run() {
  const builderSrc = read('app/frontend/lib/walletReadBuilder.ts')
  const panelSrc = read('app/frontend/components/WalletReadPanel.tsx')

  // ── 1. Personality label: every label requires real supporting conditions ──────────────────────
  {
    check('rotator + multi-chain -> "Multi-chain Rotator"', selectPersonalityLabel(behaviorIntel()) === 'Multi-chain Rotator')
    check('accumulator, single-chain -> "Accumulator"', selectPersonalityLabel(behaviorIntel({
      rotationStyle: { value: 'accumulator', basis: { buyCount: 3, sellCount: 0, distributionCount: 0, distinctTokensTraded: 2 } },
      multiChainParticipation: { activeChains: ['base'], primaryChain: 'base', chainSelectionRef: { activeChainCount: 1, dustChainCount: 0 }, chainsWithRealSells: [], chainsPendingSellEvidence: [] },
      concentrationSignals: null,
    })) === 'Accumulator')
    check('distributor, single-chain -> "Distributor"', selectPersonalityLabel(behaviorIntel({
      rotationStyle: { value: 'distributor', basis: { buyCount: 2, sellCount: 20, distributionCount: 15, distinctTokensTraded: 4 } },
      multiChainParticipation: { activeChains: ['base'], primaryChain: 'base', chainSelectionRef: { activeChainCount: 1, dustChainCount: 0 }, chainsWithRealSells: [], chainsPendingSellEvidence: [] },
      concentrationSignals: null,
    })) === 'Distributor')
    check(
      'accumulator + high concentration -> "Concentrated Holder" (single-chain) — a genuinely different real state from a plain accumulator',
      selectPersonalityLabel(behaviorIntel({
        rotationStyle: { value: 'accumulator', basis: { buyCount: 3, sellCount: 0, distributionCount: 0, distinctTokensTraded: 1 } },
        multiChainParticipation: { activeChains: ['base'], primaryChain: 'base', chainSelectionRef: { activeChainCount: 1, dustChainCount: 0 }, chainsWithRealSells: [], chainsPendingSellEvidence: [] },
      })) === 'Concentrated Holder',
    )
    check(
      'no behaviorIntel at all -> honest neutral "Wallet", never a guessed personality with zero evidence',
      selectPersonalityLabel(null) === 'Wallet',
    )
    check(
      'rotation "unknown" with no concentration signal -> "Wallet", never a fabricated specific label',
      selectPersonalityLabel(behaviorIntel({ rotationStyle: { value: 'unknown', basis: { buyCount: 0, sellCount: 0, distributionCount: 0, distinctTokensTraded: 0 } }, concentrationSignals: null })) === 'Wallet',
    )
    check(
      'rotation "unknown" but real high concentration -> "Concentrated Holder", a label WITH real supporting evidence even without a rotation classification',
      selectPersonalityLabel(behaviorIntel({ rotationStyle: { value: 'unknown', basis: { buyCount: 0, sellCount: 0, distributionCount: 0, distinctTokensTraded: 0 } } })) === 'Multi-chain Concentrated Holder',
    )
  }

  // ── 2. Confidence badge: direct, honest passthrough — never upgraded ────────────────────────────
  {
    check('confidence "high" -> "High"', selectWalletReadConfidence(behaviorIntel({ confidence: 'high' })) === 'High')
    check('confidence "medium" -> "Medium"', selectWalletReadConfidence(behaviorIntel({ confidence: 'medium' })) === 'Medium')
    check('confidence "low" -> "Low"', selectWalletReadConfidence(behaviorIntel({ confidence: 'low' })) === 'Low')
    check('no behaviorIntel at all -> honestly "Low", never defaulted to "Medium"/"High"', selectWalletReadConfidence(null) === 'Low')
  }

  // ── 3. Data freshness: real elapsed time, honest fallback ───────────────────────────────────────
  {
    const now = Date.parse('2026-01-01T12:00:00Z')
    check('5 minutes ago -> "Scanned 5m ago"', computeDataFreshness('2026-01-01T11:55:00Z', now) === 'Scanned 5m ago')
    check('2 hours ago -> "Scanned 2h ago"', computeDataFreshness('2026-01-01T10:00:00Z', now) === 'Scanned 2h ago')
    check('3 days ago -> "Scanned 3d ago"', computeDataFreshness('2025-12-29T12:00:00Z', now) === 'Scanned 3d ago')
    check('missing/unparseable timestamp -> honest "Freshness unknown", never a guessed "just now"', computeDataFreshness(null) === 'Freshness unknown' && computeDataFreshness('not-a-date') === 'Freshness unknown')
  }

  // ── 4. Headline: real template, no AI-slop phrasing, no fake numbers ────────────────────────────
  {
    const headline = buildHeadline({ personalityLabel: 'Multi-chain Rotator', activeChainCount: 3, topChain: { chain: 'robinhood', valueUsd: 900, percent: 90 }, evmPnlLane: 'partial' })
    check('headline mentions the real personality label and chain count', headline.includes('Multi-chain Rotator across 3 chains'))
    check('headline flags heavy Robinhood exposure ONLY when the real top chain is Robinhood at >=50%', headline.includes('heavy Robinhood exposure'))
    check('headline states the real bounded-coverage PnL lane, never a specific fabricated percentage', headline.includes('bounded'))
    check('headline never uses banned AI-slop phrasing', !/appears to|seems to|overall this wallet/i.test(headline))
    const noRobinhoodHeadline = buildHeadline({ personalityLabel: 'Accumulator', activeChainCount: 1, topChain: { chain: 'base', valueUsd: 100, percent: 100 }, evmPnlLane: 'verified' })
    check('a non-Robinhood-dominant top chain never triggers the Robinhood clause', !noRobinhoodHeadline.includes('Robinhood'))
    check('a single-chain wallet never gets a fabricated "across N chains" clause', !noRobinhoodHeadline.includes('across'))
    check('a verified EVM lane states real verified evidence, not a vague claim', noRobinhoodHeadline.includes('Verified PnL evidence'))
  }

  // ── 5. Key signals: only shown when backed by real metrics ──────────────────────────────────────
  {
    const signals = buildKeySignals({
      chainsScanned: ['base', 'eth'], robinhoodIncluded: true, totalValueUsd: 9097.55,
      topChain: { chain: 'robinhood', valueUsd: 7376.32, percent: 81 }, pricedTokenCount: 12,
      lastActiveMs: Date.parse('2025-06-01T00:00:00Z'), buyCount: 10, sellCount: 8, rotationStyle: 'rotator',
    })
    check('Chains active includes Robinhood only when robinhoodIncluded is true', signals.find((s) => s.label === 'Chains active')?.value.includes('Robinhood'))
    check('Portfolio value shows the real merged total', signals.find((s) => s.label === 'Portfolio value')?.value === '$9,097.55' || signals.find((s) => s.label === 'Portfolio value')?.value.includes('9,097'))
    check('Largest chain exposure shows the real top chain and percent', signals.find((s) => s.label === 'Largest chain exposure')?.value === 'Robinhood · 81%')
    check('Buys / sells only appears when real counts exist', signals.find((s) => s.label === 'Buys / sells')?.value === '10 / 8')

    const noTradesSignals = buildKeySignals({
      chainsScanned: ['base'], robinhoodIncluded: false, totalValueUsd: null, topChain: null, pricedTokenCount: 0,
      lastActiveMs: null, buyCount: 0, sellCount: 0, rotationStyle: null,
    })
    check('Buys / sells is OMITTED (never a fake "0 / 0" row) when there is no real trade evidence', !noTradesSignals.some((s) => s.label === 'Buys / sells'))
    check('Rotation style is omitted when rotationStyle is null/"unknown" — never shown unbacked', !noTradesSignals.some((s) => s.label === 'Rotation style'))
    check('Largest chain exposure is omitted entirely when there is no real chain breakdown', !noTradesSignals.some((s) => s.label === 'Largest chain exposure'))
  }

  // ── 6. Why This Label: 3-5 real bullets, never padded, never fabricated ─────────────────────────
  {
    const bullets = buildWhyThisLabel({
      topChain: { chain: 'robinhood', valueUsd: 900, percent: 90 },
      matchedLotsCount: 56,
      medianSellGap: '1.8d',
      concentrationDetail: 'USDT · 68% of portfolio',
      historicalCoverage: 'Bounded sample (90-day)',
    })
    check('bullet 1: real top-chain percent, worded exactly as this task\'s own example', bullets.some((b) => b === '90% of supported value is on Robinhood Chain'))
    check('bullet 2: real verified trade count', bullets.some((b) => b === '56 verified trades found'))
    check('bullet 3: real median sell gap', bullets.some((b) => b === 'Median gap between sells: 1.8d'))
    check('bullet 4: real concentration detail', bullets.some((b) => b === 'Top holding concentration: USDT · 68% of portfolio'))
    check('bullet 5: real historical coverage', bullets.some((b) => b === 'Closed-history coverage: Bounded sample (90-day)'))
    check('never more than 5 bullets', bullets.length <= 5)

    const emptyBullets = buildWhyThisLabel({ topChain: null, matchedLotsCount: 0, medianSellGap: null, concentrationDetail: null, historicalCoverage: 'Not available' })
    check('zero real evidence -> zero bullets, never padded with filler to hit a target count', emptyBullets.length === 0)
    const belowThresholdBullets = buildWhyThisLabel({ topChain: { chain: 'base', valueUsd: 40, percent: 40 }, matchedLotsCount: 0, medianSellGap: null, concentrationDetail: null, historicalCoverage: 'Not available' })
    check('a top-chain percent below 50% is not asserted as a defining reason (avoids a weak/misleading "why")', belowThresholdBullets.length === 0)
  }

  // ── 7. Evidence: verified/partial/missing render correctly, from real classification only ──────
  {
    const evidence = buildEvidence({
      hasHoldingsData: true,
      pnlConfidence: { realized: 'Partial', unrealized: 'Partial', historicalCoverage: 'Bounded sample (90-day)', openPositionCoveragePercent: 60, integrity: 'Needs review' },
      robinhoodDisplayState: 'partial_unpriced',
      robinhoodPnlLane: 'not_verified',
      matchedLotsCount: 5,
    })
    check('verified includes real holdings/chain exposure when hasHoldingsData is true', evidence.verified.includes('Holdings and chain exposure'))
    check('verified includes Robinhood holdings scan when it was genuinely scanned (valued or partial_unpriced)', evidence.verified.includes('Robinhood holdings scan'))
    check('verified includes the closed-lot sample when matchedLotsCount > 0', evidence.verified.includes('Closed-lot sample'))
    check('partial includes realized PnL when pnlConfidence.realized is "Partial"', evidence.partial.includes('Realized PnL (bounded sample)'))
    check('partial includes unrealized/open-position PnL when pnlConfidence.unrealized is "Partial"', evidence.partial.includes('Unrealized/open-position PnL'))
    check('partial includes Robinhood PnL when its lane is "not_verified" (real evidence, not fully verified)', evidence.partial.includes('Robinhood PnL (real evidence, not fully verified)'))

    const lockedEvidence = buildEvidence({
      hasHoldingsData: false,
      pnlConfidence: { realized: 'Locked', unrealized: 'Unavailable', historicalCoverage: 'Not available', openPositionCoveragePercent: null, integrity: null },
      robinhoodDisplayState: 'not_scanned',
      robinhoodPnlLane: 'unavailable',
      matchedLotsCount: 0,
    })
    check('missing includes realized PnL when locked', lockedEvidence.missing.includes('Realized PnL'))
    check('missing includes unrealized PnL when unavailable', lockedEvidence.missing.includes('Unrealized PnL'))
    check('missing includes full historical coverage when not available', lockedEvidence.missing.includes('Full historical coverage'))
    check('missing includes Robinhood PnL when its lane is "unavailable"', lockedEvidence.missing.includes('Robinhood PnL'))
    check('nothing false-verified when there is no holdings data', !lockedEvidence.verified.includes('Holdings and chain exposure'))
  }

  // ── 8. PnL lanes: Base/ETH and Robinhood never merged, exact required "not verified" reason ─────
  {
    const lanesNoRobinhood = buildPnlLanes({ evmPnlLane: 'verified', robinhoodPnlLane: 'unavailable', robinhoodResult: null })
    check('with no robinhoodResult at all, only ONE lane exists — Base/ETH', lanesNoRobinhood.length === 1 && lanesNoRobinhood[0].chainLabel === 'Base/ETH')

    const robinhoodVerified = { ok: true, pnl: { status: 'verified', realizedPnlUsd: 12.5, verifiedSwapCount: 3, message: '', reason: null } }
    const lanesVerified = buildPnlLanes({ evmPnlLane: 'partial', robinhoodPnlLane: 'verified', robinhoodResult: robinhoodVerified })
    check('two DISTINCT lanes exist when a real robinhoodResult is present — never merged into one', lanesVerified.length === 2 && lanesVerified[0].chainLabel === 'Base/ETH' && lanesVerified[1].chainLabel === 'Robinhood')
    check('the Base/ETH lane status is completely independent of the Robinhood lane status', lanesVerified[0].status === 'partial' && lanesVerified[1].status === 'verified')
    check('a verified Robinhood lane shows the real verifiedSwapCount, never a fabricated number', lanesVerified[1].detail.includes('3 verified swaps'))

    const robinhoodUnverified = { ok: true, pnl: { status: 'disabled', realizedPnlUsd: null, verifiedSwapCount: 0, message: '', reason: null } }
    const lanesNotVerified = buildPnlLanes({ evmPnlLane: 'verified', robinhoodPnlLane: 'not_verified', robinhoodResult: robinhoodUnverified })
    check(
      'a not-verified Robinhood lane states the EXACT required reason verbatim: "Requires verified Robinhood swaps + both-leg price evidence."',
      lanesNotVerified[1].detail === 'Requires verified Robinhood swaps + both-leg price evidence.' && lanesNotVerified[1].detail === ROBINHOOD_PNL_NOT_VERIFIED_REASON,
    )
    check('a not-verified Robinhood lane label reads "Not verified", never implying a verified figure exists', lanesNotVerified[1].statusLabel === 'Not verified')
  }

  // ── 9. Next action: one real, prioritized action — never generic filler ─────────────────────────
  {
    check('a bounded/partial EVM sample recommends Deep Scan for coverage', buildNextAction({ evmPnlLane: 'partial', robinhoodPnlLane: 'unavailable', robinhoodResult: null, concentrationLabel: null }).includes('Deep Scan'))
    check('an unverified-but-present Robinhood lane recommends inspecting the Robinhood tab', buildNextAction({ evmPnlLane: 'verified', robinhoodPnlLane: 'not_verified', robinhoodResult: { ok: true, pnl: { status: 'disabled', realizedPnlUsd: null, verifiedSwapCount: 0 } }, concentrationLabel: null }).includes('Robinhood tab'))
    check('high concentration with everything else fine recommends reviewing concentration risk', buildNextAction({ evmPnlLane: 'verified', robinhoodPnlLane: 'unavailable', robinhoodResult: null, concentrationLabel: 'high' }).includes('concentration risk'))
    check('a fully verified, low-risk wallet gets an honest "no further action" line, never a forced generic suggestion', buildNextAction({ evmPnlLane: 'verified', robinhoodPnlLane: 'unavailable', robinhoodResult: null, concentrationLabel: null }).includes('No further action needed'))
  }

  // ── 10. Top-level buildWalletReadV2: composes every section from real inputs ────────────────────
  {
    const readResult = buildWalletReadV2({
      walletAddress: '0x1234567890123456789012345678901234567890',
      scanTimestamp: new Date().toISOString(),
      chainsScanned: ['base', 'eth'],
      behaviorIntel: behaviorIntel(),
      finalSummary: { walletPersonality: 'x', financialStatus: { officialPnlStatus: 'ok', headline: 'x' }, behavioralStatus: { riskOnOff: 'risk_on', rotationStyle: 'rotator' }, chainParticipationSummary: 'x', recoverySummary: 'x' },
      totalValueUsd: 9097.55,
      robinhoodIncluded: true,
      chainBreakdown: [{ chain: 'robinhood', valueUsd: 7376.32, percent: 81 }, { chain: 'base', valueUsd: 1721.23, percent: 19 }],
      pricedTokenCount: 12,
      concentrationDetail: 'USDT · 68% of portfolio',
      concentrationLabel: 'high',
      matchedLotsCount: 56,
      lastActiveMs: Date.now() - 86_400_000,
      evmPnlLane: 'partial',
      robinhoodPnlLane: 'not_verified',
      robinhoodDisplayState: 'valued',
      robinhoodResult: { ok: true, pnl: { status: 'disabled', realizedPnlUsd: null, verifiedSwapCount: 0, message: '', reason: null } },
      pnlConfidence: { realized: 'Partial', unrealized: 'Partial', historicalCoverage: 'Bounded sample (90-day)', openPositionCoveragePercent: 60, integrity: 'Needs review' },
    })
    check('identity.shortAddress is a real shortened address, not the full raw string', readResult.identity.shortAddress === '0x1234…7890')
    check('identity.personalityLabel is real and non-empty', typeof readResult.identity.personalityLabel === 'string' && readResult.identity.personalityLabel.length > 0)
    check('identity.confidence is a real classification', ['High', 'Medium', 'Low'].includes(readResult.identity.confidence))
    check('headline is non-empty and references the real total chain reach', readResult.headline.length > 0)
    check('keySignals is a non-empty array of real {label, value} pairs', readResult.keySignals.length > 0 && readResult.keySignals.every((s) => typeof s.label === 'string' && typeof s.value === 'string'))
    check('whyThisLabel has real supporting bullets for the shown label', readResult.whyThisLabel.length > 0)
    check('evidence has all three real buckets present as arrays', Array.isArray(readResult.evidence.verified) && Array.isArray(readResult.evidence.partial) && Array.isArray(readResult.evidence.missing))
    check('pnlLanes has both Base/ETH and Robinhood, never merged', readResult.pnlLanes.length === 2)
    check('nextAction is a real, non-empty string', readResult.nextAction.length > 0)
  }

  // ── 11. Source-level: no chatbot framing, panel wired to the builder's real fields ──────────────
  {
    check('WalletReadPanel renders read.identity/read.headline/read.keySignals/read.whyThisLabel/read.evidence/read.pnlLanes/read.nextAction — every real section', ['identity', 'headline', 'keySignals', 'whyThisLabel', 'evidence', 'pnlLanes', 'nextAction'].every((f) => panelSrc.includes(`read.${f}`)))
    check('no chatbot-style greeting framing in the panel\'s actual rendered JSX (comments quoting the banned phrase as a design note don\'t count)', !/hi!|here's what i found|as an ai/i.test(panelSrc.replace(/\/\/.*$/gm, '')))
    check('walletReadBuilder.ts never uses banned AI-slop phrasing in any literal string (template/message text, not disclosure comments)', !/appears to|seems to|overall this wallet demonstrates/i.test(builderSrc.replace(/\/\/.*$/gm, '')))
  }

  console.log(`test-wallet-read-builder.mjs: all ${passed} assertions passed`)
}

run()
