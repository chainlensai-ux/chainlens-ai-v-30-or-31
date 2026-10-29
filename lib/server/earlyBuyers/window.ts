import { toEventSelector } from 'viem'
import { V4_SWAP_TOPIC0 } from '../../v4SwapCandles'
import { MODIFY_LIQUIDITY_TOPIC0 } from '../uniswapV4BaseRpc'
import { V4_SWAP_CHAIN_CONFIG } from '../v4SwapCandlesRpc'
import { deriveBuyFacts, isAddress, PUBLIC_CALL_TARGETS } from './classify'
import type { EarlyBuyerChain, BuyFact, Transfer, WindowExamined } from './types'
import type { EarlyBuyerRpc } from './rpc'
import { EarlyBuyerRpcError } from './rpc'
import type { LaunchProof } from './launch'

type RpcLog = { address?: string; topics?: string[]; data?: string; blockNumber?: string; transactionHash?: string; logIndex?: string; removed?: boolean }
type RpcReceipt = { transactionHash?: string; from?: string; to?: string | null; blockNumber?: string; transactionIndex?: string; status?: string; logs?: RpcLog[] }
const hex = (n: number) => `0x${n.toString(16)}`
const asInt = (s: unknown): number | null => typeof s === 'string' && /^0x[0-9a-f]+$/i.test(s) ? Number(BigInt(s)) : null
const transferTopic = toEventSelector('Transfer(address,address,uint256)')
const v2Swap = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
const v3Swap = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)')
// Aerodrome Classic is a Solidly pool. Both sender and recipient are indexed, unlike Uniswap V2.
// Slipstream uses the Uniswap V3 swap layout and is selected by protocol below.
const aeroSwap = toEventSelector('Swap(address,address,uint256,uint256,uint256,uint256)')
// DEGEN's first observed swap was 33 blocks after liquidity. PEPE's was 67 blocks later.
// The search stops at this cap and stays partial if trading has not started.
const SWAP_LOOKAHEAD_BLOCKS = 90
// eth_getBlockReceipts is billed at 20 CU but weighs 500 throughput CU against the provider's
// per-second rate limit, and returns every receipt in the block. Busiest blocks get block receipts
// first, up to the throughput cap; the rest are read with eth_getTransactionReceipt, unless those
// extra calls would no longer fit the per-analysis call budget (then block receipts continue and the
// overrun is reported, rather than turning a complete window partial). Oversized bodies are
// rejected and the block's swaps are read individually.
export const BLOCK_RECEIPTS_THROUGHPUT_CU = 500
export const BLOCK_RECEIPTS_THROUGHPUT_CAP = 4_000
export const BLOCK_RECEIPTS_MAX_RESPONSE_BYTES = 2_500_000
// Calls kept free after receipts: finality header, holdings eth_call, creator distributions.
const CALLS_RESERVED_AFTER_RECEIPTS = 3

/** Blocks to read with eth_getBlockReceipts. Pure; exported for tests. */
export function planBlockReceipts(groups: Array<[number, number]>, callsLeft: number): Set<number> {
  const multi = groups.filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const plan = new Set<number>()
  for (const [block] of multi) if ((plan.size + 1) * BLOCK_RECEIPTS_THROUGHPUT_CU <= BLOCK_RECEIPTS_THROUGHPUT_CAP) plan.add(block)
  // Receipt calls + one timestamp header per block + reserve must fit what is left of the call budget.
  const projected = () => groups.reduce((sum, [block, n]) => sum + (plan.has(block) ? 1 : n), 0) + groups.length + CALLS_RESERVED_AFTER_RECEIPTS
  for (const [block] of multi) { if (projected() <= callsLeft) break; plan.add(block) }
  return plan
}
const liquidityEvents = new Set([
  toEventSelector('Mint(address,uint256,uint256)'),
  toEventSelector('Burn(address,uint256,uint256,address)'),
  toEventSelector('Mint(address,address,int24,int24,uint128,uint256,uint256)'),
  toEventSelector('Burn(address,int24,int24,uint128,uint256,uint256)'),
  MODIFY_LIQUIDITY_TOPIC0,
])
const topicAddress = (s: string | undefined): string | null => typeof s === 'string' && /^0x[0-9a-f]{64}$/i.test(s) ? `0x${s.slice(-40).toLowerCase()}` : null
const TX = /^0x[0-9a-f]{64}$/i

export function earlyWindowEnd(chain: EarlyBuyerChain, launchBlock: number): number { return launchBlock + (chain === 'base' ? 19 : 4) }

function transferFromLog(log: RpcLog, token: string, txHash: string, block: number): Transfer | null {
  if (log.removed || log.address?.toLowerCase() !== token || log.topics?.[0]?.toLowerCase() !== transferTopic || typeof log.data !== 'string') return null
  const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2])
  if (!from || !to || !/^0x[0-9a-f]{64}$/i.test(log.data)) return null
  const rawAmount = BigInt(log.data)
  return rawAmount > BigInt(0) ? { from, to, rawAmount, txHash, block, logIndex: asInt(log.logIndex) ?? undefined } : null
}

export type WindowRead = {
  facts: BuyFact[]
  distributions: Array<{ wallet: string; rawAmount: string; txHash: string }>
  /** Nominal window: swap logs were requested for every block in [startBlock, endBlock]. */
  startBlock: number
  endBlock: number
  /** Receipts actually inspected inside the nominal window. */
  examined: WindowExamined
  pools: string[]
  capped: boolean
  reasons: string[]
  blockReceiptCalls: number
  /** Throughput CU of the eth_getBlockReceipts calls only (rate-limit weight, not billing). */
  blockReceiptThroughputCu: number
}

export async function readEarlyWindow(input: {
  rpc: EarlyBuyerRpc
  chain: EarlyBuyerChain
  token: string
  launches: LaunchProof[]
  deployer?: string | null
  infrastructure?: string[]
}): Promise<WindowRead> {
  const token = input.token.toLowerCase()
  const launches = input.launches.filter((l) => l.block != null && l.pool && l.protocol).slice(0, 3)
  const launchBlock = Math.min(...launches.map((l) => l.block!))
  let windowStart = launchBlock
  let endBlock = earlyWindowEnd(input.chain, windowStart)
  const pools = launches.map((l) => l.pool!)
  const reasons: string[] = []
  const hardStop = (error: unknown): string | null => {
    if (error instanceof EarlyBuyerRpcError && (error.reason === 'estimated_cu_budget_exceeded' || error.reason === 'call_count_budget_exceeded' || error.reason === 'deadline')) return error.reason
    if (error instanceof Error && (error.message === 'estimated_cu_budget_exceeded' || error.message === 'call_count_budget_exceeded' || error.message === 'deadline')) return error.message
    return null
  }
  // A rate limit, provider 5xx or transport failure says nothing about the block range, so splitting the range
  // would only double the calls sent to a provider that is already refusing them. Stop instead, as launch
  // discovery does after a provider failure.
  const providerStop = (error: unknown): string | null =>
    error instanceof EarlyBuyerRpcError && /^(rpc_http_(429|5\d\d)|rpc_transport_failed)$/.test(error.reason) ? error.reason : null
  let stopped: string | null = null
  const timestampByBlock = new Map<number, number>()
  if (input.chain === 'eth') {
    try {
      const launchHeader = await input.rpc.call<{ timestamp?: string }>('eth_getBlockByNumber', [hex(windowStart), false])
      const launchTs = asInt(launchHeader.timestamp)
      if (launchTs == null) throw new Error('launch_timestamp_missing')
      timestampByBlock.set(windowStart, launchTs)
      for (let block = windowStart + 1; block <= earlyWindowEnd('eth', windowStart); block++) {
        const header = await input.rpc.call<{ timestamp?: string }>('eth_getBlockByNumber', [hex(block), false])
        const ts = asInt(header.timestamp)
        if (ts == null) throw new Error('window_timestamp_missing')
        timestampByBlock.set(block, ts)
        if (ts - launchTs >= 60) { endBlock = block; break }
      }
    } catch (error) {
      const halt = hardStop(error)
      if (halt) stopped = halt
      reasons.push(halt ?? 'ethereum_time_window_unverified')
    }
  }
  const swapLogs: RpcLog[] = []
  const distributionEnd = endBlock
  const fetchSwapLogs = async (launch: LaunchProof, fromBlock: number, toBlock: number): Promise<RpcLog[]> => {
    const address = launch.protocol === 'v4' ? V4_SWAP_CHAIN_CONFIG[input.chain].poolManager : launch.pool!
    const topic = launch.protocol === 'v4' ? V4_SWAP_TOPIC0 : launch.protocol === 'aerodrome_v2' ? aeroSwap : launch.protocol === 'v2' ? v2Swap : v3Swap
    const topics = launch.protocol === 'v4' ? [topic, launch.pool!] : [topic]
    const logs = await input.rpc.call<RpcLog[]>('eth_getLogs', [{ address, fromBlock: hex(fromBlock), toBlock: hex(toBlock), topics }])
    return logs.filter((log) => !log.removed && log.address?.toLowerCase() === address.toLowerCase() && log.topics?.[0]?.toLowerCase() === topic.toLowerCase() && (launch.protocol !== 'v4' || log.topics?.[1]?.toLowerCase() === launch.pool!.toLowerCase()) && (asInt(log.blockNumber) ?? -1) >= fromBlock && (asInt(log.blockNumber) ?? -1) <= toBlock)
  }
  const collectSwapLogs = async (fromBlock: number, toBlock: number) => {
    const read = async (launch: LaunchProof, from: number, to: number, depth: number) => {
      if (stopped) return
      try { swapLogs.push(...await fetchSwapLogs(launch, from, to)) }
      catch (error) {
        const halt = hardStop(error) ?? providerStop(error)
        if (halt || from === to || depth >= 6 || !(error instanceof EarlyBuyerRpcError)) {
          if (halt) stopped = halt
          reasons.push(halt ?? (error instanceof EarlyBuyerRpcError ? error.reason : 'swap_logs_unavailable'))
          return
        }
        const mid = Math.floor((from + to) / 2)
        await read(launch, from, mid, depth + 1)
        await read(launch, mid + 1, to, depth + 1)
      }
    }
    for (const launch of launches) {
      if (stopped) break
      await read(launch, fromBlock, toBlock, 0)
    }
  }
  const firstSwapFrom = async (launch: LaunchProof, from: number, to: number, depth: number): Promise<number | null> => {
    if (stopped) return null
    try {
      const blocks = (await fetchSwapLogs(launch, from, to)).map((log) => asInt(log.blockNumber)).filter((block): block is number => block != null)
      return blocks.length > 0 ? Math.min(...blocks) : null
    } catch (error) {
      const halt = hardStop(error) ?? providerStop(error)
      if (halt || from === to || depth >= 6 || !(error instanceof EarlyBuyerRpcError)) {
        if (halt) stopped = halt
        reasons.push(halt ?? (error instanceof EarlyBuyerRpcError ? error.reason : 'swap_logs_unavailable'))
        return null
      }
      const mid = Math.floor((from + to) / 2)
      const earlier = await firstSwapFrom(launch, from, mid, depth + 1)
      if (earlier != null || stopped) return earlier
      return firstSwapFrom(launch, mid + 1, to, depth + 1)
    }
  }
  await collectSwapLogs(windowStart, endBlock)
  if (swapLogs.length === 0 && !stopped) {
    const primary = launches.find((launch) => launch.block === launchBlock) ?? launches[0]
    const horizon = launchBlock + SWAP_LOOKAHEAD_BLOCKS
    let cursor = endBlock + 1
    let tradeStart: number | null = null
    while (primary && cursor <= horizon && !stopped) {
      const chunkEnd = Math.min(horizon, cursor + 15)
      tradeStart = await firstSwapFrom(primary, cursor, chunkEnd, 0)
      if (tradeStart != null || stopped) break
      cursor = chunkEnd + 1
    }
    if (tradeStart != null) {
      windowStart = tradeStart
      endBlock = earlyWindowEnd(input.chain, tradeStart)
      if (input.chain === 'eth') {
        try {
          const originHeader = await input.rpc.call<{ timestamp?: string }>('eth_getBlockByNumber', [hex(tradeStart), false])
          const originTs = asInt(originHeader.timestamp)
          if (originTs == null) throw new Error('trade_timestamp_missing')
          timestampByBlock.set(tradeStart, originTs)
          for (let block = tradeStart + 1; block <= earlyWindowEnd('eth', tradeStart); block++) {
            const header = await input.rpc.call<{ timestamp?: string }>('eth_getBlockByNumber', [hex(block), false])
            const ts = asInt(header.timestamp)
            if (ts == null) throw new Error('window_timestamp_missing')
            timestampByBlock.set(block, ts)
            if (ts - originTs >= 60) { endBlock = block; break }
          }
        } catch (error) {
          const halt = hardStop(error)
          if (halt) stopped = halt
          reasons.push(halt ?? 'ethereum_time_window_unverified')
        }
      }
      if (!stopped) await collectSwapLogs(windowStart, endBlock)
    } else if (!stopped) reasons.push('no_swap_within_bounded_lookahead')
  }
  const uniqueTx = new Map<string, { block: number; index: number }>()
  const swapPoolsByTx = new Map<string, Set<string>>()
  for (const log of swapLogs) {
    const hash = log.transactionHash?.toLowerCase(), block = asInt(log.blockNumber)
    if (hash && TX.test(hash) && block != null && block >= windowStart && block <= endBlock) {
      uniqueTx.set(hash, { block, index: asInt(log.logIndex) ?? 0 })
      const matched = launches.find((launch) => (launch.protocol === 'v4' ? log.topics?.[1]?.toLowerCase() === launch.pool?.toLowerCase() : log.address?.toLowerCase() === launch.pool?.toLowerCase()))
      if (matched?.pool) { const pools = swapPoolsByTx.get(hash) ?? new Set<string>(); pools.add(matched.pool.toLowerCase()); swapPoolsByTx.set(hash, pools) }
    }
  }
  const hashes = [...uniqueTx].sort((a, b) => a[1].block - b[1].block || a[1].index - b[1].index || a[0].localeCompare(b[0]))
  if (hashes.length > 50) reasons.push('receipt_cap_50')
  const selected = hashes.slice(0, 50)
  const byBlock = new Map<number, string[]>()
  for (const [hash, expected] of selected) {
    const group = byBlock.get(expected.block) ?? []
    group.push(hash)
    byBlock.set(expected.block, group)
  }
  const receipts = new Map<string, RpcReceipt>()
  let blockReceiptCalls = 0, blockReceiptThroughputCu = 0
  const plan = planBlockReceipts([...byBlock].map(([block, group]) => [block, group.length]), input.rpc.budget.maxCalls() - input.rpc.budget.callsUsed())
  for (const [block, group] of byBlock) {
    if (stopped) break
    if (plan.has(block)) {
      try {
        blockReceiptCalls += 1; blockReceiptThroughputCu += BLOCK_RECEIPTS_THROUGHPUT_CU
        const raw = await input.rpc.call<Array<RpcReceipt | null> | RpcReceipt | null>('eth_getBlockReceipts', [hex(block)], { maxResponseBytes: BLOCK_RECEIPTS_MAX_RESPONSE_BYTES })
        const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          const hash = row.transactionHash?.toLowerCase()
          // Accept a batch row only when it is one of the swaps in this block. Nulls, other
          // transactions, and rows without a matching block number fall through to eth_getTransactionReceipt.
          if (!hash || !group.includes(hash) || asInt(row.blockNumber) !== block) continue
          if ((row.status !== '0x1' && row.status !== '0x0') || asInt(row.transactionIndex) == null || !Array.isArray(row.logs)) continue
          receipts.set(hash, row)
        }
      } catch (error) {
        stopped = hardStop(error)
        if (stopped) break
      }
    }
    if (stopped) break
    for (const hash of group) {
      if (receipts.has(hash)) continue
      try { receipts.set(hash, await input.rpc.call<RpcReceipt>('eth_getTransactionReceipt', [hash])) }
      catch (error) {
        stopped = hardStop(error)
        reasons.push(stopped ?? (error instanceof EarlyBuyerRpcError ? error.reason : 'receipt_unavailable'))
        break
      }
    }
  }
  const manager = V4_SWAP_CHAIN_CONFIG[input.chain].poolManager.toLowerCase()
  const infra = new Set([token, ...pools, manager, ...(input.infrastructure ?? []), ...PUBLIC_CALL_TARGETS].map((v) => v.toLowerCase()))
  const facts: BuyFact[] = []
  const examined: WindowExamined = { startBlock: null, endBlock: null, receipts: 0, swapTransactions: hashes.length }
  for (const [hash, expected] of selected) {
    const receipt = receipts.get(hash)
    if (!receipt) { if (stopped && !reasons.includes(stopped)) reasons.push(stopped); break }
    // Selected hashes are block-ordered, so the last inspected receipt bounds the examined range.
    examined.receipts += 1
    examined.startBlock ??= expected.block
    examined.endBlock = expected.block
    if (receipt.status !== '0x1' || receipt.transactionHash?.toLowerCase() !== hash || !isAddress(receipt.from) || !Array.isArray(receipt.logs)) continue
    const block = asInt(receipt.blockNumber), transactionIndex = asInt(receipt.transactionIndex)
    if (block !== expected.block || transactionIndex == null) continue
    const txPools = swapPoolsByTx.get(hash)
    if (!txPools || txPools.size !== 1) { reasons.push('multi_pool_transaction_unattributed'); continue }
    const pool = [...txPools][0]
    const hasExactSwap = receipt.logs.some((log) => !log.removed && swapLogs.some((s) => s.transactionHash?.toLowerCase() === hash && s.address?.toLowerCase() === log.address?.toLowerCase() && s.topics?.[0]?.toLowerCase() === log.topics?.[0]?.toLowerCase() && (s.logIndex == null || s.logIndex === log.logIndex) && (s.address?.toLowerCase() !== manager || s.topics?.[1]?.toLowerCase() === log.topics?.[1]?.toLowerCase())))
    if (!hasExactSwap) continue
    // A receipt can contain a swap and an LP withdrawal/distribution. Without leg-level
    // attribution those pool-origin transfers are not defensible purchase evidence.
    if (receipt.logs.some((log) => (log.address?.toLowerCase() === pool || (launches.some((candidate) => candidate.pool === pool && candidate.protocol === 'v4') && log.address?.toLowerCase() === manager && log.topics?.[1]?.toLowerCase() === pool)) && liquidityEvents.has((log.topics?.[0]?.toLowerCase() ?? '0x') as `0x${string}`))) { reasons.push('swap_liquidity_mixed_transaction_unattributed'); continue }
    if (!timestampByBlock.has(block) && !stopped) {
      try {
        const header = await input.rpc.call<{ timestamp?: string }>('eth_getBlockByNumber', [hex(block), false])
        const timestamp = asInt(header.timestamp)
        if (timestamp == null) throw new Error('timestamp_missing')
        timestampByBlock.set(block, timestamp)
      } catch (error) {
        const halt = hardStop(error)
        if (halt) stopped = halt
        const reason = halt ?? 'acquisition_timestamp_unavailable'
        if (!reasons.includes(reason)) reasons.push(reason)
      }
    }
    const transfers = receipt.logs.map((l) => transferFromLog(l, token, hash, block)).filter((v): v is Transfer => Boolean(v))
    const launch = launches.find((candidate) => candidate.pool?.toLowerCase() === pool)
    const poolSources = new Set([launch?.protocol === 'v4' ? manager : pool])
    const derived = deriveBuyFacts({ transfers, poolSources, infrastructure: infra, signer: receipt.from, called: receipt.to ?? null, txHash: hash, block, transactionIndex, pool, timestampSec: timestampByBlock.get(block) })
    facts.push(...derived.slice(0, 100 - facts.length))
    if (facts.length >= 100) { reasons.push('acquisition_cap_100'); break }
  }
  // Only creator-origin token transfers without a pool swap are launch distributions. No
  // deployer evidence means no distribution claim; a token Transfer by itself is never a buy.
  const distributions: WindowRead['distributions'] = []
  if (input.deployer && isAddress(input.deployer) && !stopped) {
    try {
      const rows = await input.rpc.call<RpcLog[]>('eth_getLogs', [{ address: token, fromBlock: hex(launchBlock), toBlock: hex(distributionEnd), topics: [transferTopic, `0x${'0'.repeat(24)}${input.deployer.slice(2).toLowerCase()}`] }])
      if (rows.length > 1000) reasons.push('distribution_log_cap_1000')
      for (const log of rows.slice(0, 1000)) {
        const hash = log.transactionHash?.toLowerCase(), block = asInt(log.blockNumber)
        if (!hash || !TX.test(hash) || block == null || uniqueTx.has(hash)) continue
        const t = transferFromLog(log, token, hash, block)
        if (t && isAddress(t.to) && !infra.has(t.to)) distributions.push({ wallet: t.to, rawAmount: t.rawAmount.toString(), txHash: hash })
      }
    } catch (error) { reasons.push(error instanceof EarlyBuyerRpcError ? error.reason : 'distribution_logs_unavailable') }
  }
  return { facts, distributions, startBlock: windowStart, endBlock, examined, pools, capped: reasons.length > 0, reasons, blockReceiptCalls, blockReceiptThroughputCu }
}
