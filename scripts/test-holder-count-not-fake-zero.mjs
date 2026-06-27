import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Static source checks on route.ts — DUAL-bug regression: a provider total_count of 0/null
// must never collapse public holderCount to 0 when real holder rows exist.
const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')

// 1. holderCount must no longer be assigned directly from the raw provider variable —
//    it must go through the resolvedHolderCount priority fallback.
assert.ok(route.includes('const resolvedHolderCount: number | null ='), 'resolvedHolderCount priority fallback exists')
assert.ok(!route.includes('holderCount: holderCount ?? null,\n          top1, top5, top10, top20,'), 'sections.holders.holderCount no longer uses the raw provider-only value')

// 2. Priority order: exact provider total (>0) → normalized row count → resolver row count → null.
assert.ok(/holderCount != null && holderCount > 0 \? holderCount\s*\n\s*: normalizedTop\.length > 0 \? normalizedTop\.length\s*\n\s*: holderResolverResult\.holders\.length > 0 \? holderResolverResult\.holders\.length\s*\n\s*: null/.test(route), 'holderCount priority is provider_total > normalized_rows > resolver_rows > null')

// 3. holderCountReason values match the requested taxonomy.
for (const reason of ['holder_count_from_provider_total', 'holder_count_from_normalized_rows', 'holder_count_from_resolver', 'holder_count_unavailable_with_reason']) {
  assert.ok(route.includes(reason), `holderCountReason includes ${reason}`)
}

// 4. holderDistribution and sections.holders both consume the same resolved value/reason —
//    they must never disagree.
assert.ok(route.includes('holderCount: resolvedHolderCount, holderCountReason, topHolders: normalizedTop'), 'holderDistribution (rows present) uses resolvedHolderCount + holderCountReason')
assert.ok(route.includes('holderCount: resolvedHolderCount,\n          holderCountReason,'), 'sections.holders uses resolvedHolderCount + holderCountReason')

// 5. devIntel.holderEvidence.holderCount and holderResolver were already row-count-based —
//    confirm they remain so (no regression introduced elsewhere).
assert.ok(route.includes('holderCount: holderResolverResult.holders.length,'), 'devIntel.holderEvidence.holderCount stays row-count-based')
assert.ok(route.includes("{ holderCount: holderResolverResult.holders.length }"), 'holderResolver.holderCount stays row-count-based')

// 6. aiSummary (via _buildDeterministicSummary) must say "partially indexed" with real holder
//    rows + concentration % when holderDistributionStatus.status === 'partial', never claim
//    holder data is "not indexed" or fall back to the generic inferred-concentration wording.
assert.ok(route.includes("holderDistributionPartial?: boolean"), '_buildDeterministicSummary accepts a holderDistributionPartial flag')
assert.ok(route.includes('Holder distribution is partially indexed: ${holderCount.toLocaleString()} holder rows were returned, with top-10 concentration around ${top10Pct.toFixed(1)}%${riskNote}.'), 'partial-holder branch produces the partially-indexed sentence with row count + top-10 %')
assert.ok(route.includes("', which is a major concentration risk'"), 'high top-10 concentration in the partial-holder branch is still flagged as a major risk')
assert.ok(route.includes('_buildDeterministicSummary(_chainName, noActivePools, hpResult, analysis, holderDataComplete, resolvedHolderCount, top10Pct ?? null, _ownershipStatusFinal, lpPoolType ?? lpVerifyPoolType, lpControl.status, holderDistributionStatus.status === \'partial\')'), 'call site passes resolvedHolderCount + the partial flag, not the raw provider-only holderCount')

console.log('test-holder-count-not-fake-zero.mjs: all assertions passed')
