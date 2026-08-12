import assert from 'node:assert/strict'
import { fetchGoldRushConcentration, fetchGoldRushHolderCount } from '../lib/server/goldrushHolderCount.ts'
import { resolveBaseRadarHolderConcentration } from '../lib/server/baseRadarHolderConcentration.ts'
import { buildBaseRadarHolderEvidence, holderEvidenceBlocksTopTier } from '../lib/baseRadarHolderEvidence.ts'

const originalFetch = globalThis.fetch
const originalApiKey = process.env.GOLDRUSH_API_KEY
const originalCovalentKey = process.env.COVALENT_API_KEY

function restore() {
  globalThis.fetch = originalFetch
  if (originalApiKey == null) delete process.env.GOLDRUSH_API_KEY; else process.env.GOLDRUSH_API_KEY = originalApiKey
  if (originalCovalentKey == null) delete process.env.COVALENT_API_KEY; else process.env.COVALENT_API_KEY = originalCovalentKey
}

// A base-unit-consistent GoldRush token_holders_v2-shaped response: balances and total_supply are
// always read from the SAME response, so they're always in the same units regardless of what those
// units represent (18-decimal wei, 6-decimal USDC-style, or already-human-formatted integers) — this
// is the actual property the percent math relies on, not "decimals" as a separate normalization step.
function goldrushResponse(rows, totalSupply) {
  return {
    data: {
      items: rows.map(([address, balance]) => ({ address, balance: String(balance), total_supply: String(totalSupply) })),
    },
  }
}

function mockFetchOnce(jsonBody, ok = true, status = 200) {
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
  })
}

async function run() {
  process.env.GOLDRUSH_API_KEY = 'test-key'

  // 1. GoldRush/Covalent holder response calculates Top 1 / Top 10 / Top 20 correctly.
  //    20 holders total; sorted descending by balance: [100k, 50k x8, 35k x10, 0] against a
  //    1,000,000 total supply. Expected (hand-verified against that sorted order):
  //      top1  = 100k / 1,000,000                                    = 10%
  //      top10 = (100k + 8*50k + 35k) / 1,000,000  = 535,000/1,000,000 = 53.5%
  //      top20 = sum of all 20 rows (850,000) / 1,000,000            = 85%
  {
    const totalSupply = 1_000_000n
    const rows = []
    rows.push(['0xh0', 100_000n])
    for (let i = 1; i <= 8; i++) rows.push([`0xh${i}`, 50_000n])
    rows.push(['0xh9', 0n])
    for (let i = 10; i <= 19; i++) rows.push([`0xh${i}`, 35_000n])
    mockFetchOnce(goldrushResponse(rows, totalSupply))
    const result = await fetchGoldRushConcentration('0xTOP1TEST0000000000000000000000000001', 'base')
    assert.equal(result.reason, 'ok')
    assert.equal(result.totalSupplySource, 'goldrush')
    assert.ok(Math.abs(result.top1 - 10) < 0.01, `top1 expected ~10, got ${result.top1}`)
    assert.ok(Math.abs(result.top10 - 53.5) < 0.01, `top10 expected ~53.5, got ${result.top10}`)
    assert.ok(Math.abs(result.top20 - 85) < 0.01, `top20 expected ~85, got ${result.top20}`)
  }

  // 2. Decimals are irrelevant to the ratio — the same ownership shape produces the same percentages
  // whether the underlying raw units imply 18 decimals or 6 decimals, since balance and total_supply
  // are always read from the same response in the same units. No explicit decimals value is ever
  // read or applied.
  {
    const scenarios = [
      { totalSupply: 10n ** 18n, top1Balance: 10n ** 17n }, // 18-decimal-style: 10%
      { totalSupply: 10n ** 6n, top1Balance: 10n ** 5n },   // 6-decimal-style: 10%
      { totalSupply: 100n, top1Balance: 10n },              // already-"formatted" integers: 10%
    ]
    for (const [idx, scenario] of scenarios.entries()) {
      // The remainder is split into 10 equal buckets, each necessarily smaller than the "top"
      // balance (10% each vs. the top holder's 10%... to keep '0xtop' strictly the largest single
      // row, split into 12 buckets of 7.5% each instead, all below the top holder's 10%).
      const remainder = scenario.totalSupply - scenario.top1Balance
      const bucketCount = 12n
      const bucket = remainder / bucketCount
      const rows = [['0xtop', scenario.top1Balance]]
      for (let b = 0n; b < bucketCount; b++) rows.push([`0xrest${b}`, bucket])
      mockFetchOnce(goldrushResponse(rows, scenario.totalSupply))
      const result = await fetchGoldRushConcentration(`0xDECIMALSTEST${idx}00000000000000000000`.slice(0, 42), 'base')
      assert.equal(result.reason, 'ok')
      assert.ok(Math.abs(result.top1 - 10) < 0.01, `scenario ${idx}: expected top1 ~10, got ${result.top1}`)
    }
  }

  // 3. Already-formatted balances are not double-divided: a naive decimal-normalization bug would
  // divide balance by 10^decimals a second time even when the response is already in consistent
  // units, silently producing a near-zero percentage. Confirms that never happens here.
  {
    const rows = [['0xtop', 25n], ['0xrest1', 25n], ['0xrest2', 25n], ['0xrest3', 25n]]
    mockFetchOnce(goldrushResponse(rows, 100n))
    const result = await fetchGoldRushConcentration('0xDOUBLEDIVIDETEST00000000000000000000', 'base')
    assert.equal(result.reason, 'ok')
    assert.ok(Math.abs(result.top1 - 25) < 0.01, `expected exactly 25%, got ${result.top1} (double-division would give ~0)`)
  }

  // 4. Missing GoldRush key does not crash — resolves gracefully to reason:'no_api_key'.
  {
    delete process.env.GOLDRUSH_API_KEY
    delete process.env.COVALENT_API_KEY
    const countResult = await fetchGoldRushHolderCount('0xNOKEYTEST000000000000000000000000000', 'base')
    assert.equal(countResult.reason, 'no_api_key')
    const concResult = await fetchGoldRushConcentration('0xNOKEYTEST200000000000000000000000000', 'base')
    assert.equal(concResult.reason, 'no_api_key')
    assert.equal(concResult.top1, null)
    process.env.GOLDRUSH_API_KEY = 'test-key'
  }

  // 5. GoldRush failure (HTTP error) does not throw — resolves to a real failure reason, never removes
  // the candidate (that's enforced by the caller in app/api/radar/route.ts wrapping this in try/catch
  // and never dropping the token; this confirms the underlying call itself fails soft, not hard).
  {
    mockFetchOnce({}, false, 500)
    const result = await fetchGoldRushConcentration('0xHTTPFAILTEST00000000000000000000000', 'base')
    assert.equal(result.reason, 'http_error')
    assert.equal(result.top1, null)
  }

  // 6. Minimum-only count (e.g. "100+") never creates concentration — concentration must come from
  // real resolved balances, never inferred from the count itself.
  {
    const evidence = buildBaseRadarHolderEvidence({ holderCount: 100, countIsMinimum: true, holderProviderReachable: true })
    assert.equal(evidence.holderCountStatus, 'minimum')
    assert.equal(evidence.concentrationStatus, 'unavailable')
    assert.equal(evidence.top1Percent, undefined)
    assert.equal(evidence.top10Percent, undefined)
    assert.equal(evidence.top20Percent, undefined)
  }

  // 7. No SAFE/Strong/Verified (top-tier severity) from minimum-only holder evidence, even when a
  // minimum count is real and passes the gate.
  {
    const evidence = buildBaseRadarHolderEvidence({ holderCount: 500, countIsMinimum: true, holderProviderReachable: true })
    assert.equal(evidence.holderGatePassed, true)
    assert.equal(holderEvidenceBlocksTopTier(evidence), true)
  }

  // 8. Resolved concentration displays real Top 1/10/20 end to end via resolveBaseRadarHolderConcentration,
  // with a known holder count passed through (skips the redundant count-only call) and the concentration
  // provider correctly labeled 'goldrush'.
  {
    const rows = [['0xtop', 30_000n], ['0xrest1', 23_333n], ['0xrest2', 23_333n], ['0xrest3', 23_334n]]
    mockFetchOnce(goldrushResponse(rows, 100_000n))
    const resolved = await resolveBaseRadarHolderConcentration({
      chain: 'base',
      tokenAddress: '0xE2ETEST0000000000000000000000000000001',
      knownHolderCount: { count: 45, isMinimum: false },
    })
    assert.equal(resolved.holderCountStatus, 'exact')
    assert.equal(resolved.holderCountExact, 45)
    assert.equal(resolved.holderVerified, true)
    assert.equal(resolved.concentrationStatus, 'resolved')
    assert.equal(resolved.concentrationProvider, 'goldrush')
    assert.ok(Math.abs(resolved.top1Percent - 30) < 0.01)
    assert.equal(holderEvidenceBlocksTopTier(resolved), false)
  }

  console.log('test-base-radar-holder-concentration.mjs: all assertions passed')
}

run().then(restore, (err) => { restore(); throw err })
