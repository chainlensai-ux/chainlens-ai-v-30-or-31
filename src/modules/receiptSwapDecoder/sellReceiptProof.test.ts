// Sell receipt proof: token→ETH sells, pool-direct sells, Ethereum pools, and the fail-closed cases.
//   npx tsx --test src/modules/receiptSwapDecoder/sellReceiptProof.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { proveSellFromReceipt, proveSellsFromReceipts } from './sellReceiptProof'
import { createChainPoolValidator, createEthereumDexPoolValidator, type PoolValidator } from './poolValidator'
import { WETH_BASE_ADDRESS, WETH_ETH_ADDRESS } from './signatures'
import { WALLET, ROUTER, POOL_A, POOL_B, TOKEN_X, transferLog, classicSwapLog, classicMintLog, slipstreamSwapLog, wethWithdrawalLog } from './fixtures.test-helpers'
import type { ReceiptFetchOutcome } from './receiptAcquisition'

const WETH = WETH_BASE_ADDRESS.toLowerCase()
const yes: PoolValidator = { isValidPool: async () => true }
const no: PoolValidator = { isValidPool: async () => false }
const AMT = BigInt('1000000000000000000000')
const OUT = BigInt('500000000000000000')
const TX = `0x${'ab'.repeat(32)}`

// Wallet sends TOKEN_X straight to the pool (Permit2 / Universal Router); pool pays WETH to the
// router, which unwraps it and sends ETH to the wallet (invisible: internal transfer).
const tokenToEthSell = () => [
  transferLog(0, TOKEN_X, WALLET, POOL_A, AMT),
  transferLog(1, WETH, POOL_A, ROUTER, OUT),
  classicSwapLog(2, POOL_A, ROUTER, AMT, BigInt(0), BigInt(0), OUT),
  wethWithdrawalLog(3, ROUTER, OUT),
]

describe('proveSellFromReceipt', () => {
  it('proves a token→ETH sell whose ETH proceeds never appear as a wallet transfer', async () => {
    const r = await proveSellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs: tokenToEthSell(), validator: yes })
    assert.deepEqual(r, { proof: 'exact_swap' })
  })
  it('falls back to pool-level proof when the full decode cannot chain the legs', async () => {
    // Two swaps on two pools that do not form one chain → decodeReceiptSwap fails; TOKEN_X still went into a validated pool.
    const logs = [
      transferLog(0, TOKEN_X, WALLET, POOL_A, AMT),
      transferLog(1, WETH, POOL_A, ROUTER, OUT),
      classicSwapLog(2, POOL_A, ROUTER, AMT, BigInt(0), BigInt(0), OUT),
      transferLog(3, '0x6666666666666666666666666666666666666666', ROUTER, POOL_B, BigInt(7)),
      transferLog(4, '0x7777777777777777777777777777777777777777', POOL_B, ROUTER, BigInt(9)),
      classicSwapLog(5, POOL_B, ROUTER, BigInt(7), BigInt(0), BigInt(0), BigInt(9)),
    ]
    const r = await proveSellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs, validator: yes })
    assert.ok(r.proof !== null, JSON.stringify(r))
  })
  it('never accepts an unvalidated pool', async () => {
    const r = await proveSellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs: tokenToEthSell(), validator: no })
    assert.deepEqual(r, { proof: null, rejection: 'pool_not_validated' })
  })
  it('never treats an LP deposit as a sell', async () => {
    const logs = [transferLog(0, TOKEN_X, WALLET, POOL_A, AMT), transferLog(1, WETH, WALLET, POOL_A, OUT), classicMintLog(2, POOL_A, ROUTER)]
    const r = await proveSellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs, validator: yes })
    assert.deepEqual(r, { proof: null, rejection: 'lp_add_or_remove' })
  })
  it('an LP operation on an unrelated pool in the same tx does not block the sell', async () => {
    // A vault/bot rebalances a WETH position on POOL_B (Mint + position-NFT transfer) in the tx that sells TOKEN_X on POOL_A.
    const nftMint = { ...transferLog(5, ROUTER, '0x0000000000000000000000000000000000000000', WALLET, BigInt(0)), data: '0x' }
    nftMint.topics = [...nftMint.topics, `0x${'0'.repeat(63)}7`]
    const logs = [...tokenToEthSell(), transferLog(4, WETH, ROUTER, POOL_B, OUT), classicMintLog(6, POOL_B, ROUTER), nftMint]
    const r = await proveSellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs, validator: yes })
    assert.equal(r.proof, 'validated_pool_swap')
  })
  it('a plain transfer (no swap event) is not a sell', async () => {
    const logs = [transferLog(0, TOKEN_X, WALLET, POOL_A, AMT)]
    const r = await proveSellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs, validator: yes })
    assert.deepEqual(r, { proof: null, rejection: 'no_pool_swap_event' })
  })
  it('requires the wallet itself to have sent the token', async () => {
    const logs = tokenToEthSell().map((l, i) => (i === 0 ? transferLog(0, TOKEN_X, ROUTER, POOL_A, AMT) : l))
    const r = await proveSellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs, validator: yes })
    assert.deepEqual(r, { proof: null, rejection: 'wallet_did_not_send_token' })
  })
  it('a decoded swap that sold a different token does not prove this one', async () => {
    // Wallet bought TOKEN_X with WETH: decoded tokenIn is WETH, and the wallet sent WETH, not TOKEN_X.
    const logs = [
      transferLog(0, WETH, WALLET, POOL_A, OUT),
      transferLog(1, TOKEN_X, POOL_A, WALLET, AMT),
      classicSwapLog(2, POOL_A, WALLET, BigInt(0), OUT, AMT, BigInt(0)),
      transferLog(3, TOKEN_X, WALLET, ROUTER, BigInt(1)), // some unrelated TOKEN_X sent elsewhere
    ]
    const r = await proveSellFromReceipt({ chain: 'base', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs, validator: yes })
    assert.equal(r.proof, null)
  })
  it('works on Ethereum with a V3-shaped pool validated by the Uniswap V3 factory', async () => {
    const weth = WETH_ETH_ADDRESS
    const logs = [
      transferLog(0, TOKEN_X, WALLET, POOL_A, AMT),
      transferLog(1, weth, POOL_A, ROUTER, OUT),
      slipstreamSwapLog(2, POOL_A, ROUTER, ROUTER, AMT, -OUT),
      wethWithdrawalLog(3, ROUTER, OUT),
    ]
    const ethValidator = createEthereumDexPoolValidator({
      getV2Pair: async () => null,
      getV3PoolFee: async () => 3000,
      getV3Pool: async (_a, _b, fee) => (fee === 3000 ? POOL_A : null),
    })
    const validator = createChainPoolValidator({ base: no, eth: ethValidator })
    const r = await proveSellFromReceipt({ chain: 'eth', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs, validator })
    assert.ok(r.proof !== null, JSON.stringify(r))
    // Base's validator is never consulted for an Ethereum receipt.
    const wrongChain = await proveSellFromReceipt({ chain: 'eth', txHash: TX, walletAddress: WALLET, token: TOKEN_X, logs, validator: createChainPoolValidator({ base: yes, eth: no }) })
    assert.equal(wrongChain.proof, null)
  })
})

describe('createEthereumDexPoolValidator', () => {
  it('V2-shaped pools must equal UniswapV2Factory.getPair; V3-shaped must equal getPool(fee)', async () => {
    const v = createEthereumDexPoolValidator({ getV2Pair: async () => POOL_A, getV3PoolFee: async () => 500, getV3Pool: async () => POOL_B })
    assert.equal(await v.isValidPool('aerodrome_classic', POOL_A, TOKEN_X, WETH_ETH_ADDRESS), true)
    assert.equal(await v.isValidPool('aerodrome_classic', POOL_B, TOKEN_X, WETH_ETH_ADDRESS), false)
    assert.equal(await v.isValidPool('aerodrome_slipstream', POOL_B, TOKEN_X, WETH_ETH_ADDRESS), true)
    assert.equal(await v.isValidPool('aerodrome_slipstream', POOL_A, TOKEN_X, WETH_ETH_ADDRESS), false)
  })
  it('fails closed when a read throws', async () => {
    const v = createEthereumDexPoolValidator({ getV2Pair: async () => { throw new Error('rpc') }, getV3PoolFee: async () => null, getV3Pool: async () => null })
    assert.equal(await v.isValidPool('aerodrome_classic', POOL_A, TOKEN_X, WETH_ETH_ADDRESS), false)
    assert.equal(await v.isValidPool('aerodrome_slipstream', POOL_A, TOKEN_X, WETH_ETH_ADDRESS), false)
  })
})

describe('proveSellsFromReceipts (lane)', () => {
  const candidate = (txByte: string, chain = 'base', prior = false, ts = '2026-01-01T00:00:00Z') => ({ chain, txHash: `0x${txByte.repeat(32)}`, token: TOKEN_X, timestamp: ts, hasPriorInventory: prior })
  const fetcher = (logs = tokenToEthSell()) => {
    const calls: string[] = []
    const fn = async (chain: string, txHash: string): Promise<ReceiptFetchOutcome> => { calls.push(`${chain}:${txHash}`); return { status: 'ok', logs } }
    return { fn, calls }
  }

  it('returns proven tx keys and an audit; unsupported chains are never fetched', async () => {
    const f = fetcher()
    const out = await proveSellsFromReceipts({ candidates: [candidate('01'), candidate('02', 'arbitrum')], walletAddress: WALLET, fetchReceipt: f.fn, validator: yes })
    assert.deepEqual([...out.provenTxKeys], [`base:0x${'01'.repeat(32)}`])
    assert.equal(out.audit.candidates, 1)
    assert.equal(f.calls.length, 1)
  })
  it('respects its own cap, prior-inventory candidates first', async () => {
    const f = fetcher()
    const out = await proveSellsFromReceipts({ candidates: [candidate('01'), candidate('02', 'base', true)], walletAddress: WALLET, fetchReceipt: f.fn, validator: yes, cap: 1 })
    assert.deepEqual([...out.provenTxKeys], [`base:0x${'02'.repeat(32)}`])
    assert.equal(out.audit.skippedByCap, 1)
  })
  it('stops starting batches once its time budget is spent', async () => {
    const f = fetcher()
    let t = 0
    const out = await proveSellsFromReceipts({ candidates: [candidate('fd')], walletAddress: WALLET, fetchReceipt: f.fn, validator: yes, laneBudgetMs: 10, now: () => (t += 100) })
    assert.equal(out.provenTxKeys.size, 0)
    assert.equal(out.audit.skippedByTimeBudget, 1)
    assert.equal(f.calls.length, 0)
  })
  it('a failed fetch proves nothing', async () => {
    const out = await proveSellsFromReceipts({ candidates: [candidate('fe')], walletAddress: WALLET, fetchReceipt: async () => ({ status: 'timeout' }), validator: yes })
    assert.equal(out.provenTxKeys.size, 0)
    assert.equal(out.audit.fetchFailures, 1)
  })
})

describe('pipeline wiring (source check)', () => {
  it('the lane runs before both sell-timeline passes and feeds every one of them', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const src = readFileSync(path.resolve(__dirname, '../../pipeline/index.ts'), 'utf8')
    const lane = src.indexOf('proveSellsFromReceipts({')
    const preRecovery = src.indexOf('const preRecoverySellTimelineV2 = safeRunSellTimelineV2(')
    const main = src.indexOf('let sellTimelineV2 = safeRunSellTimelineV2(')
    assert.ok(lane > 0 && lane < preRecovery && preRecovery < main)
    assert.equal((src.match(/verifiedSwapTxKeys: sellProofTxKeys,/g) ?? []).length, 2)
    assert.match(src, /verifiedSwapTxKeys: new Set\(\[\.\.\.sellProofTxKeys, \.\.\.shadowExactReceiptSwaps/)
    assert.match(src, /process\.env\.WALLET_SELL_RECEIPT_PROOF !== '0'/)
  })
})
