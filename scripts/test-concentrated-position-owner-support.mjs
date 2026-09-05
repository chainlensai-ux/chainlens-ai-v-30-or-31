import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  attemptConcentratedPositionProof,
  buildConcentratedLpPositionAudit,
} from '../lib/server/lpProof.ts'

const POOL = '0x1111111111111111111111111111111111111111'
const OWNER = '0x2222222222222222222222222222222222222222'

async function main() {
  for (const [chain, model, dex] of [
    ['eth', 'uniswap_v3', 'uniswap_v3'],
    ['bnb', 'pancakeswap_v3', 'pancakeswap_v3'],
    ['base', 'slipstream', 'aerodrome-slipstream'],
  ]) {
    let attempted = false
    const proof = await attemptConcentratedPositionProof(chain, POOL, null, 'contract', dex, async (input) => {
      attempted = true
      assert.equal(input.poolModel, model)
      return {
        records: [{ address: OWNER, liquidityRaw: '800', positionCount: 2 }],
        attempted: true,
        providerUsed: `fixture_${model}`,
        positionsFound: 2,
        activePositionsFound: 2,
        failureReason: null,
      }
    })
    assert.equal(attempted, true, `${model} attempts position ownership`)
    assert.equal(proof.status, 'verified')
    const audit = buildConcentratedLpPositionAudit(proof, { chainId: chain === 'eth' ? 1 : chain === 'base' ? 8453 : 56, tokenAddress: '0xtoken' })
    assert.equal(audit.finalStatus, 'verified_position_owner')
    assert.equal(audit.topOwner, OWNER)
    assert.equal(audit.topOwnerLiquiditySharePct, 100)
    assert.equal(audit.providerUsed, `fixture_${model}`)
  }

  const poolId = `0x${'a'.repeat(64)}`
  const unavailable = await attemptConcentratedPositionProof('base', null, poolId, 'pool_id', 'uniswap_v4', async () => ({
    records: null,
    attempted: true,
    providerUsed: 'fixture_v4_indexer',
    positionsFound: null,
    activePositionsFound: null,
    failureReason: 'Indexer returned HTTP 503.',
  }))
  const unavailableAudit = buildConcentratedLpPositionAudit(unavailable, { chainId: 8453, tokenAddress: '0xtoken' })
  assert.equal(unavailable.positionLookupAttempted, true, 'V4 attempts position ownership')
  assert.equal(unavailableAudit.finalStatus, 'unsupported_with_reason')
  assert.match(unavailableAudit.failureReason, /HTTP 503/)
  assert.equal(unavailableAudit.topOwner, null, 'unavailable proof never fabricates an owner')
  assert.equal(unavailableAudit.topOwnerLiquiditySharePct, null, 'unavailable proof never fabricates a share')

  const zeroPool = '0x3333333333333333333333333333333333333333'
  const zeroRows = await attemptConcentratedPositionProof('eth', zeroPool, null, 'contract', 'uniswap_v3', async () => ({
    records: [], attempted: true, providerUsed: 'fixture_indexer', positionsFound: 0,
    activePositionsFound: 0, failureReason: 'Indexer returned no active positions.',
  }))
  const zeroAudit = buildConcentratedLpPositionAudit(zeroRows, { chainId: 1, tokenAddress: '0xtoken' })
  assert.equal(zeroAudit.finalStatus, 'owner_unavailable_with_reason')
  assert.match(zeroAudit.failureReason, /no active positions/i)

  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.ok(route.includes('concentratedLpPositionAudit: buildConcentratedLpPositionAudit('))
  assert.ok(route.includes('lpPool?.poolId ? "pool_id"'), 'V4 pool ID overrides singleton address')
  const ui = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.ok(ui.includes('concentratedLpPositionView') || ui.includes('concentratedLpPositionAudit'), 'UI reads the concentrated position audit')
  assert.ok(ui.includes('result.concentratedLpPositionAudit') && ui.includes('result.concentratedLpPositionOwnershipAudit'))
  assert.ok(ui.includes('Owner unavailable: active positions not found in indexed window') || ui.includes('Position index unavailable'))
  assert.ok(!ui.includes("value: 'Owner Unavailable'"), 'UI does not render a vague owner-unavailable value')
  const v4Rpc = readFileSync(new URL('../lib/server/uniswapV4BaseRpc.ts', import.meta.url), 'utf8')
  assert.ok(v4Rpc.includes('ModifyLiquidity sender is not proof of the beneficial position owner'))
  assert.ok(v4Rpc.includes('records: null'), 'V4 modifier logs are not promoted into owner records')

  console.log('test-concentrated-position-owner-support.mjs: all assertions passed')
}

await main()
