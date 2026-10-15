// Uniswap V4 sell proof (WALLET_V4_SELL_PROOF=1).
//   npx tsx --test src/modules/receiptSwapDecoder/v4SellReceiptProof.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, pad, toEventSelector } from 'viem'
import { proveV4SellFromReceipt, V4_DONATE_TOPIC0, type V4SellDeps } from './v4SellReceiptProof'
import { proveSellsFromReceipts } from './sellReceiptProof'
import { V4_POOL_MANAGERS, V4_SWAP_TOPIC0, NATIVE_CURRENCY } from '../../lib/v4RouteQuote'
import { transferLog, WALLET, ROUTER, TOKEN_X, USDC } from './fixtures.test-helpers'
import type { RawReceiptLog } from './types'

const MANAGER = V4_POOL_MANAGERS.base!
const POOL_1 = `0x${'01'.repeat(32)}`
const POOL_2 = `0x${'02'.repeat(32)}`
const POOL_OTHER = `0x${'03'.repeat(32)}`
const OTHER = '0x6666666666666666666666666666666666666666'
const AMT = BigInt('1000000000000000000000')
const ETH_OUT = BigInt('500000000000000000')
const USDC_OUT = BigInt('1500000000')
const TX = `0x${'cd'.repeat(32)}`
const MODIFY_LIQUIDITY_TOPIC0 = toEventSelector('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)')

let logIndex = 0
function v4Swap(poolId: string, amount0: bigint, amount1: bigint): RawReceiptLog {
  return {
    logIndex: logIndex++, address: MANAGER, topics: [V4_SWAP_TOPIC0, poolId, pad(ROUTER as `0x${string}`)],
    data: encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      [amount0, amount1, BigInt(1), BigInt(1), 0, 3000],
    ),
  }
}
const transfer = (token: string, from: string, to: string, value: bigint) => ({ ...transferLog(logIndex++, token, from, to, value) })
const modifyLiquidity = (): RawReceiptLog => ({ logIndex: logIndex++, address: MANAGER, topics: [MODIFY_LIQUIDITY_TOPIC0, POOL_1, pad(ROUTER as `0x${string}`)], data: encodeAbiParameters([{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }], [0, 60, BigInt(1), `0x${'00'.repeat(32)}`]) })
const donate = (): RawReceiptLog => ({ logIndex: logIndex++, address: MANAGER, topics: [V4_DONATE_TOPIC0, POOL_1, pad(ROUTER as `0x${string}`)], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(1), BigInt(1)]) })

// Pool currencies (as proven by Initialize): POOL_1 = ETH/TOKEN_X, POOL_2 = ETH/USDC, POOL_OTHER = ETH/OTHER.
const KEYS = new Map([
  [POOL_1, { currency0: NATIVE_CURRENCY, currency1: TOKEN_X }],
  [POOL_2, { currency0: NATIVE_CURRENCY, currency1: USDC }],
  [POOL_OTHER, { currency0: NATIVE_CURRENCY, currency1: OTHER }],
])
const deps = (over: Partial<V4SellDeps> = {}): V4SellDeps => ({
  resolvePoolKeys: async (_chain, ids) => new Map(ids.filter((id) => KEYS.has(id)).map((id) => [id, KEYS.get(id)!])),
  fetchInternalTransfers: async () => [{ from: ROUTER, to: WALLET, valueWei: ETH_OUT.toString() }],
  ...over,
})
const prove = (logs: RawReceiptLog[], d = deps(), token = TOKEN_X) =>
  proveV4SellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token, logs, deps: d })

// TOKEN_X → ETH, wallet pays the PoolManager directly (Permit2); ETH paid out internally.
const directSell = () => [transfer(TOKEN_X, WALLET, MANAGER, AMT), v4Swap(POOL_1, ETH_OUT, -AMT)]

describe('proveV4SellFromReceipt', () => {
  it('direct swap: wallet → PoolManager, native ETH proven by the trace', async () => {
    assert.deepEqual(await prove(directSell()), { proof: 'v4_exact_route' })
  })
  it('router-relayed swap: wallet → router → PoolManager, USDC output routed back to the wallet', async () => {
    const logs = [
      transfer(TOKEN_X, WALLET, ROUTER, AMT), transfer(TOKEN_X, ROUTER, MANAGER, AMT),
      v4Swap(POOL_1, ETH_OUT, -AMT), v4Swap(POOL_2, -ETH_OUT, USDC_OUT),
      transfer(USDC, MANAGER, ROUTER, USDC_OUT), transfer(USDC, ROUTER, WALLET, USDC_OUT),
    ]
    assert.deepEqual(await prove(logs, deps({ fetchInternalTransfers: async () => null })), { proof: 'v4_exact_route' })
  })
  it('liquidity modify in the tx never counts', async () => {
    assert.deepEqual(await prove([...directSell(), modifyLiquidity()]), { proof: null, rejection: 'liquidity_or_donate_in_tx' })
  })
  it('donate in the tx never counts', async () => {
    assert.deepEqual(await prove([...directSell(), donate()]), { proof: null, rejection: 'liquidity_or_donate_in_tx' })
  })
  it('wrong token: the swap input is not the token the wallet sent', async () => {
    const logs = [transfer(TOKEN_X, WALLET, ROUTER, AMT), transfer(OTHER, ROUTER, MANAGER, AMT), v4Swap(POOL_OTHER, ETH_OUT, -AMT)]
    const r = await prove(logs)
    assert.equal(r.proof, null)
  })
  it('multi-hop TOKEN_X → ETH → USDC with USDC to the wallet', async () => {
    const logs = [
      transfer(TOKEN_X, WALLET, MANAGER, AMT),
      v4Swap(POOL_1, ETH_OUT, -AMT), v4Swap(POOL_2, -ETH_OUT, USDC_OUT),
      transfer(USDC, MANAGER, WALLET, USDC_OUT),
    ]
    assert.deepEqual(await prove(logs), { proof: 'v4_exact_route' })
  })

  it('an unproven pool rejects', async () => {
    assert.deepEqual(await prove(directSell(), deps({ resolvePoolKeys: async () => new Map() })), { proof: null, rejection: 'pool_key_unproven' })
  })
  it('a second V4 swap that is not on the route rejects', async () => {
    const r = await prove([...directSell(), v4Swap(POOL_OTHER, -BigInt(5), BigInt(7))])
    assert.deepEqual(r, { proof: null, rejection: 'swap_off_route' })
  })
  it('native ETH payout without a trace rejects; with a trace to someone else rejects', async () => {
    assert.deepEqual(await prove(directSell(), deps({ fetchInternalTransfers: async () => null })), { proof: null, rejection: 'native_payout_unproven' })
    assert.deepEqual(await prove(directSell(), deps({ fetchInternalTransfers: async () => [{ from: ROUTER, to: OTHER, valueWei: ETH_OUT.toString() }] })), { proof: null, rejection: 'native_payout_unproven' })
  })
  it('input that differs from the swapped amount by one unit rejects', async () => {
    const logs = [transfer(TOKEN_X, WALLET, MANAGER, AMT - BigInt(1)), v4Swap(POOL_1, ETH_OUT, -AMT)]
    assert.deepEqual(await prove(logs), { proof: null, rejection: 'input_amount_mismatch' })
  })
  it('token entering the PoolManager from outside the wallet rejects', async () => {
    const logs = [transfer(TOKEN_X, WALLET, ROUTER, BigInt(1)), transfer(TOKEN_X, OTHER, MANAGER, AMT), v4Swap(POOL_1, ETH_OUT, -AMT)]
    assert.deepEqual(await prove(logs), { proof: null, rejection: 'token_not_from_wallet' })
  })
  it('the wallet sending a second token rejects', async () => {
    assert.deepEqual(await prove([...directSell(), transfer(OTHER, WALLET, ROUTER, BigInt(3))]), { proof: null, rejection: 'wallet_sent_other_token' })
  })
  it('a mixed-venue receipt (V3-shaped swap too) rejects', async () => {
    const v3: RawReceiptLog = { logIndex: logIndex++, address: OTHER, topics: [toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)'), pad(ROUTER as `0x${string}`), pad(ROUTER as `0x${string}`)], data: encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [BigInt(1), BigInt(-1), BigInt(1), BigInt(1), 0]) }
    assert.deepEqual(await prove([...directSell(), v3]), { proof: null, rejection: 'mixed_venue' })
  })
  it('native ETH sold: proven only when the wallet sent the tx and its value funds the first hop', async () => {
    const logs = [v4Swap(POOL_1, -ETH_OUT, AMT), transfer(TOKEN_X, MANAGER, WALLET, AMT)]
    const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const ok = await prove(logs, deps({ fetchTxSenderAndValue: async () => ({ from: WALLET, valueWei: ETH_OUT.toString() }) }), native)
    assert.deepEqual(ok, { proof: 'v4_exact_route' })
    const relayed = await prove(logs, deps({ fetchTxSenderAndValue: async () => ({ from: OTHER, valueWei: ETH_OUT.toString() }) }), native)
    assert.deepEqual(relayed, { proof: null, rejection: 'native_input_unproven' })
  })
})

describe('sell-proof lane with V4', () => {
  const candidate = (b: string) => ({ chain: 'base', txHash: `0x${b.repeat(32)}`, token: TOKEN_X, timestamp: '2026-01-01T00:00:00Z', hasPriorInventory: true })
  it('off (no v4 deps): a V4 sell stays unproven', async () => {
    const out = await proveSellsFromReceipts({ candidates: [candidate('e1')], walletAddress: WALLET, fetchReceipt: async () => ({ status: 'ok', logs: directSell() }), validator: { isValidPool: async () => true } })
    assert.equal(out.provenTxKeys.size, 0)
    assert.equal(out.audit.v4Enabled, false)
  })
  it('on: the same receipt is proven as v4_exact_route and labelled by venue', async () => {
    const out = await proveSellsFromReceipts({
      candidates: [candidate('e2')], walletAddress: WALLET, fetchReceipt: async () => ({ status: 'ok', logs: directSell() }),
      validator: { isValidPool: async () => true }, v4: deps(), classifyVenue: async () => 'v4',
    })
    assert.equal(out.audit.proofs.v4_exact_route, 1)
    assert.equal(out.audit.venues.proven.v4, 1)
  })
  it('a rejected V4 receipt is counted under its venue with a v4: reason', async () => {
    const out = await proveSellsFromReceipts({
      candidates: [candidate('e3')], walletAddress: WALLET, fetchReceipt: async () => ({ status: 'ok', logs: [...directSell(), donate()] }),
      validator: { isValidPool: async () => true }, v4: deps(), classifyVenue: async () => 'v4',
    })
    assert.equal(out.audit.venues.rejected.v4, 1)
    assert.equal(out.audit.rejectedSamples[0].rejection, 'v4:liquidity_or_donate_in_tx')
  })
})
