// LP fee income: Uniswap V3 fees paid out to the wallet, and what the wallet realized by selling them.
//
// Confirmed shape (DGUY creator wallet, Base): a keeper bot calls a launchpad fee locker that owns the
// DGUY/AMZN position NFT; in that one transaction the pool emits a zero-size Burn ("poke") and a
// Collect, the position manager emits its own Collect, and the locker splits both tokens between the
// protocol and the wallet. The wallet sends nothing and signs nothing. The liquidity leg guard reads
// these as withdrawals and FIFO skips them, so the wallet's later sales of those tokens show up as
// outgoing transfers with no matching buy — while they were the wallet's actual income.
//
// This lane never enters trading FIFO or the public PnL gate (a $0 cost is not a price, and the
// verified-lot predicate rightly rejects one). It reports, separately:
//   - payouts proven fee-only, transaction by transaction (classifyLpFeePayout — every rule below);
//   - for a token the wallet acquired ONLY through proven payouts, each sale whose proceeds the
//     receipt (and, for native ETH, the call trace) prove exactly — classifyReceiptQuoteEvidence, the
//     same rules the receipt quote lane uses — valued at the historical ETH/USD price of that time.
// Anything not proven stays out and is counted, never estimated.
//
// Fee-only proof for one payout (all required):
//   - mined, not reverted, and NOT signed by the wallet (no tx.value of the wallet's, no own action);
//   - the wallet sends no token at all in the transaction;
//   - no swap, mint or V2/V4 liquidity event anywhere in it;
//   - a canonical Uniswap V3 position manager emits Collect(tokenId) and the pool's Collect names that
//     manager as owner with the same recipient and amounts; every pool Burn is zero-size;
//   - the position never had liquidity withdrawn (no DecreaseLiquidity for that tokenId, ever) — V3
//     collects owed principal and fees together, so a past withdrawal would make the payout mixed;
//   - every token the wallet receives comes from that pool, directly or through an address whose only
//     inflow of that token in the transaction is the pool's Collect payout.

import type { NormalizedEvent } from '../modules/normalization/types'
import type { SupportedChain } from '../modules/providerFetchWindow/types'
import { isBurnAddress } from './burnAddresses'
import { classifyReceiptQuoteEvidence, LIQUIDITY_TOPIC0S, RECOVERED_RECEIPT_CLASSIFICATIONS, SWAP_TOPIC0S, TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type InternalTransferFetcher, type ReceiptQuoteLog, type ReceiptQuoteTx, type ReceiptQuoteTxFetcher } from './receiptQuoteRecovery'
import { resolveTokenDecimals } from '../modules/normalization/canonicalDecimals'
import { isVerifiedStablecoinAddress } from '../modules/quoteLegPricing/index'

export const V3_POOL_COLLECT_TOPIC0 = '0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0' // Collect(address,address,int24,int24,uint128,uint128)
export const V3_POOL_BURN_TOPIC0 = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c' // Burn(address,int24,int24,uint128,uint256,uint256)
export const NPM_COLLECT_TOPIC0 = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01' // Collect(uint256,address,uint256,uint256)
export const NPM_DECREASE_LIQUIDITY_TOPIC0 = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4' // DecreaseLiquidity(uint256,uint128,uint256,uint256)

// Uniswap V3 NonfungiblePositionManager deployments. Only these can make a Collect(tokenId) log that
// a token contract or spam airdrop cannot imitate.
const V3_POSITION_MANAGERS: Partial<Record<SupportedChain, ReadonlySet<string>>> = {
  eth: new Set(['0xc36442b4a4522e871399cd717abdd847ab11fe88']),
  base: new Set(['0x03a520b32c04bf3beef7beb72e919cf822ed34f1']),
}

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase()
const topicAddress = (topic: string | undefined) => (topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : '')
function word(data: string, index: number): bigint | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const w = hex.slice(index * 64, index * 64 + 64)
  return w.length === 64 ? BigInt(`0x${w}`) : null
}

export type LpFeePayoutProof =
  | { proven: true; positionManager: string; tokenId: string; pool: string; recipient: string; poolTokens: string[]; received: Array<{ token: string; amountRaw: bigint }> }
  | { proven: false; reason: LpFeePayoutRejection }
export type LpFeePayoutRejection =
  | 'receipt_unavailable' | 'signed_by_wallet' | 'wallet_sent_tokens' | 'swap_or_liquidity_change_in_tx'
  | 'no_position_manager_collect' | 'pool_collect_mismatch' | 'non_zero_burn' | 'token_not_from_fee_payout' | 'nothing_received'

// PURE. Position history (never decreased) is checked separately — see proveLpFeePayouts.
export function classifyLpFeePayout(chain: SupportedChain, walletAddress: string, tx: ReceiptQuoteTx): LpFeePayoutProof {
  if (tx.status !== 'ok') return { proven: false, reason: 'receipt_unavailable' }
  const wallet = lower(walletAddress)
  if (lower(tx.from) === wallet) return { proven: false, reason: 'signed_by_wallet' }
  const transfers = tx.logs.filter((l) => lower(l.topics[0]) === TRANSFER_TOPIC0 && l.topics.length >= 3)
  if (transfers.some((l) => topicAddress(l.topics[1]) === wallet)) return { proven: false, reason: 'wallet_sent_tokens' }
  const topic0s = tx.logs.map((l) => lower(l.topics[0]))
  if (topic0s.some((t) => t in SWAP_TOPIC0S || (LIQUIDITY_TOPIC0S.has(t) && t !== V3_POOL_BURN_TOPIC0))) return { proven: false, reason: 'swap_or_liquidity_change_in_tx' }

  const managers = V3_POSITION_MANAGERS[chain] ?? new Set<string>()
  const npmCollects = tx.logs.filter((l) => lower(l.topics[0]) === NPM_COLLECT_TOPIC0 && managers.has(lower(l.address)) && l.topics.length >= 2)
  if (npmCollects.length !== 1) return { proven: false, reason: 'no_position_manager_collect' }
  const npm = npmCollects[0]
  const poolCollects = tx.logs.filter((l) => lower(l.topics[0]) === V3_POOL_COLLECT_TOPIC0)
  if (poolCollects.length !== 1) return { proven: false, reason: 'pool_collect_mismatch' }
  const poolCollect = poolCollects[0]
  const pool = lower(poolCollect.address)
  // Pool Collect: owner indexed; data = recipient, amount0, amount1. Manager Collect: data = recipient, amount0, amount1.
  const sameWords = [0, 1, 2].every((i) => word(poolCollect.data, i) !== null && word(poolCollect.data, i) === word(npm.data, i))
  if (topicAddress(poolCollect.topics[1]) !== lower(npm.address) || !sameWords) return { proven: false, reason: 'pool_collect_mismatch' }
  const burns = tx.logs.filter((l) => lower(l.topics[0]) === V3_POOL_BURN_TOPIC0)
  if (burns.some((l) => lower(l.address) !== pool || [0, 1, 2].some((i) => word(l.data, i) !== BigInt(0)))) return { proven: false, reason: 'non_zero_burn' }

  // Every token reaching the wallet must trace back to the pool's payout in this transaction.
  const inflowByHolderToken = new Map<string, ReceiptQuoteLog[]>()
  for (const l of transfers) {
    const key = `${topicAddress(l.topics[2])}:${lower(l.address)}`
    inflowByHolderToken.set(key, [...(inflowByHolderToken.get(key) ?? []), l])
  }
  const received = new Map<string, bigint>()
  for (const l of transfers.filter((t) => topicAddress(t.topics[2]) === wallet)) {
    const token = lower(l.address)
    const sender = topicAddress(l.topics[1])
    const fromPool = sender === pool
      || ((inflowByHolderToken.get(`${sender}:${token}`) ?? []).length > 0
        && (inflowByHolderToken.get(`${sender}:${token}`) ?? []).every((inflow) => topicAddress(inflow.topics[1]) === pool))
    const amount = word(l.data, 0)
    if (!fromPool || amount === null) return { proven: false, reason: 'token_not_from_fee_payout' }
    received.set(token, (received.get(token) ?? BigInt(0)) + amount)
  }
  if (received.size === 0) return { proven: false, reason: 'nothing_received' }
  const recipientWord = word(npm.data, 0)
  return {
    proven: true,
    positionManager: lower(npm.address),
    tokenId: BigInt(npm.topics[1]).toString(),
    pool,
    recipient: recipientWord === null ? '' : `0x${recipientWord.toString(16).padStart(40, '0')}`,
    poolTokens: [...new Set(transfers.filter((t) => topicAddress(t.topics[1]) === pool).map((t) => lower(t.address)))].sort(),
    received: [...received.entries()].map(([token, amountRaw]) => ({ token, amountRaw })).sort((a, b) => a.token.localeCompare(b.token)),
  }
}

// A transaction that might be a fee payout: every wallet leg is inbound and at least one is not a
// burn-address artefact. Cheap pre-filter over provider activity; the receipt decides.
export function lpFeePayoutCandidateTxs(events: readonly NormalizedEvent[], chain: SupportedChain): string[] {
  const byTx = new Map<string, NormalizedEvent[]>()
  for (const e of events) {
    if (e.chain !== chain) continue
    const key = e.txHash.toLowerCase()
    byTx.set(key, [...(byTx.get(key) ?? []), e])
  }
  return [...byTx.entries()]
    .filter(([, legs]) => legs.length > 0 && legs.every((e) => e.direction === 'inbound'))
    .map(([txHash]) => txHash)
    .sort()
}

export type LpFeeIncomeToken = {
  token: string
  symbol: string | null
  /** Received through proven fee payouts in the scan window (token units). */
  receivedFromFees: number
  payouts: number
  /** Sold with exact, transaction-proven proceeds. */
  soldAmount: number
  salesProven: number
  proceedsNative: number
  proceedsUsd: number
  /** Outgoing transfers of this token whose proceeds could not be proven (left out of the total). */
  salesUnproven: number
}

export type LpFeeIncomeSummary = {
  status: 'proven' | 'none' | 'not_attempted'
  reason: string | null
  candidateTxs: number
  payoutTxsChecked: number
  payoutTxsProven: number
  payoutRejections: Record<string, number>
  /** Candidates left unchecked by the per-scan cap, deadline or provider budget. */
  payoutTxsUnchecked: number
  positions: number
  tokens: LpFeeIncomeToken[]
  /** Proceeds of proven sales of fee-only tokens: the wallet's realized LP fee income ($0 cost). */
  realizedFeeIncomeUsd: number | null
  realizedFeeIncomeNative: number | null
  /** Why sales of fee-only tokens could not be proven (receipt classification). */
  saleRejections: Record<string, number>
  /** Proven sales that also sent a small same-token fee leg (counted as sold, no proceeds). */
  sellFeeLegs: number
  /** Proven sales whose proceeds were proven at the wallet's boundary (route not decodable). */
  walletBoundaryProofs: number
  calls: { receipts: number; positionHistory: number; saleReceipts: number; traces: number }
}

// WALLET-BOUNDARY PROCEEDS. In a transaction the wallet signed with no ETH attached, where the only
// tokens leaving the wallet are the sold token and the only value arriving is native ETH (from the
// call trace) or a single verified stablecoin, everything the wallet received is the sale's proceeds —
// whichever route the router took. Any other asset in or out, a WETH wrap/unwrap by the wallet, or a
// missing trace fails closed.
export function walletBoundaryProceeds(chain: SupportedChain, tx: Extract<ReceiptQuoteTx, { status: 'ok' }>, wallet: string, token: string): { kind: 'native' | 'stable'; token: string; quantity: number } | null {
  if (lower(tx.from) !== wallet || tx.valueWei !== '0') return null
  const isTransfer = (l: ReceiptQuoteLog) => lower(l.topics[0]) === TRANSFER_TOPIC0 && l.topics.length >= 3
  const outs = tx.logs.filter((l) => isTransfer(l) && topicAddress(l.topics[1]) === wallet)
  if (outs.length === 0 || outs.some((l) => lower(l.address) !== token)) return null
  if (tx.logs.some((l) => [WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0].includes(lower(l.topics[0])) && topicAddress(l.topics[1]) === wallet)) return null
  const ins = tx.logs.filter((l) => isTransfer(l) && topicAddress(l.topics[2]) === wallet)
  const native = tx.internalTransfers == null ? null
    : tx.internalTransfers.filter((t) => lower(t.to) === wallet).reduce((sum, t) => sum + BigInt(t.valueWei), BigInt(0))
  if (tx.internalTransfers?.some((t) => lower(t.from) === wallet)) return null
  if (ins.length === 0) {
    if (native == null || native <= BigInt(0)) return null
    return { kind: 'native', token: 'native', quantity: Number(native) / 1e18 }
  }
  // A stablecoin payout: one verified stablecoin, and no native ETH alongside it.
  const stable = lower(ins[0].address)
  if (native !== BigInt(0) || ins.some((l) => lower(l.address) !== stable) || !isVerifiedStablecoinAddress(chain, stable)) return null
  const raw = ins.reduce((sum, l) => sum + (word(l.data, 0) ?? BigInt(0)), BigInt(0))
  const decimals = resolveTokenDecimals({ chain, token: stable }).decimals
  return raw > BigInt(0) ? { kind: 'stable', token: stable, quantity: Number(raw) / 10 ** decimals } : null
}

// A sale that sends the token out twice: the swap leg and a small fee leg (live: 0.25% of every AMZNc
// sale to one fee address). The fee leg is a disposal with no proceeds, not a second trade; it is
// set aside only when it is at most 1% of the sale, not sent to the transaction's target, and its
// recipient sends nothing back to the wallet. Returns null when the sale has no such leg.
const SELL_FEE_LEG_MAX_SHARE_BPS = BigInt(100)
export function splitSellFeeLegs(tx: Extract<ReceiptQuoteTx, { status: 'ok' }>, wallet: string, token: string): { logs: ReceiptQuoteLog[]; mainRaw: bigint } | null {
  const isTransfer = (l: ReceiptQuoteLog) => lower(l.topics[0]) === TRANSFER_TOPIC0 && l.topics.length >= 3
  const outs = tx.logs.filter((l) => isTransfer(l) && lower(l.address) === token && topicAddress(l.topics[1]) === wallet)
  if (outs.length < 2) return null
  const amounts = outs.map((l) => word(l.data, 0))
  if (amounts.some((a) => a === null)) return null
  const total = amounts.reduce((sum, a) => sum! + a!, BigInt(0))!
  const mainIndex = amounts.reduce((best, a, i) => (a! > amounts[best]! ? i : best), 0)
  const fees = outs.filter((_, i) => i !== mainIndex)
  for (const fee of fees) {
    const recipient = topicAddress(fee.topics[2])
    if (word(fee.data, 0)! * BigInt(10_000) > total * SELL_FEE_LEG_MAX_SHARE_BPS) return null
    if (recipient === lower(tx.to)) return null
    if (tx.logs.some((l) => isTransfer(l) && topicAddress(l.topics[1]) === recipient && topicAddress(l.topics[2]) === wallet)) return null
  }
  return { logs: tx.logs.filter((l) => !fees.includes(l)), mainRaw: amounts[mainIndex]! }
}

export const LP_FEE_INCOME_LIMITS = { maxPayers: 3, maxSaleTxs: 12, deadlineMs: 12_000 }

type JsonRpc = (body: unknown, signal: AbortSignal) => Promise<unknown>

export type LpFeeIncomeDeps = {
  chain: SupportedChain
  walletAddress: string
  events: readonly NormalizedEvent[]
  rpc: JsonRpc | null
  /** Called once per provider call before it is made; false = budget exhausted, the call is not made. */
  consume: (method: string) => boolean
  fetchTx: ReceiptQuoteTxFetcher
  fetchInternalTransfers?: InternalTransferFetcher
  nativeUsdAt: (timestampMs: number) => Promise<number | null>
  limits?: Partial<typeof LP_FEE_INCOME_LIMITS>
}

type RpcLog = { transactionHash?: string; topics?: string[]; data?: string; removed?: boolean }
const topicFor = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`

// A position's history and its payouts never change once mined: kept for the process lifetime.
const positionNeverDecreasedCache = new Map<string, boolean>()
export function __resetLpFeeIncomeCacheForTest(): void { positionNeverDecreasedCache.clear() }

export async function buildLpFeeIncome(deps: LpFeeIncomeDeps): Promise<LpFeeIncomeSummary> {
  const limits = { ...LP_FEE_INCOME_LIMITS, ...deps.limits }
  const wallet = lower(deps.walletAddress)
  // The pipeline hands over normalized, canonical and recovered copies of the same transfers.
  const seen = new Set<string>()
  const events = deps.events.filter((e) => {
    const key = [e.chain, e.txHash, e.contract, e.direction, e.amountRaw ?? e.amount, e.fromAddress, e.toAddress].map((v) => lower(String(v))).join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  deps = { ...deps, events }
  const candidates = lpFeePayoutCandidateTxs(deps.events, deps.chain)
  const summary: LpFeeIncomeSummary = {
    status: 'none', reason: null, candidateTxs: candidates.length, payoutTxsChecked: 0, payoutTxsProven: 0,
    payoutRejections: {}, payoutTxsUnchecked: 0, positions: 0, tokens: [], realizedFeeIncomeUsd: null, realizedFeeIncomeNative: null, saleRejections: {}, sellFeeLegs: 0, walletBoundaryProofs: 0,
    calls: { receipts: 0, positionHistory: 0, saleReceipts: 0, traces: 0 },
  }
  if (!deps.rpc) return { ...summary, status: 'not_attempted', reason: 'rpc_not_configured' }
  if (candidates.length === 0) return { ...summary, reason: 'no_inbound_only_transactions' }
  const rpc = deps.rpc
  const deadline = AbortSignal.timeout(limits.deadlineMs)
  const reject = (reason: string, n = 1) => { summary.payoutRejections[reason] = (summary.payoutRejections[reason] ?? 0) + n }
  const getLogs = async (filter: Record<string, unknown>): Promise<RpcLog[] | null> => {
    if (deadline.aborted || !deps.consume('eth_getLogs')) return null
    summary.calls.positionHistory += 1
    try {
      const json = await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest', ...filter }] }, deadline) as { result?: unknown }
      return Array.isArray(json?.result) ? (json.result as RpcLog[]).filter((l) => l.removed !== true) : null
    } catch { return null }
  }

  // Wallet legs of each candidate, grouped by the address that paid them.
  const candidateSet = new Set(candidates)
  const legsByTx = new Map<string, NormalizedEvent[]>()
  for (const e of deps.events) {
    const key = e.txHash.toLowerCase()
    if (e.chain === deps.chain && candidateSet.has(key)) legsByTx.set(key, [...(legsByTx.get(key) ?? []), e])
  }
  const txsByPayer = new Map<string, string[]>()
  for (const [txHash, legs] of legsByTx) {
    const payers = new Set(legs.map((e) => lower(e.fromAddress)))
    if (payers.size !== 1) { reject('several_payers_in_tx'); summary.payoutTxsChecked += 1; continue }
    const payer = [...payers][0]
    txsByPayer.set(payer, [...(txsByPayer.get(payer) ?? []), txHash])
  }
  const payers = [...txsByPayer.entries()].filter(([, txs]) => txs.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  for (const [, txs] of [...txsByPayer.entries()].filter(([, t]) => t.length < 2)) { reject('single_payment_from_payer', txs.length); summary.payoutTxsChecked += txs.length }

  // One payout per payer is proven in full from its receipt; that fixes the position, the pool and
  // its two tokens. Every other payout is then matched from three log queries against what the real
  // position manager and the token contracts emitted — amounts must agree exactly.
  const provenPayouts = new Map<string, { positionManager: string; tokenId: string; received: Array<{ token: string; amountRaw: bigint }> }>()
  for (const [payer, txs] of payers.slice(0, limits.maxPayers)) {
    const sampleTx = [...txs].sort().reverse()[0]
    if (deadline.aborted || !deps.consume('eth_getTransactionReceipt') || !deps.consume('eth_getTransactionByHash')) continue
    summary.calls.receipts += 1
    const sample = classifyLpFeePayout(deps.chain, wallet, await deps.fetchTx(deps.chain, sampleTx, deadline))
    if (!sample.proven) { reject(sample.reason, txs.length); summary.payoutTxsChecked += txs.length; continue }
    if (sample.recipient !== payer && !(sample.recipient === wallet && payer === sample.pool)) { reject('payer_is_not_collect_recipient', txs.length); summary.payoutTxsChecked += txs.length; continue }
    if (sample.poolTokens.length !== 2) { reject('pool_tokens_unknown', txs.length); summary.payoutTxsChecked += txs.length; continue }
    const positionKey = `${sample.positionManager}:${sample.tokenId}`
    const tokenIdTopic = `0x${BigInt(sample.tokenId).toString(16).padStart(64, '0')}`
    if (!positionNeverDecreasedCache.has(positionKey)) {
      const decreases = await getLogs({ address: sample.positionManager, topics: [NPM_DECREASE_LIQUIDITY_TOPIC0, tokenIdTopic] })
      if (decreases) positionNeverDecreasedCache.set(positionKey, decreases.length === 0)
    }
    if (positionNeverDecreasedCache.get(positionKey) !== true) {
      reject(positionNeverDecreasedCache.has(positionKey) ? 'position_had_liquidity_withdrawn' : 'position_history_unavailable', txs.length)
      summary.payoutTxsChecked += txs.length
      continue
    }
    const collects = await getLogs({ address: sample.positionManager, topics: [NPM_COLLECT_TOPIC0, tokenIdTopic] })
    const inflows = await Promise.all(sample.poolTokens.map((token) => getLogs({ address: token, topics: [TRANSFER_TOPIC0, null, topicFor(sample.recipient)] })))
    if (!collects || inflows.some((l) => l === null)) { reject('payout_logs_unavailable', txs.length); summary.payoutTxsChecked += txs.length; continue }
    const collectByTx = new Map<string, bigint[]>()
    for (const l of collects) {
      const words = [0, 1, 2].map((i) => word(l.data ?? '', i))
      if (l.transactionHash && words.every((w) => w !== null) && `0x${words[0]!.toString(16).padStart(40, '0')}` === sample.recipient) {
        collectByTx.set(lower(l.transactionHash), [words[1]!, words[2]!])
      }
    }
    // token0 is the lower address in every Uniswap V3 pool.
    const [token0, token1] = [...sample.poolTokens].sort()
    const inflowByTxToken = new Map<string, Array<{ from: string; amount: bigint }>>()
    sample.poolTokens.forEach((token, i) => {
      for (const l of inflows[i]!) {
        const amount = word(l.data ?? '', 0)
        if (!l.transactionHash || amount === null) continue
        const key = `${lower(l.transactionHash)}:${token}`
        inflowByTxToken.set(key, [...(inflowByTxToken.get(key) ?? []), { from: topicAddress(l.topics?.[1]), amount }])
      }
    })
    for (const txHash of txs) {
      summary.payoutTxsChecked += 1
      const collect = collectByTx.get(txHash)
      if (!collect) { reject('no_position_collect_in_tx'); continue }
      const receivedByToken = new Map<string, bigint>()
      let reason: string | null = null
      for (const leg of legsByTx.get(txHash) ?? []) {
        const token = lower(leg.contract)
        if (token !== token0 && token !== token1) { reason = 'token_not_from_fee_payout'; break }
        if (!leg.amountRaw || !/^\d+$/.test(leg.amountRaw)) { reason = 'leg_amount_unavailable'; break }
        receivedByToken.set(token, (receivedByToken.get(token) ?? BigInt(0)) + BigInt(leg.amountRaw))
      }
      for (const [token, amount] of receivedByToken) {
        if (reason) break
        const collected = token === token0 ? collect[0] : collect[1]
        const arrived = inflowByTxToken.get(`${txHash}:${token}`) ?? []
        // The payer's only inflow of the token in this transaction is the pool's payout, of exactly
        // the collected amount, and the wallet got no more than that.
        if (arrived.length === 0 || arrived.some((a) => a.from !== sample.pool)) reason = 'token_not_from_fee_payout'
        else if (arrived.reduce((sum, a) => sum + a.amount, BigInt(0)) !== collected) reason = 'collect_amount_mismatch'
        else if (amount > collected) reason = 'wallet_received_more_than_collected'
      }
      if (reason || receivedByToken.size === 0) { reject(reason ?? 'nothing_received'); continue }
      provenPayouts.set(txHash, { positionManager: sample.positionManager, tokenId: sample.tokenId, received: [...receivedByToken.entries()].map(([token, amountRaw]) => ({ token, amountRaw })) })
    }
  }
  summary.payoutTxsUnchecked = candidates.length - summary.payoutTxsChecked
  summary.payoutTxsProven = provenPayouts.size
  summary.positions = new Set([...provenPayouts.values()].map((p) => `${p.positionManager}:${p.tokenId}`)).size
  if (provenPayouts.size === 0) return { ...summary, reason: 'no_proven_fee_payouts' }
  summary.status = 'proven'

  // 3. Fee-only tokens: every inbound event of the token in the window is a proven payout leg.
  const chainEvents = deps.events.filter((e) => e.chain === deps.chain)
  const feeTokens = new Set<string>()
  for (const p of provenPayouts.values()) for (const r of p.received) feeTokens.add(r.token)
  for (const e of chainEvents) {
    if (e.direction === 'inbound' && feeTokens.has(lower(e.contract)) && !provenPayouts.has(e.txHash.toLowerCase())) feeTokens.delete(lower(e.contract))
  }
  const ordered = [...chainEvents].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.txHash.localeCompare(b.txHash))
  const tokens = new Map<string, LpFeeIncomeToken>()
  const saleTxs: Array<{ token: string; txHash: string; timestamp: number; amount: number; decimals: number }> = []
  for (const token of feeTokens) {
    const sample = chainEvents.find((e) => lower(e.contract) === token)
    tokens.set(token, { token, symbol: sample?.symbol ?? null, receivedFromFees: 0, payouts: 0, soldAmount: 0, salesProven: 0, proceedsNative: 0, proceedsUsd: 0, salesUnproven: 0 })
  }
  const balance = new Map<string, number>()
  const seenSale = new Set<string>()
  for (const e of ordered) {
    const token = lower(e.contract)
    const row = tokens.get(token)
    if (!row) continue
    if (e.direction === 'inbound') {
      row.receivedFromFees += e.amount
      balance.set(token, (balance.get(token) ?? 0) + e.amount)
      continue
    }
    if (e.direction !== 'outbound' || isBurnAddress(e.toAddress)) continue
    const key = `${token}:${e.txHash.toLowerCase()}`
    if (seenSale.has(key)) continue
    seenSale.add(key)
    const amount = ordered.filter((x) => lower(x.contract) === token && x.txHash === e.txHash && x.direction === 'outbound').reduce((s, x) => s + x.amount, 0)
    // Only fee inventory the window has seen arrive can be sold as fee income.
    if (amount > (balance.get(token) ?? 0) * (1 + 1e-9)) { row.salesUnproven += 1; continue }
    balance.set(token, (balance.get(token) ?? 0) - amount)
    saleTxs.push({ token, txHash: e.txHash, timestamp: Date.parse(e.timestamp), amount, decimals: resolveTokenDecimals({ chain: deps.chain, token, providerDecimals: e.tokenDecimals }).decimals })
  }
  for (const p of provenPayouts.values()) for (const r of p.received) { const row = tokens.get(r.token); if (row) row.payouts += 1 }

  // 4. Proceeds of each sale, proven from its receipt (and call trace for a native ETH payout).
  let nativeTotal = 0
  let usdTotal = 0
  let proceedsProven = 0
  for (const sale of saleTxs.slice(0, limits.maxSaleTxs)) {
    const row = tokens.get(sale.token)!
    if (deadline.aborted || !deps.consume('eth_getTransactionReceipt') || !deps.consume('eth_getTransactionByHash')) { row.salesUnproven += 1; continue }
    summary.calls.saleReceipts += 1
    let tx: ReceiptQuoteTx = await deps.fetchTx(deps.chain, sale.txHash, deadline)
    const split = tx.status === 'ok' ? splitSellFeeLegs(tx, wallet, sale.token) : null
    if (split && tx.status === 'ok') tx = { ...tx, logs: split.logs }
    const targetAmount = split ? Number(split.mainRaw) / 10 ** sale.decimals : sale.amount
    const classify = () => classifyReceiptQuoteEvidence({ chain: deps.chain, walletAddress: wallet, targetToken: sale.token, side: 'exit', targetAmount, targetDecimals: sale.decimals, tx })
    let result = classify()
    if (result.needsNativeRecipientProof && tx.status === 'ok' && deps.fetchInternalTransfers && !deadline.aborted && deps.consume('debug_traceTransaction')) {
      summary.calls.traces += 1
      const evidence = await deps.fetchInternalTransfers(deps.chain, sale.txHash, deadline)
      tx = { ...tx, internalTransfers: evidence.transfers, traceSource: evidence.source }
      result = classify()
    }
    // Fallback when the route is not decodable (an aggregator hop through a DEX the strict classifier
    // does not attribute): proceeds proven at the wallet's own boundary instead of along the path.
    if (!result.quote || !RECOVERED_RECEIPT_CLASSIFICATIONS.has(result.classification)) {
      if (tx.status === 'ok' && tx.internalTransfers === undefined && deps.fetchInternalTransfers && !deadline.aborted && deps.consume('debug_traceTransaction')) {
        summary.calls.traces += 1
        const evidence = await deps.fetchInternalTransfers(deps.chain, sale.txHash, deadline)
        tx = { ...tx, internalTransfers: evidence.transfers, traceSource: evidence.source }
      }
      const boundary = tx.status === 'ok' ? walletBoundaryProceeds(deps.chain, tx, wallet, sale.token) : null
      if (boundary) {
        result = { ...result, classification: 'native_eth_received_via_router_unwrap_verified', quote: boundary }
        summary.walletBoundaryProofs += 1
      }
    }
    if (!result.quote || !RECOVERED_RECEIPT_CLASSIFICATIONS.has(result.classification) || (result.quote.kind !== 'native' && result.quote.kind !== 'stable')) {
      row.salesUnproven += 1
      summary.saleRejections[result.classification] = (summary.saleRejections[result.classification] ?? 0) + 1
      continue
    }
    if (split) summary.sellFeeLegs += 1
    const usdPrice = result.quote.kind === 'stable' ? 1 : await deps.nativeUsdAt(sale.timestamp)
    if (usdPrice == null || !(usdPrice > 0)) { row.salesUnproven += 1; continue }
    row.salesProven += 1
    row.soldAmount += sale.amount
    if (result.quote.kind === 'native') { row.proceedsNative += result.quote.quantity; nativeTotal += result.quote.quantity }
    row.proceedsUsd += result.quote.quantity * usdPrice
    usdTotal += result.quote.quantity * usdPrice
    proceedsProven += 1
  }
  for (const sale of saleTxs.slice(limits.maxSaleTxs)) tokens.get(sale.token)!.salesUnproven += 1
  summary.tokens = [...tokens.values()].sort((a, b) => b.proceedsUsd - a.proceedsUsd || a.token.localeCompare(b.token))
  summary.realizedFeeIncomeUsd = proceedsProven > 0 ? usdTotal : null
  summary.realizedFeeIncomeNative = proceedsProven > 0 ? nativeTotal : null
  if (feeTokens.size === 0) summary.reason = 'fee_tokens_also_acquired_otherwise'
  return summary
}
