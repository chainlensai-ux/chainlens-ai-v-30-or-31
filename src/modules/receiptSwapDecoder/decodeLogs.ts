// MODULE — receiptSwapDecoder: raw log decoding.
//
// Pure, offline decoding of a transaction receipt's raw logs into typed intermediate records:
// pool Swap events (Classic + Slipstream), pool Mint/Burn (LP add/remove — used to reject, never
// to build a swap), ERC20 Transfer legs, and WETH Deposit/Withdrawal (native wrap/unwrap). No RPC
// calls here — decodeLogs takes exactly the logs it's given.

import { decodeAbiParameters } from 'viem'
import {
  CLASSIC_SWAP_TOPIC0, CLASSIC_MINT_TOPIC0, CLASSIC_BURN_TOPIC0,
  SLIPSTREAM_SWAP_TOPIC0, SLIPSTREAM_MINT_TOPIC0, SLIPSTREAM_BURN_TOPIC0,
  ERC20_TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, WETH_BASE_ADDRESS,
} from './signatures'
import type { RawReceiptLog, ReceiptSwapProtocol } from './types'

export type DecodedPoolSwap = {
  logIndex: number
  protocol: ReceiptSwapProtocol
  poolAddress: string
  sender: string
  // Signed net flow into the pool, in the pool's own token0/token1 order — positive = pool
  // received, negative = pool paid out. Classic emits amount0In/amount1In/amount0Out/amount1Out
  // separately (always non-negative); normalized to signed net here so both protocols share one
  // shape downstream.
  amount0: bigint
  amount1: bigint
}

export type DecodedPoolLpEvent = { logIndex: number; poolAddress: string; kind: 'mint' | 'burn' }

export type DecodedTransfer = {
  logIndex: number
  token: string
  from: string
  to: string
  value: bigint
}

export type DecodedNativeWrap = { logIndex: number; kind: 'deposit' | 'withdrawal'; account: string; amount: bigint }

export type DecodedLogs = {
  swaps: DecodedPoolSwap[]
  lpEvents: DecodedPoolLpEvent[]
  transfers: DecodedTransfer[]
  nativeWraps: DecodedNativeWrap[]
  malformed: number
}

function topicAddress(topic: string | undefined): string | null {
  if (!topic || topic.length < 42) return null
  return `0x${topic.slice(-40)}`.toLowerCase()
}

export function decodeLogs(logs: RawReceiptLog[]): DecodedLogs {
  const swaps: DecodedPoolSwap[] = []
  const lpEvents: DecodedPoolLpEvent[] = []
  const transfers: DecodedTransfer[] = []
  const nativeWraps: DecodedNativeWrap[] = []
  let malformed = 0

  for (const log of logs) {
    const topic0 = (log.topics[0] ?? '').toLowerCase()
    const address = log.address.toLowerCase()
    try {
      if (topic0 === CLASSIC_SWAP_TOPIC0) {
        const sender = topicAddress(log.topics[1])
        const [amount0In, amount1In, amount0Out, amount1Out] = decodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
          log.data as `0x${string}`,
        ) as [bigint, bigint, bigint, bigint]
        swaps.push({
          logIndex: log.logIndex, protocol: 'aerodrome_classic', poolAddress: address,
          sender: sender ?? '', amount0: amount0In - amount0Out, amount1: amount1In - amount1Out,
        })
      } else if (topic0 === SLIPSTREAM_SWAP_TOPIC0) {
        const sender = topicAddress(log.topics[1])
        const [amount0, amount1] = decodeAbiParameters(
          [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
          log.data as `0x${string}`,
        ) as [bigint, bigint, bigint, bigint, number]
        swaps.push({ logIndex: log.logIndex, protocol: 'aerodrome_slipstream', poolAddress: address, sender: sender ?? '', amount0, amount1 })
      } else if (topic0 === CLASSIC_MINT_TOPIC0 || topic0 === SLIPSTREAM_MINT_TOPIC0) {
        lpEvents.push({ logIndex: log.logIndex, poolAddress: address, kind: 'mint' })
      } else if (topic0 === CLASSIC_BURN_TOPIC0 || topic0 === SLIPSTREAM_BURN_TOPIC0) {
        lpEvents.push({ logIndex: log.logIndex, poolAddress: address, kind: 'burn' })
      } else if (topic0 === ERC20_TRANSFER_TOPIC0) {
        const from = topicAddress(log.topics[1])
        const to = topicAddress(log.topics[2])
        const [value] = decodeAbiParameters([{ type: 'uint256' }], log.data as `0x${string}`) as [bigint]
        if (!from || !to) { malformed += 1; continue }
        transfers.push({ logIndex: log.logIndex, token: address, from, to, value })
      } else if (address === WETH_BASE_ADDRESS.toLowerCase() && topic0 === WETH_DEPOSIT_TOPIC0) {
        const account = topicAddress(log.topics[1])
        const [amount] = decodeAbiParameters([{ type: 'uint256' }], log.data as `0x${string}`) as [bigint]
        if (!account) { malformed += 1; continue }
        nativeWraps.push({ logIndex: log.logIndex, kind: 'deposit', account, amount })
      } else if (address === WETH_BASE_ADDRESS.toLowerCase() && topic0 === WETH_WITHDRAWAL_TOPIC0) {
        const account = topicAddress(log.topics[1])
        const [amount] = decodeAbiParameters([{ type: 'uint256' }], log.data as `0x${string}`) as [bigint]
        if (!account) { malformed += 1; continue }
        nativeWraps.push({ logIndex: log.logIndex, kind: 'withdrawal', account, amount })
      }
    } catch {
      malformed += 1
    }
  }

  return { swaps, lpEvents, transfers, nativeWraps, malformed }
}
