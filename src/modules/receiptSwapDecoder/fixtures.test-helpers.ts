// Test-only helpers for building raw receipt logs. Not imported by any production module.
import { encodeAbiParameters, pad } from 'viem'
import {
  CLASSIC_SWAP_TOPIC0, CLASSIC_MINT_TOPIC0, CLASSIC_BURN_TOPIC0,
  SLIPSTREAM_SWAP_TOPIC0,
  ERC20_TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, WETH_BASE_ADDRESS,
} from './signatures'
import type { RawReceiptLog } from './types'

export const WALLET = '0x1111111111111111111111111111111111111111'
export const ROUTER = '0x2222222222222222222222222222222222222222'
export const POOL_A = '0x3333333333333333333333333333333333333333'
export const POOL_B = '0x4444444444444444444444444444444444444444'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase()
export const TOKEN_X = '0x5555555555555555555555555555555555555555'
export const ZERO = '0x0000000000000000000000000000000000000000'

function topic(address: string): string {
  return pad(address as `0x${string}`).toLowerCase()
}

export function transferLog(logIndex: number, token: string, from: string, to: string, value: bigint): RawReceiptLog {
  return {
    logIndex,
    address: token.toLowerCase(),
    topics: [ERC20_TRANSFER_TOPIC0, topic(from), topic(to)],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  }
}

export function classicSwapLog(logIndex: number, pool: string, sender: string, amount0In: bigint, amount1In: bigint, amount0Out: bigint, amount1Out: bigint): RawReceiptLog {
  return {
    logIndex,
    address: pool.toLowerCase(),
    topics: [CLASSIC_SWAP_TOPIC0, topic(sender), topic(sender)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [amount0In, amount1In, amount0Out, amount1Out],
    ),
  }
}

export function slipstreamSwapLog(logIndex: number, pool: string, sender: string, recipient: string, amount0: bigint, amount1: bigint): RawReceiptLog {
  return {
    logIndex,
    address: pool.toLowerCase(),
    topics: [SLIPSTREAM_SWAP_TOPIC0, topic(sender), topic(recipient)],
    data: encodeAbiParameters(
      [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
      [amount0, amount1, BigInt("0"), BigInt("0"), 0],
    ),
  }
}

export function classicMintLog(logIndex: number, pool: string, sender: string): RawReceiptLog {
  return {
    logIndex, address: pool.toLowerCase(), topics: [CLASSIC_MINT_TOPIC0, topic(sender)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt("1"), BigInt("1")]),
  }
}

export function classicBurnLog(logIndex: number, pool: string, sender: string): RawReceiptLog {
  return {
    logIndex, address: pool.toLowerCase(), topics: [CLASSIC_BURN_TOPIC0, topic(sender), topic(sender)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt("1"), BigInt("1")]),
  }
}

export function wethDepositLog(logIndex: number, account: string, amount: bigint): RawReceiptLog {
  return {
    logIndex, address: WETH_BASE_ADDRESS.toLowerCase(), topics: [WETH_DEPOSIT_TOPIC0, topic(account)],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  }
}

export function wethWithdrawalLog(logIndex: number, account: string, amount: bigint): RawReceiptLog {
  return {
    logIndex, address: WETH_BASE_ADDRESS.toLowerCase(), topics: [WETH_WITHDRAWAL_TOPIC0, topic(account)],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  }
}

export function alwaysValidValidator() {
  return { async isValidPool() { return true } }
}

export function neverValidValidator() {
  return { async isValidPool() { return false } }
}
