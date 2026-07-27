import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, toBytes } from 'viem'
import {
  CLASSIC_SWAP_TOPIC0,
  CLASSIC_MINT_TOPIC0,
  CLASSIC_BURN_TOPIC0,
  SLIPSTREAM_SWAP_TOPIC0,
  SLIPSTREAM_MINT_TOPIC0,
  SLIPSTREAM_BURN_TOPIC0,
  ERC20_TRANSFER_TOPIC0,
  WETH_DEPOSIT_TOPIC0,
  WETH_WITHDRAWAL_TOPIC0,
} from './signatures'

// Self-verification: recompute every topic0 constant directly from its Solidity event signature
// string, independent of the hardcoded value in signatures.ts. A transcription error in the
// constant fails this test loudly instead of silently mis-decoding real logs.
test('signatures — every topic0 constant matches keccak256 of its real event signature', () => {
  const cases: Array<[string, string]> = [
    ['Swap(address,uint256,uint256,uint256,uint256,address)', CLASSIC_SWAP_TOPIC0],
    ['Mint(address,uint256,uint256)', CLASSIC_MINT_TOPIC0],
    ['Burn(address,uint256,uint256,address)', CLASSIC_BURN_TOPIC0],
    ['Swap(address,address,int256,int256,uint160,uint128,int24)', SLIPSTREAM_SWAP_TOPIC0],
    ['Mint(address,address,int24,int24,uint128,uint256,uint256)', SLIPSTREAM_MINT_TOPIC0],
    ['Burn(address,int24,int24,uint128,uint256,uint256)', SLIPSTREAM_BURN_TOPIC0],
    ['Transfer(address,address,uint256)', ERC20_TRANSFER_TOPIC0],
    ['Deposit(address,uint256)', WETH_DEPOSIT_TOPIC0],
    ['Withdrawal(address,uint256)', WETH_WITHDRAWAL_TOPIC0],
  ]
  for (const [signature, expected] of cases) {
    assert.equal(keccak256(toBytes(signature)), expected, `mismatch for ${signature}`)
  }
})

test('signatures — Classic and Slipstream Swap topics are distinct', () => {
  assert.notEqual(CLASSIC_SWAP_TOPIC0, SLIPSTREAM_SWAP_TOPIC0)
})
