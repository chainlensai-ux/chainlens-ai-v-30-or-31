// Robinhood buy/sell simulation must only report "blocked" from the simulator's own result: a successful buy
// followed by a failed sell. Ordinary reverts, failed buys and missing WETH venues are unavailable/unsupported.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeErrorResult, parseAbi } from 'viem'
import {
  decodeRobinhoodSimRevert, simulateRobinhoodHoneypot, clearRobinhoodHoneypotSimCache, ROBINHOOD_SIM_AMOUNT_IN_WEI,
} from '../lib/server/robinhoodHoneypotSimulation.ts'

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const POOL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OTHER_POOL = '0xcccccccccccccccccccccccccccccccccccccccc'
const ERRORS = parseAbi(['error Error(string)', 'error Panic(uint256)'])
const simResult = (tokenGot: bigint, canSell: number, wethBack: bigint, wethIn = ROBINHOOD_SIM_AMOUNT_IN_WEI) =>
  encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }], [tokenGot, canSell, wethBack, wethIn])
const errorString = (msg: string) => encodeErrorResult({ abi: ERRORS, errorName: 'Error', args: [msg] })

/** Mock RPC: the constructor eth_call reverts with `revertHex`; V3 getPool answers `v3Pool`; V2 getPair answers `v2Pair`. */
function rpc(opts: { revertHex: string; v3Pool?: string | null; v2Pair?: string | null }) {
  const calls: string[] = []
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body)
    const call = body.params?.[0] ?? {}
    const data = String(call.data ?? '')
    const ok = (result: unknown) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) })
    if (!call.to) { calls.push('sim'); return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: opts.revertHex } }) } }
    if (data.startsWith('0x1698ee82')) { calls.push('getPool'); return ok(`0x${(opts.v3Pool ?? '0x' + '0'.repeat(40)).slice(2).padStart(64, '0')}`) }
    if (data.startsWith('0xe6a43905')) { calls.push('getPair'); return ok(`0x${(opts.v2Pair ?? '0x' + '0'.repeat(40)).slice(2).padStart(64, '0')}`) }
    return ok(`0x${'0'.repeat(64)}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}
const run = (poolType: string | null, r: ReturnType<typeof rpc>) => simulateRobinhoodHoneypot({
  chainId: 4663, tokenAddress: TOKEN, poolAddress: POOL, poolType, skipCache: true, rpcUrl: 'https://rpc.test', rpcFetch: r.fetchImpl,
})

beforeEach(() => clearRobinhoodHoneypotSimCache())

test('decoder: Error(string) reverts of any length are never a simulation result', () => {
  for (const msg of ['STF', 'UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT', 'TransferHelper: TRANSFER_FROM_FAILED', 'x'.repeat(200)]) {
    assert.equal(decodeRobinhoodSimRevert(errorString(msg)), null, msg)
  }
  assert.equal(decodeRobinhoodSimRevert(encodeErrorResult({ abi: ERRORS, errorName: 'Panic', args: [BigInt(17)] })), null)
})

test('decoder: accepts the exact 4-word result (bare or behind a custom-error selector), rejects malformed shapes', () => {
  const ok = simResult(BigInt(1000), 1, BigInt(9e15))
  assert.deepEqual(decodeRobinhoodSimRevert(ok), { tokenGot: BigInt(1000), canSell: 1, wethBack: BigInt(9e15), wethIn: ROBINHOOD_SIM_AMOUNT_IN_WEI })
  assert.equal(decodeRobinhoodSimRevert(`0xdeadbeef${ok.slice(2)}`)?.canSell, 1)
  assert.equal(decodeRobinhoodSimRevert(`${ok}00`), null, 'wrong length')
  assert.equal(decodeRobinhoodSimRevert(simResult(BigInt(1000), 2, BigInt(1))), null, 'canSell must be 0 or 1')
  assert.equal(decodeRobinhoodSimRevert(simResult(BigInt(1000), 1, BigInt(1), BigInt(0))), null, 'no WETH spent')
  assert.equal(decodeRobinhoodSimRevert(simResult(BigInt(1000), 1, BigInt(1), ROBINHOOD_SIM_AMOUNT_IN_WEI + BigInt(1))), null, 'more WETH than simulated')
  assert.equal(decodeRobinhoodSimRevert('0x'), null)
})

test('a long router revert is unavailable, not a honeypot', async () => {
  const { result, audit } = await run('v2', rpc({ revertHex: errorString('UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT') }))
  assert.equal(result.honeypotStatus, 'unavailable')
  assert.equal(result.sellable, null)
  assert.notEqual(audit.finalStatus, 'blocked')
})

test('a buy that returned no tokens is unavailable (sell never tested), not blocked', async () => {
  const { result } = await run('v2', rpc({ revertHex: simResult(BigInt(0), 0, BigInt(0)) }))
  assert.equal(result.honeypotStatus, 'unavailable')
  assert.match(result.failureReason ?? '', /sell path could not be tested/)
})

test('buy ok + sell failed is still blocked; buy ok + sell ok is still sellable', async () => {
  assert.equal((await run('v2', rpc({ revertHex: simResult(BigInt(1000), 0, BigInt(0)) }))).result.honeypotStatus, 'blocked')
  clearRobinhoodHoneypotSimCache()
  assert.equal((await run('v2', rpc({ revertHex: simResult(BigInt(1000), 1, BigInt(9e15)) }))).result.honeypotStatus, 'sellable')
})

test('V3 pool that is not the token/WETH pool at any fee tier → unsupported, never simulated with a guessed fee', async () => {
  const r = rpc({ revertHex: simResult(BigInt(0), 0, BigInt(0)), v3Pool: OTHER_POOL })
  const { result } = await run('uniswap_v3', r)
  assert.equal(result.honeypotStatus, 'unsupported')
  assert.match(result.failureReason ?? '', /not a token\/WETH pool/)
  assert.equal(r.calls.includes('sim'), false, 'no simulation call is made')
})

test('unknown pool type with no WETH V2 pair and no matching V3 pool → unsupported', async () => {
  const r = rpc({ revertHex: simResult(BigInt(0), 0, BigInt(0)), v3Pool: OTHER_POOL, v2Pair: null })
  const { result } = await run(null, r)
  assert.equal(result.honeypotStatus, 'unsupported')
  assert.equal(r.calls.includes('sim'), false)
})

test('V3 pool that IS the token/WETH pool is simulated at its detected fee', async () => {
  const r = rpc({ revertHex: simResult(BigInt(1000), 1, BigInt(9e15)), v3Pool: POOL })
  const { result } = await run('uniswap_v3', r)
  assert.equal(result.honeypotStatus, 'sellable')
  assert.ok(r.calls.includes('sim'))
})
