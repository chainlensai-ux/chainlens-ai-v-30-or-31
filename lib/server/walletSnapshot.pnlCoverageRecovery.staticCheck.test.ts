// PNL COVERAGE RECOVERY BOTTLENECK FIX, DISCLOSED — reported live: 603 structural closed lots, 213
// verified, 35.32% verified pricing coverage (below the 50% official-PnL gate), 390 lots blocked by
// missing_price, only 89 more verified lots needed to cross the gate — yet the targeted recovery
// page budget funded only ~3 tokens and 5 of 8 triggered synthetic-lot target tokens got zero
// historical recovery pages.
//
// ROOT CAUSE, CONFIRMED: the targeted recovery pass (lib/server/walletSnapshot.ts's
// _syntheticTargetExtra* mechanism) fetches ONE GoldRush "transactions by address" page PER CHAIN,
// filtered to whichever target-token contracts are eligible — a single page call already covers
// EVERY eligible token on that chain at once, so the real per-call cost is per-chain-page, not
// per-token. Two bugs compounded the coverage loss: (1) a flat token cap (2, or 4 for high-value
// wallets) excluded additional triggered tokens from that SAME already-budgeted page call for free;
// (2) the ranking that decided WHICH tokens got the scarce eligible slots sorted by dollar value
// (excludedUsd) first, not by how many closed lots recovering that token would actually complete
// (lotCount) — the real "expected closed-lot coverage gained per provider call" signal this task asks
// for.
//
// Fixed by: (1) widening the token cap to include every triggered synthetic-lot target token
// (bounded by a sane ceiling), leaving the real spend limiter (the reserved-credit budget check)
// unchanged — this redistributes the SAME budget across more high-yield tokens, never raising the
// total call/page budget; (2) ranking eligible tokens by lotCount first, excludedUsd as tiebreaker;
// (3) a `pnlCoverageRecoveryAudit` object reporting real before/after coverage, per-token call/
// completion attribution, and the exact remaining blocker when the 50% gate is not reached.
//
// walletSnapshot.ts is a single, provider-dependent, ~20,000-line function — not fixture-testable in
// isolation (same reasoning as barePoolDexClassification.staticCheck.test.ts and
// lpSafetyOpenCheckFix.staticCheck.test.ts). This reads the real source and asserts on the exact
// patterns the fix depends on.
//
// Run directly with:
//   npx tsx --test lib/server/walletSnapshot.pnlCoverageRecovery.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./walletSnapshot.ts', import.meta.url)), 'utf8')

describe('walletSnapshot.ts — recovery token ranking prioritizes closed-lot coverage yield, not dollar value', () => {
  it('sorts _syntheticTargetRankedTokens by lotCount (expected coverage gain) before excludedUsd', () => {
    assert.match(
      src,
      /\.sort\(\(a, b\) => b\.lotCount - a\.lotCount \|\| b\.excludedUsd - a\.excludedUsd\)/,
      'lotCount must be the primary sort key — each eligible token costs the same shared per-chain page call, so the token completing the most closed lots must be prioritized over the token with the highest dollar value',
    )
  })

  it('never reverts to ranking by excludedUsd before lotCount', () => {
    assert.doesNotMatch(
      src,
      /\.sort\(\(a, b\) => b\.excludedUsd - a\.excludedUsd \|\| b\.lotCount - a\.lotCount\)/,
      'the old dollar-value-first ranking must not reappear',
    )
  })
})

describe('walletSnapshot.ts — recovery token eligibility is no longer artificially capped at 2/4 tokens', () => {
  it('_syntheticTargetExtraMaxTokens includes every triggered synthetic-lot target token, not just a flat 2/4 cap', () => {
    assert.match(
      src,
      /const _syntheticTargetExtraMaxTokens = Math\.max\(_walletValueTier === 'high_value' \? 4 : 2, Math\.min\(12, _syntheticLotTokenTargets\.length\)\)/,
      'the eligible-token cap must scale with how many tokens actually triggered recovery, since one shared per-chain page call already covers every eligible token at zero extra cost',
    )
  })

  it('the real spend limiter (reserved-credit budget) is left in place — this only widens which tokens can compete for it', () => {
    assert.match(src, /_syntheticTargetExtraTokensAffordableByReservedBudget/)
    assert.match(src, /_syntheticTargetExtraPagesAllowed/)
  })

  it('the paid extra GoldRush page is filtered to every ranked-eligible token, not the reserved-credit token slice', () => {
    assert.match(
      src,
      /const _extraTargetContracts = new Set\(_syntheticTargetExtraEligibleTokens\)/,
      'GoldRush extra pages are per-chain; reserved credits cap pages, not the post-filter after a page is paid',
    )
    assert.doesNotMatch(
      src,
      /const _extraTargetContracts = new Set\(_syntheticTargetExtraAttemptedTokens\)/,
      'attempted-token slice must not drop other eligible tokens from an already-paid shared page',
    )
  })

  it('extra pages are not skipped just because the broad pass recovered a prior buy for some other token', () => {
    assert.match(
      src,
      /else if \(_syntheticEligibleStillMissingPriorBuy\.length === 0\) _syntheticTargetExtraSkippedReason = 'prior_buy_already_found'/,
    )
    assert.doesNotMatch(
      src,
      /else if \(_syntheticTargetExtraPriorBuysFoundSoFar > 0\) _syntheticTargetExtraSkippedReason = 'prior_buy_already_found'/,
    )
  })

  it('recoveryCallsByToken attributes paid per-chain pages to every ranked-eligible token', () => {
    assert.match(
      src,
      /for \(const t of _syntheticTargetExtraEligibleTokens\) \{/,
    )
  })

  it('extra-page chain selection prefers still-missing eligible tokens so a recovered chain cannot starve another', () => {
    assert.match(src, /const _extraMissingSyntheticLots = _extraTargetSyntheticLots\.filter/)
    assert.match(src, /const _extraChainSourceLots = _extraMissingSyntheticLots\.length > 0 \? _extraMissingSyntheticLots : _extraTargetSyntheticLots/)
    assert.match(src, /const _stillMissingOnThisChain = _stillMissingAfterPage\.filter/)
  })
})

describe('walletSnapshot.ts — pnlCoverageRecoveryAudit is built with the required exact field list', () => {
  const requiredFields = [
    'closedLots', 'verifiedLotsBefore', 'verifiedLotsAfter', 'coverageBefore', 'coverageAfter',
    'missingPriceLots', 'tokensRanked', 'recoveryCallsByToken', 'lotsCompletedByToken',
    'acceptedEvidenceHits', 'sameTxQuoteRecoveries', 'providerRecoveries', 'budgetSkippedTokens',
    'thresholdReached', 'exactRemainingBlocker', 'pnlRecoveryFlowAudit',
  ]

  it('declares every required field on the PnlCoverageRecoveryAudit type', () => {
    const typeMatch = src.match(/export type PnlCoverageRecoveryAudit = \{([\s\S]*?)\n\}/)
    assert.ok(typeMatch, 'PnlCoverageRecoveryAudit type must exist')
    const body = typeMatch![1]
    for (const field of requiredFields) {
      assert.match(body, new RegExp(`\\b${field}\\b`), `PnlCoverageRecoveryAudit must declare ${field}`)
    }
  })

  it('constructs the pnlCoverageRecoveryAudit object with every required field and wires it into the returned snapshot', () => {
    const constructMatch = src.match(/const pnlCoverageRecoveryAudit = \{([\s\S]*?)\n  \}/)
    assert.ok(constructMatch, 'pnlCoverageRecoveryAudit construction must exist')
    const body = constructMatch![1]
    for (const field of requiredFields) {
      assert.match(body, new RegExp(`\\b${field}:`), `pnlCoverageRecoveryAudit construction must set ${field}`)
    }
    assert.match(src, /const snapshot: WalletSnapshot = \{[\s\S]*?\n\s*pnlCoverageRecoveryAudit,\n/, 'pnlCoverageRecoveryAudit must be wired into the returned WalletSnapshot')
  })

  it('the 50% coverage gate threshold used elsewhere in this codebase (fifoEngine) is left untouched', () => {
    assert.match(src, /thresholdReached: _pnlCoverageThresholdReached/)
    assert.match(src, /_pnlCoverageThresholdReached = _pnlCoverageAfter >= 50/)
  })

  it('pnlRecoveryFlowAudit rows carry the compact drop-stage fields', () => {
    for (const field of [
      'token', 'lotCount', 'ranked', 'includedInSharedRequest', 'pagesAvailable',
      'matchingEventsFound', 'entryLotsRecovered', 'exitLotsRecovered',
      'priceRequirements', 'pricesResolved', 'lotsVerified', 'dropStage', 'dropReason',
    ]) {
      assert.match(src, new RegExp(`\\b${field}\\b`), `pnlRecoveryFlowAudit must include ${field}`)
    }
    assert.match(src, /dropStage = 'ranked'/)
    assert.match(src, /dropStage = 'shared_request'/)
    assert.match(src, /token was ranked eligible but its chain was not part of a paid shared GoldRush page/)
  })
})
