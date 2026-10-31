import assert from 'node:assert/strict'
import test from 'node:test'
import { separablePoolTransfers, swapTokenOut } from '../lib/server/earlyBuyers/mixedSwap'

const enc = (value: bigint) => value.toString(16).padStart(64, '0')
const classic = (amount0Out: bigint, amount1Out: bigint) => `0x${enc(BigInt(0))}${enc(BigInt(0))}${enc(amount0Out)}${enc(amount1Out)}`
const signed = (value: bigint) => {
  const word = value < BigInt(0) ? (BigInt(1) << BigInt(256)) + value : value
  return enc(word)
}
const v3 = (amount0: bigint, amount1: bigint) => `0x${signed(amount0)}${signed(amount1)}${'0'.repeat(64 * 3)}`

test('classic and v3 outs are the single pool payment, never both sides', () => {
  assert.equal(swapTokenOut('v2', classic(BigInt(0), BigInt(1000))), BigInt(1000))
  assert.equal(swapTokenOut('v2', classic(BigInt(5), BigInt(1000))), null)
  assert.equal(swapTokenOut('v3', v3(BigInt(25), -BigInt(1000))), BigInt(1000))
  assert.equal(swapTokenOut('v4', v3(-BigInt(7), -BigInt(1000))), null)
})

test('a mixed receipt keeps only the transfer that matches the swap out', () => {
  const pool = '0x' + '11'.repeat(20)
  const buyer = '0x' + '22'.repeat(20)
  const lp = '0x' + '33'.repeat(20)
  const router = '0x' + '44'.repeat(20)
  const transfers = [
    { from: '0x' + '55'.repeat(20), to: pool, rawAmount: BigInt(10_000), tag: 'mint-in' },
    { from: pool, to: lp, rawAmount: BigInt(100), tag: 'burn' },
    { from: pool, to: router, rawAmount: BigInt(1000), tag: 'swap' },
    { from: router, to: buyer, rawAmount: BigInt(1000), tag: 'hop' },
  ]
  const kept = separablePoolTransfers({ protocol: 'v3', swapDatas: [v3(BigInt(50), -BigInt(1000))], poolSource: pool, transfers })
  assert.ok(kept)
  assert.deepEqual(kept!.map((row) => row.tag), ['mint-in', 'swap', 'hop'])
})

test('equal burn and swap amounts stay unattributed', () => {
  const pool = '0x' + '11'.repeat(20)
  const transfers = [
    { from: pool, to: '0x' + '22'.repeat(20), rawAmount: BigInt(1000) },
    { from: pool, to: '0x' + '33'.repeat(20), rawAmount: BigInt(1000) },
  ]
  assert.equal(separablePoolTransfers({ protocol: 'v2', swapDatas: [classic(BigInt(0), BigInt(1000))], poolSource: pool, transfers }), null)
})

test('split pool outs that sum to the swap are kept; a remainder is not', () => {
  const pool = '0x' + '11'.repeat(20)
  const split = [
    { from: pool, to: '0x' + '22'.repeat(20), rawAmount: BigInt(400) },
    { from: pool, to: '0x' + '33'.repeat(20), rawAmount: BigInt(600) },
  ]
  assert.equal(separablePoolTransfers({ protocol: 'aerodrome_v2', swapDatas: [classic(BigInt(1000), BigInt(0))], poolSource: pool, transfers: split })?.length, 2)
  const remainder = [...split, { from: pool, to: '0x' + '44'.repeat(20), rawAmount: BigInt(50) }]
  assert.equal(separablePoolTransfers({ protocol: 'v2', swapDatas: [classic(BigInt(1000), BigInt(0))], poolSource: pool, transfers: remainder }), null)
})
