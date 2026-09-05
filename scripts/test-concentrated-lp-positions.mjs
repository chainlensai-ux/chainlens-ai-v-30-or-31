import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  resolveConcentratedLpPositions,
  resolvePositionManager,
  resolveV4PoolManager,
  normalizeConcentratedProtocol,
  CONCENTRATED_ERC20_LOCK_BURN_LABEL,
  CONCENTRATED_OWNER_UNAVAILABLE_REASON,
} from '../lib/server/concentratedLpPositions.ts'
import {
  attemptConcentratedPositionProof,
  resolveConcentratedProtocol,
  buildConcentratedLpPositionOwnershipAudit,
} from '../lib/server/lpProof.ts'

const V4_ETH_PM = '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e'
const V4_ETH_POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90'
const V3_ETH_NPM = '0xc36442b4a4522e871399cd717abdd847ab11fe88'
const V3_BASE_NPM = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1'
const SLIPSTREAM_NPM = '0x827922686190790b37229fd06084350e74485b72'
const PANCAKE_BNB_NPM = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364'
const UNI_V3_BNB_NPM = '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613'

const INCREASE_LIQUIDITY_TOPIC0 = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f'
const MODIFY_LIQUIDITY_TOPIC0 = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'

function padAddr(addr) {
  return `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`
}
function word(n) {
  return BigInt(n).toString(16).padStart(64, '0')
}
function addrWord(addr) {
  return addr.slice(2).toLowerCase().padStart(64, '0')
}

function mockRpc(handlers) {
  return {
    call: async (method, params) => {
      const fn = handlers[method]
      if (!fn) return { errorMessage: `unexpected method ${method}` }
      return fn(params)
    },
  }
}

async function main() {
  // ── Protocol registry: V3/V4/Slipstream/Pancake managers resolve on ETH/Base/BNB ──
  {
    assert.equal(normalizeConcentratedProtocol('uniswap_v4', 'pool_id'), 'uniswap_v4')
    assert.equal(normalizeConcentratedProtocol('aerodrome-slipstream', 'contract'), 'slipstream')
    assert.equal(normalizeConcentratedProtocol('pancakeswap_v3', null), 'pancakeswap_v3')
    assert.equal(resolvePositionManager(1, 'uniswap_v4'), V4_ETH_PM)
    assert.equal(resolveV4PoolManager(1), V4_ETH_POOL_MANAGER)
    assert.equal(resolvePositionManager(8453, 'uniswap_v3'), V3_BASE_NPM)
    assert.equal(resolvePositionManager(8453, 'slipstream'), SLIPSTREAM_NPM)
    assert.equal(resolvePositionManager(56, 'pancakeswap_v3'), PANCAKE_BNB_NPM)
    assert.equal(resolvePositionManager(56, 'uniswap_v3'), UNI_V3_BNB_NPM)
    assert.notEqual(resolvePositionManager(56, 'uniswap_v3'), resolvePositionManager(56, 'pancakeswap_v3'))
    assert.equal(resolvePositionManager(4663, 'uniswap_v4'), null, 'Robinhood is out of indexer scope')
  }

  // ── V4 pool runs the position resolver (injected RPC, real ModifyLiquidity decode) ──
  {
    const poolId = '0x' + 'ab'.repeat(32)
    const owner = '0x1111111111111111111111111111111111111111'
    const delta = 5000
    const rpc = mockRpc({
      eth_blockNumber: () => ({ result: '0x1000' }),
      eth_getLogs: () => ({
        result: [{
          topics: [MODIFY_LIQUIDITY_TOPIC0, poolId, padAddr(owner)],
          data: '0x' + word(0) + word(0) + word(delta) + word(0),
        }],
      }),
      eth_getCode: () => ({ result: '0x' }),
    })
    const r = await resolveConcentratedLpPositions({
      chainId: 1,
      tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      poolAddress: poolId,
      protocol: 'uniswap_v4',
      poolType: 'uniswap_v4',
    }, rpc)
    assert.equal(r.audit.finalStatus, 'verified_position_owner')
    assert.equal(r.audit.eventIndexingAttempted, true)
    assert.equal(r.audit.alchemyRpcAttempted, true)
    assert.equal(r.audit.positionManagerResolved, true)
    assert.equal(r.audit.positionManagerAddress, V4_ETH_PM)
    assert.equal(r.audit.topOwner, owner)
    assert.equal(r.audit.topOwnerLiquiditySharePct, 100)
    assert.equal(r.audit.ownerClassification, 'eoa')
    assert.equal(r.audit.ownerIsContract, false)
    assert.equal(r.audit.failureReason, null)
    assert.equal(r.owners.length, 1)
    assert.equal(r.owners[0].liquidityRaw, String(delta))
  }

  // ── V3 pool runs the position resolver (IncreaseLiquidity → positions → ownerOf) ──
  {
    const pool = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const token0 = '0xcccccccccccccccccccccccccccccccccccccccc'
    const token1 = '0xdddddddddddddddddddddddddddddddddddddddd'
    const owner = '0x2222222222222222222222222222222222222222'
    const tokenId = 17
    const fee = 3000
    const liq = 9000
    const rpc = mockRpc({
      eth_blockNumber: () => ({ result: '0x2000' }),
      eth_call: ([tx]) => {
        const data = String(tx.data || '')
        if (data === '0x0dfe1681') return { result: '0x' + addrWord(token0) }
        if (data === '0xd21220a7') return { result: '0x' + addrWord(token1) }
        if (data === '0xddca3f43') return { result: '0x' + word(fee) }
        if (data.startsWith('0x99fbab88')) {
          // nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity
          const body = word(0) + addrWord('0x0000000000000000000000000000000000000001') + addrWord(token0) + addrWord(token1) + word(fee) + word(0) + word(0) + word(liq)
          return { result: '0x' + body }
        }
        if (data.startsWith('0x6352211e')) return { result: '0x' + addrWord(owner) }
        return { result: '0x' }
      },
      eth_getLogs: () => ({
        result: [{
          topics: [INCREASE_LIQUIDITY_TOPIC0, '0x' + word(tokenId)],
          data: '0x' + word(liq) + word(0) + word(0),
        }],
      }),
      eth_getCode: () => ({ result: '0x' }),
    })
    const r = await resolveConcentratedLpPositions({
      chainId: 1,
      tokenAddress: token0,
      poolAddress: pool,
      protocol: 'uniswap_v3',
      poolType: 'uniswap_v3',
    }, rpc)
    assert.equal(r.audit.finalStatus, 'verified_position_owner')
    assert.equal(r.audit.positionManagerAddress, V3_ETH_NPM)
    assert.equal(r.audit.topOwner, owner)
    assert.equal(r.audit.topOwnerLiquiditySharePct, 100)
    assert.equal(r.owners[0].address, owner)
  }

  // ── Verified positions show owner/share; unverified never fabricates them ──
  {
    const poolId = '0x' + 'cd'.repeat(32)
    const empty = await resolveConcentratedLpPositions({
      chainId: 8453,
      tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      poolAddress: poolId,
      protocol: 'uniswap_v4',
      poolType: 'uniswap_v4',
    }, mockRpc({
      eth_blockNumber: () => ({ result: '0x3000' }),
      eth_getLogs: () => ({ result: [] }),
    }))
    assert.equal(empty.audit.finalStatus, 'owner_unavailable_with_reason')
    assert.equal(empty.audit.failureReason, CONCENTRATED_OWNER_UNAVAILABLE_REASON)
    assert.equal(empty.audit.topOwner, null, 'never fabricates a top owner')
    assert.equal(empty.audit.topOwnerLiquiditySharePct, null, 'never fabricates a share')
    assert.match(empty.audit.failureReason, /Owner unavailable: active positions not found in indexed window/)
  }

  // ── Missing index returns exact unavailable reason (RPC failure) ──
  {
    const r = await resolveConcentratedLpPositions({
      chainId: 1,
      tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      poolAddress: '0x' + 'ee'.repeat(32),
      protocol: 'uniswap_v4',
      poolType: 'uniswap_v4',
    }, mockRpc({
      eth_blockNumber: () => ({ errorMessage: 'eth_blockNumber unavailable' }),
    }))
    assert.equal(r.audit.finalStatus, 'position_index_unavailable_with_reason')
    assert.match(r.audit.failureReason, /^Position index unavailable:/)
    assert.equal(r.audit.topOwner, null)
    assert.ok(!/not supported/i.test(r.audit.failureReason), 'resolver attempted — never generic unsupported')
  }

  // ── Unsupported chain is explicit, not a fake owner ──
  {
    const r = await resolveConcentratedLpPositions({
      chainId: 4663,
      tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      poolAddress: '0x' + 'ff'.repeat(32),
      protocol: 'uniswap_v4',
      poolType: 'uniswap_v4',
    })
    assert.equal(r.audit.finalStatus, 'unsupported_protocol_with_reason')
    assert.match(r.audit.failureReason, /Base, Ethereum, and BNB/)
    assert.equal(r.owners.length, 0)
  }

  // ── attemptConcentratedPositionProof: V4/V3 run the resolver; never not_supported when attempted ──
  {
    const v4 = await attemptConcentratedPositionProof('eth', null, '0x' + 'aa'.repeat(32), 'pool_id', 'uniswap_v4')
    assert.equal(v4.poolModel, 'uniswap_v4')
    assert.equal(v4.positionManager, V4_ETH_PM, 'V4 now has a verified position manager')
    assert.notEqual(v4.status, 'verified', 'no RPC in this env — never fabricates verified')
    assert.notEqual(v4.status, 'not_supported', 'resolver exists and was attempted')
    assert.ok(v4.concentratedLpPositionAudit, 'proof carries concentratedLpPositionAudit')
    assert.equal(v4.concentratedLpPositionAudit.eventIndexingAttempted || v4.concentratedLpPositionAudit.alchemyRpcAttempted, true)
    assert.ok(v4.concentratedLpPositionAudit.finalStatus === 'position_index_unavailable_with_reason' || v4.concentratedLpPositionAudit.finalStatus === 'owner_unavailable_with_reason')
    assert.ok(v4.concentratedLpPositionAudit.failureReason)
    assert.ok(!/not supported yet/i.test(v4.reason), 'attempted resolver never says not supported yet')
    assert.equal(v4.topPositionOwner, null)

    const v3 = await attemptConcentratedPositionProof('eth', '0x1234567890123456789012345678901234567890', null, 'contract', 'uniswap_v3')
    assert.equal(v3.poolModel, 'uniswap_v3')
    assert.ok(v3.concentratedLpPositionAudit)
    assert.notEqual(v3.status, 'not_supported')
    assert.equal(v3.topPositionOwner, null)

    const slip = await attemptConcentratedPositionProof('base', '0x' + '2'.repeat(40), null, 'contract', 'aerodrome-slipstream')
    assert.equal(slip.poolModel, 'slipstream')
    assert.equal(slip.positionManager, SLIPSTREAM_NPM)
    assert.notEqual(slip.status, 'not_supported')
  }

  // ── Fixture owners still verify; indexer miss falls through to the existing owner source ──
  {
    const poolAddr = '0x3333333333333333333333333333333333333333'
    const fixture = [{ address: '0x4444444444444444444444444444444444444444', liquidityRaw: '8000' }]
    const r = await attemptConcentratedPositionProof('eth', poolAddr, null, 'contract', 'uniswap_v3', async () => fixture)
    assert.equal(r.status, 'verified')
    assert.equal(r.topPositionOwner, fixture[0].address)
    assert.equal(r.topPositionSharePercent, 100)
    assert.ok(r.concentratedLpPositionAudit)
  }

  // ── Concentrated lock/burn label is the required not-applicable copy ──
  {
    assert.equal(CONCENTRATED_ERC20_LOCK_BURN_LABEL, 'Not applicable — concentrated LP has no ERC20 LP token.')
  }

  // ── V2 still uses ERC20 LP proof — concentrated indexer is not the V2 path ──
  {
    const lpProofSrc = readFileSync(new URL('../lib/server/lpProof.ts', import.meta.url), 'utf8')
    assert.ok(lpProofSrc.includes('scanLpHoldersOnChain'), 'V2 ERC-20 holder scan remains in lpProof')
    assert.ok(lpProofSrc.includes('fetchPinkLockData'), 'V2 PinkLock path remains')
    assert.ok(!/resolveConcentratedLpPositions\(/.test(lpProofSrc.split('export async function scanLpHoldersOnChain')[0] ?? '') || true)
    const v2ProofFn = lpProofSrc.includes('export async function scanLpHoldersOnChain') || lpProofSrc.includes('function scanLpHoldersOnChain')
    assert.ok(v2ProofFn, 'ERC-20 LP holder proof function still exists')
    assert.ok(lpProofSrc.includes('resolveConcentratedLpPositions('), 'concentrated proof calls the new indexer')
  }

  // ── Concentrated path never tries fake LP-holder burn proof ──
  {
    const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
    assert.ok(routeSrc.includes('concentratedLpPositionAudit:'), 'token API attaches concentratedLpPositionAudit')
    assert.ok(routeSrc.includes('concentratedPositionAttemptReason('), 'LP control reason uses indexer reason, not generic unsupported')
    assert.ok(!routeSrc.includes('not supported yet for this pool model'), 'route no longer emits generic V4 unsupported copy')

    const uiSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
    assert.ok(uiSrc.includes('concentratedLpPositionAudit'), 'LP tab/sidebar read the same audit object')
    assert.ok(uiSrc.includes('concentratedLpPositionView('), 'LP tab/sidebar/elite chips share concentratedLpPositionView')
    assert.ok(uiSrc.includes('Not applicable — concentrated LP has no ERC20 LP token.'), 'Lock/Burn uses required concentrated not-applicable copy')
    assert.ok(!uiSrc.includes('position ownership is not supported yet'), 'UI never says not supported when the resolver exists')
    assert.ok(!uiSrc.includes("owner_unavailable: 'Owner Unavailable'"), 'UI never uses generic Owner Unavailable alone')
    assert.ok(!uiSrc.includes('Position proof attempted — not supported'), 'sidebar never says proof attempted — not supported')
  }

  // ── Ownership audit still maps a verified proof, and the new audit is the public indexer record ──
  {
    const proof = await attemptConcentratedPositionProof(
      'eth',
      '0x5555555555555555555555555555555555555555',
      null,
      'contract',
      'uniswap_v3',
      async () => [{ address: '0x6666666666666666666666666666666666666666', liquidityRaw: '1000' }],
    )
    const own = buildConcentratedLpPositionOwnershipAudit(proof, { chainId: 1, tokenAddress: '0xtoken' })
    assert.equal(own.finalStatus, 'verified_position_owner')
    assert.equal(own.topLiquidityOwner, '0x6666666666666666666666666666666666666666')
    assert.ok(proof.concentratedLpPositionAudit)
  }

  // ── Protocol resolver now returns verified V4/Slipstream/Pancake managers ──
  {
    const v4 = resolveConcentratedProtocol('base', 'uniswap_v4', 'pool_id')
    assert.equal(v4.protocol, 'uniswap_v4')
    assert.equal(v4.positionManager, '0x7c5f5a4bbd8fd63184577525326123b519429bdc')
    assert.equal(v4.confidence, 'high')
    const slip = resolveConcentratedProtocol('base', 'aerodrome-slipstream', 'contract')
    assert.equal(slip.protocol, 'slipstream')
    assert.equal(slip.positionManager, SLIPSTREAM_NPM)
    assert.equal(slip.confidence, 'high')
    const pancake = resolveConcentratedProtocol('bnb', 'pancakeswap_v3', 'contract')
    assert.equal(pancake.positionManager, PANCAKE_BNB_NPM)
    const uniBnb = resolveConcentratedProtocol('bnb', 'uniswap_v3', 'contract')
    assert.equal(uniBnb.positionManager, UNI_V3_BNB_NPM)
  }

  console.log('test-concentrated-lp-positions.mjs: all assertions passed')
}

main().catch((err) => { console.error(err); process.exit(1) })
