/**
 * Stage-1 wiring static checks — prove route/providerMerge/UI call the annotator
 * without inventing Top-N / risk changes.
 * Run: npx tsx --test lib/liquidityCustody.wiring.staticCheck.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const route = readFileSync(join(root, 'app/api/token/route.ts'), 'utf8')
const merge = readFileSync(join(root, 'lib/server/solana/providerMerge.ts'), 'utf8')
const page = readFileSync(join(root, 'app/terminal/token-scanner/page.tsx'), 'utf8')
const schema = readFileSync(join(root, 'lib/server/tokenPublicResponse.ts'), 'utf8')

describe('Stage-1 liquidity-custody wiring', () => {
  it('EVM route imports annotator and applies it only on full-scan EVM chains', () => {
    assert.match(route, /from '@\/lib\/liquidityCustody'/)
    assert.match(route, /buildEvmCustodyCandidates/)
    assert.match(route, /annotateLiquidityCustody/)
    assert.match(route, /chain === 'eth' \|\| chain === 'base' \|\| chain === 'bnb' \|\| chain === 'robinhood'/)
    assert.doesNotMatch(route, /buildEvmCustodyCandidates\(\{[\s\S]*chain:\s*'polygon'/)
    assert.match(route, /\.\.\.\(liquidityCustody \? \{ liquidityCustody \} : \{\}\)/)
  })

  it('Solana providerMerge annotates only verified vaults from clusterMap', () => {
    assert.match(merge, /verifiedVaultsFromSolanaClusterMap/)
    assert.match(merge, /buildSolanaCustodyCandidates/)
    assert.match(merge, /annotateLiquidityCustody/)
    assert.match(merge, /Owner field alone is never vault proof/)
  })

  it('Holder Map UI labels custody and distinguishes protocol custody', () => {
    assert.match(page, /function custodyBadge/)
    assert.match(page, /PROTOCOL CUSTODY/)
    assert.match(page, /LIQUIDITY CUSTODY/)
    assert.match(page, /coverage incomplete/)
  })

  it('response schema stays at v8 — additive optional custody fields do not require a bump', () => {
    // Optional liquidityCustody / classification are ignored by older clients; UI uses optional
    // chaining. Bumping would only force cache misses without preventing incorrect renders.
    assert.match(schema, /TOKEN_SCAN_RESPONSE_SCHEMA_VERSION = 8/)
    assert.doesNotMatch(schema, /TOKEN_SCAN_RESPONSE_SCHEMA_VERSION = 9/)
  })

  it('does not rewrite Top-N / risk / Dev Control formulas in the annotator path', () => {
    // Annotator block must not assign top1/top10/riskScore
    const start = route.indexOf('STAGE-1 LIQUIDITY CUSTODY')
    assert.ok(start > 0)
    const block = route.slice(start, start + 2500)
    assert.doesNotMatch(block, /top1\s*=/)
    assert.doesNotMatch(block, /riskScore\s*=/)
    assert.doesNotMatch(block, /calculateTokenRiskScore/)
  })
})


describe('Stage-2 ordinary concentration wiring', () => {
  it('EVM route computes ordinary series after Stage-1 without rewriting legacy tops/risk', () => {
    assert.match(route, /computeOrdinaryConcentration/)
    assert.match(route, /STAGE-2 ORDINARY CONCENTRATION/)
    assert.match(route, /ordinaryTop10: ordinarySeries\.ordinaryTop10/)
    assert.match(route, /ordinaryCoverage: ordinarySeries\.ordinaryCoverage/)
    const start = route.indexOf('STAGE-2 ORDINARY CONCENTRATION')
    assert.ok(start > 0)
    const block = route.slice(start, start + 2200)
    assert.doesNotMatch(block, /top1:\s*ordinarySeries/)
    assert.doesNotMatch(block, /riskScore\s*=/)
    assert.doesNotMatch(block, /calculateTokenRiskScore/)
    assert.doesNotMatch(block, /devControl/)
  })

  it('Solana providerMerge gates ordinary series on verified vault evidence', () => {
    assert.match(merge, /computeOrdinaryConcentration/)
    assert.match(merge, /custodyEvidenceAvailable:\s*vaults\.length > 0/)
    assert.match(merge, /ordinaryTop10Percent: ordinarySeries\.ordinaryTop10/)
  })

  it('Holder Map shows Total supply Top 10 and Ordinary Top 10 coverage messaging', () => {
    assert.match(page, /Total supply Top 10/)
    assert.match(page, /Ordinary Top 10/)
    assert.match(page, /Ordinary concentration unavailable/)
    assert.match(page, /Partial coverage/)
    assert.match(page, /Liquidity custody/)
  })
})

console.log('liquidityCustody.wiring.staticCheck.test.ts: registered')
