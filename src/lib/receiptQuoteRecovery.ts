// MODULE — receiptQuoteRecovery
//
// Historical-price completion for BLOCKED CLOSED-LOT SIDES whose normalized transaction data has no
// usable opposite leg (`no_opposite_leg_in_transaction`). Wallet-centric provider activity misses two
// common, fully deterministic swap shapes:
//
//   SELL to native ETH:  wallet -> pool TOKEN, pool -> router WETH, router unwraps (WETH
//                        Withdrawal) and pays the wallet native ETH via an internal call. Alchemy's
//                        `erc20` category and GoldRush's top-level `value` both miss that ETH.
//   BUY with native ETH: wallet -> router native ETH as `tx.value`, router wraps (WETH Deposit),
//                        pool -> wallet TOKEN. Missing whenever the provider that supplied the event
//                        did not synthesize the `tx.value` leg.
//
// The receipt (+ the transaction's own from/to/value/input) proves the exact quote amount — EXCEPT
// for the sell side's last hop: a receipt proves a WETH unwrap but never who received the native
// ETH afterwards (an internal call emits no log). A sell paid out through an unwrap is therefore
// priced ONLY when an internal-transfer trace (debug_traceTransaction callTracer, or Blockscout's
// indexed internal transactions) proves the exact amount that reached the scanned wallet. This
// module is PURE except for `fetchReceiptQuoteTx`; it never infers from a symbol, never uses a
// current price, and fails closed on every ambiguous shape (unaccounted refund, unrelated wallet
// assets in a multicall, liquidity/staking events, mixed wrap+unwrap, a transaction the wallet did
// not send, or a target amount the receipt does not reproduce exactly).

import type { SupportedChain } from '../modules/providerFetchWindow/types'
import { isCanonicalWethAddress, isVerifiedStablecoinAddress } from '../modules/quoteLegPricing/index'
import { resolveTokenDecimals } from '../modules/normalization/canonicalDecimals'
import { receiptRpcUrl } from './roiQuoteLegTxBackfill'

export const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const WETH_DEPOSIT_TOPIC0 = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'
export const WETH_WITHDRAWAL_TOPIC0 = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'
// keccak256 of each exact event signature (verified with viem; see the regression test).
export const SWAP_TOPIC0S: Record<string, string> = {
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822': 'uniswap_v2', // Swap(address,uint256,uint256,uint256,uint256,address)
  '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b': 'aerodrome_classic', // Swap(address,address,uint256,uint256,uint256,uint256)
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67': 'uniswap_v3_or_slipstream', // Swap(address,address,int256,int256,uint160,uint128,int24)
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f': 'uniswap_v4', // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
}
export const LIQUIDITY_TOPIC0S = new Set([
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f', // V2 Mint
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496', // V2 Burn
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', // V3 Mint
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', // V3 Burn
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec', // V4 ModifyLiquidity
])

export type ReceiptQuoteLog = { address: string; topics: string[]; data: string; logIndex?: number }
// One executed (non-reverted) native value transfer inside the transaction, below the top-level call.
export type InternalNativeTransfer = { from: string; to: string; valueWei: string }
export type InternalTraceSource = 'debug_trace_call_tracer' | 'blockscout_internal_transactions'
export type ReceiptQuoteTx =
  | {
    status: 'ok'; from: string; to: string | null; valueWei: string; input: string; logs: ReceiptQuoteLog[]
    // null = no trace evidence could be obtained (unsupported, failed, or incomplete). Never guessed.
    internalTransfers?: InternalNativeTransfer[] | null
    traceSource?: InternalTraceSource | null
  }
  | { status: 'missing' | 'reverted' | 'unavailable' }
export type ReceiptQuoteTxFetcher = (chain: SupportedChain, txHash: string) => Promise<ReceiptQuoteTx>

export type ReceiptQuoteClassification =
  | 'receipt_unavailable'
  | 'transaction_not_sent_by_wallet'
  | 'target_leg_not_reproduced_by_receipt'
  | 'true_plain_token_transfer'
  | 'liquidity_or_staking_activity'
  | 'native_eth_paid_via_tx_value'
  | 'native_eth_received_via_router_unwrap_verified'
  | 'native_unwrap_recipient_unverified'
  | 'native_unwrap_recipient_not_wallet'
  | 'native_payout_attribution_ambiguous'
  | 'unrelated_swap_path_in_tx'
  | 'unrelated_token_flow_in_tx'
  | 'unrelated_outputs_in_tx'
  | 'quote_leg_omitted_from_provider_activity'
  | 'native_refund_unaccounted'
  | 'native_spend_on_exit_unaccounted'
  | 'ambiguous_wrap_and_unwrap'
  | 'unwrap_not_backed_by_swap_output'
  | 'multicall_unrelated_wallet_assets'
  | 'swap_without_reconstructable_quote_leg'
  | 'non_swap_contract_interaction'

export const RECOVERED_RECEIPT_CLASSIFICATIONS: ReadonlySet<ReceiptQuoteClassification> = new Set([
  'native_eth_paid_via_tx_value',
  'native_eth_received_via_router_unwrap_verified',
  'quote_leg_omitted_from_provider_activity',
])

export type ReceiptQuoteForensics = {
  logCount: number
  tokenAddresses: string[]
  walletTouchingLegs: Array<{ token: string; direction: 'in' | 'out'; raw: string }>
  poolRouterOnlyLegs: number
  nativeValueWei: string | null
  wethDepositWei: string
  wethWithdrawalWei: string
  routerAddress: string | null
  inputSelector: string | null
  swapEvents: string[]
  liquidityEvents: number
  // Target-path attribution audit.
  distinctPoolEmitters: string[]
  pathAttribution: 'not_evaluated' | 'single_target_path' | 'unrelated_swap_path' | 'unrelated_token_flow' | 'unrelated_outputs'
  unrelatedOutputs: Array<{ address: string; token: string; netRaw: string }>
  // Native payout proof (sell via unwrap only).
  traceSource: InternalTraceSource | null
  walletNativeReceivedWei: string | null
  unwrapperNativeOutWei: string | null
}

export type ReceiptQuoteResult = {
  classification: ReceiptQuoteClassification
  quote: { kind: 'native' | 'stable'; token: string; quantity: number } | null
  forensics: ReceiptQuoteForensics | null
}

const ZERO = BigInt(0)
const lower = (s: string | null | undefined) => (s ?? '').toLowerCase()
function topicAddress(topic: string | undefined): string {
  return topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : ''
}
function dataWord(data: string, index = 0): bigint {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const word = hex.slice(index * 64, index * 64 + 64)
  return word.length === 64 ? BigInt(`0x${word}`) : ZERO
}
function toUnits(raw: bigint, decimals: number): number {
  const scale = BigInt(10) ** BigInt(decimals)
  return Number(raw / scale) + Number(raw % scale) / Number(scale)
}

// PURE. `targetAmount` is the normalized total of the target token the wallet moved in this tx on
// this side (summed over every normalized event of that token+direction in the tx).
export function classifyReceiptQuoteEvidence(params: {
  chain: SupportedChain
  walletAddress: string
  targetToken: string
  side: 'entry' | 'exit'
  targetAmount: number
  targetDecimals: number
  tx: ReceiptQuoteTx
}): ReceiptQuoteResult {
  const { chain, side, tx } = params
  if (tx.status !== 'ok') return { classification: 'receipt_unavailable', quote: null, forensics: null }
  const wallet = lower(params.walletAddress)
  const target = lower(params.targetToken)

  const valueWei = /^[0-9]+$/.test(tx.valueWei) ? BigInt(tx.valueWei) : ZERO
  const tokenAddresses = new Set<string>()
  const walletTouchingLegs: ReceiptQuoteForensics['walletTouchingLegs'] = []
  let poolRouterOnlyLegs = 0
  let depositWei = ZERO
  let withdrawalWei = ZERO
  const withdrawalSources = new Set<string>()
  const wethInByAddress = new Map<string, bigint>()
  const swapEvents: string[] = []
  let liquidityEvents = 0
  for (const log of tx.logs) {
    const address = lower(log.address)
    const topic0 = lower(log.topics[0])
    if (SWAP_TOPIC0S[topic0]) swapEvents.push(SWAP_TOPIC0S[topic0])
    if (LIQUIDITY_TOPIC0S.has(topic0)) liquidityEvents += 1
    if (isCanonicalWethAddress(chain, address) && topic0 === WETH_DEPOSIT_TOPIC0) depositWei += dataWord(log.data)
    if (isCanonicalWethAddress(chain, address) && topic0 === WETH_WITHDRAWAL_TOPIC0) {
      withdrawalWei += dataWord(log.data)
      withdrawalSources.add(topicAddress(log.topics[1]))
    }
    if (topic0 !== TRANSFER_TOPIC0 || log.topics.length < 3) continue
    tokenAddresses.add(address)
    const from = topicAddress(log.topics[1])
    const to = topicAddress(log.topics[2])
    const raw = dataWord(log.data)
    if (isCanonicalWethAddress(chain, address)) wethInByAddress.set(to, (wethInByAddress.get(to) ?? ZERO) + raw)
    if (from === wallet) walletTouchingLegs.push({ token: address, direction: 'out', raw: raw.toString() })
    else if (to === wallet) walletTouchingLegs.push({ token: address, direction: 'in', raw: raw.toString() })
    else poolRouterOnlyLegs += 1
  }
  const forensics: ReceiptQuoteForensics = {
    logCount: tx.logs.length,
    tokenAddresses: [...tokenAddresses].sort(),
    walletTouchingLegs,
    poolRouterOnlyLegs,
    nativeValueWei: valueWei > ZERO ? valueWei.toString() : null,
    wethDepositWei: depositWei.toString(),
    wethWithdrawalWei: withdrawalWei.toString(),
    routerAddress: tx.to ? lower(tx.to) : null,
    inputSelector: tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : null,
    swapEvents,
    liquidityEvents,
    distinctPoolEmitters: [...new Set(tx.logs.filter((l) => SWAP_TOPIC0S[lower(l.topics[0])]).map((l) => lower(l.address)))].sort(),
    pathAttribution: 'not_evaluated',
    unrelatedOutputs: [],
    traceSource: tx.traceSource ?? null,
    walletNativeReceivedWei: null,
    unwrapperNativeOutWei: null,
  }
  const result = (classification: ReceiptQuoteClassification, quote: ReceiptQuoteResult['quote'] = null): ReceiptQuoteResult => ({ classification, quote, forensics })

  // The target leg itself must be exactly reproduced: wallet sends (exit) / receives (entry) the
  // target token, totalling the normalized amount the lot is built from.
  const targetDirection = side === 'entry' ? 'in' : 'out'
  const targetRaw = walletTouchingLegs
    .filter((leg) => leg.token === target && leg.direction === targetDirection)
    .reduce((sum, leg) => sum + BigInt(leg.raw), ZERO)
  const targetFromReceipt = toUnits(targetRaw, params.targetDecimals)
  const tolerance = Math.max(1e-12, Math.abs(params.targetAmount) * 1e-9)
  if (targetRaw === ZERO || Math.abs(targetFromReceipt - params.targetAmount) > tolerance) return result('target_leg_not_reproduced_by_receipt')
  const otherWalletLegs = walletTouchingLegs.filter((leg) => leg.token !== target)
  // A bare token transfer (no swap, no other asset, no native value) is checked before the sender:
  // a received transfer is, by definition, sent by someone else.
  if (swapEvents.length === 0 && liquidityEvents === 0 && valueWei === ZERO && otherWalletLegs.length === 0
    && depositWei === ZERO && withdrawalWei === ZERO && poolRouterOnlyLegs === 0) {
    return result('true_plain_token_transfer')
  }
  if (lower(tx.from) !== wallet) return result('transaction_not_sent_by_wallet')
  if (liquidityEvents > 0) return result('liquidity_or_staking_activity')

  const quoteDirection = side === 'entry' ? 'out' : 'in'
  const walletQuoteLegs = otherWalletLegs.filter((leg) =>
    leg.direction === quoteDirection && (isCanonicalWethAddress(chain, leg.token) || isVerifiedStablecoinAddress(chain, leg.token)))
  const unrelatedWalletLegs = otherWalletLegs.filter((leg) => !walletQuoteLegs.includes(leg))

  if (swapEvents.length === 0) return result('non_swap_contract_interaction')
  if (unrelatedWalletLegs.length > 0) return result('multicall_unrelated_wallet_assets')

  // TARGET-PATH ATTRIBUTION: the quote must belong to the target's own swap path. Starting from the
  // target outflow (exit), the wallet's quote outflow, or the tx.value wrap (entry), every pool that
  // emitted a Swap must be reachable through this tx's token flows; no token may enter the path from
  // an outside address; and no non-pool intermediary may keep an output (only the target token may
  // land with a third party — transfer tax). Otherwise the same receipt funds or pays out more than
  // one economic action and the quote cannot be attributed.
  const attribution = attributeTargetPath({
    chain, wallet, target, logs: tx.logs,
    startNodes: side === 'exit' || walletQuoteLegs.length > 0 ? [wallet] : depositDestinations(chain, tx.logs),
  })
  forensics.pathAttribution = attribution.status
  forensics.unrelatedOutputs = attribution.unrelatedOutputs
  if (attribution.status === 'unrelated_swap_path') return result('unrelated_swap_path_in_tx')
  if (attribution.status === 'unrelated_token_flow') return result('unrelated_token_flow_in_tx')
  if (attribution.status === 'unrelated_outputs') return result('unrelated_outputs_in_tx')

  // A wallet-touching WETH/stable quote leg is in the receipt but was missing from provider activity.
  if (walletQuoteLegs.length > 0) {
    const tokens = new Set(walletQuoteLegs.map((leg) => leg.token))
    if (tokens.size !== 1 || valueWei > ZERO) return result('multicall_unrelated_wallet_assets')
    const token = walletQuoteLegs[0].token
    const raw = walletQuoteLegs.reduce((sum, leg) => sum + BigInt(leg.raw), ZERO)
    const decimals = resolveTokenDecimals({ chain, token }).decimals
    return result('quote_leg_omitted_from_provider_activity', {
      kind: isCanonicalWethAddress(chain, token) ? 'native' : 'stable',
      token,
      quantity: toUnits(raw, decimals),
    })
  }

  if (depositWei > ZERO && withdrawalWei > ZERO) return result('ambiguous_wrap_and_unwrap')
  if (side === 'entry') {
    if (valueWei === ZERO) return result('swap_without_reconstructable_quote_leg')
    // The full tx.value must be wrapped into the swap; any difference is an unaccounted refund or
    // unrelated native spend in the same call.
    if (depositWei !== valueWei) return result('native_refund_unaccounted')
    return result('native_eth_paid_via_tx_value', { kind: 'native', token: 'native', quantity: toUnits(valueWei, 18) })
  }
  if (valueWei > ZERO) return result('native_spend_on_exit_unaccounted')
  if (withdrawalWei === ZERO) return result('swap_without_reconstructable_quote_leg')
  // The unwrapped WETH must have arrived at the unwrapping address in this same tx (swap output),
  // never a router's pre-existing balance.
  const wethIntoUnwrappers = [...withdrawalSources].reduce((sum, src) => sum + (wethInByAddress.get(src) ?? ZERO), ZERO)
  if (wethIntoUnwrappers < withdrawalWei) return result('unwrap_not_backed_by_swap_output')

  // RECIPIENT PROOF. The receipt ends at the unwrap; only an internal-transfer trace shows where the
  // native ETH went. Router conventions are never treated as evidence.
  const internal = tx.internalTransfers
  if (!internal) return result('native_unwrap_recipient_unverified')
  const unwrappers = withdrawalSources
  const positive = internal.filter((t) => /^[0-9]+$/.test(t.valueWei) && BigInt(t.valueWei) > ZERO)
  const toWallet = positive.filter((t) => lower(t.to) === wallet)
  const walletFromUnwrapper = toWallet.filter((t) => unwrappers.has(lower(t.from))).reduce((sum, t) => sum + BigInt(t.valueWei), ZERO)
  const unwrapperOut = positive.filter((t) => unwrappers.has(lower(t.from))).reduce((sum, t) => sum + BigInt(t.valueWei), ZERO)
  forensics.walletNativeReceivedWei = walletFromUnwrapper.toString()
  forensics.unwrapperNativeOutWei = unwrapperOut.toString()
  if (walletFromUnwrapper === ZERO) return result(toWallet.length > 0 ? 'native_payout_attribution_ambiguous' : 'native_unwrap_recipient_not_wallet')
  // Deterministic attribution only: the wallet's native comes solely from the unwrapper, and the
  // unwrapper pays out exactly what it unwrapped (a split, e.g. a router fee, is accepted only when
  // every wei is accounted for; the wallet is credited with its own proven share, never the gross).
  if (toWallet.some((t) => !unwrappers.has(lower(t.from)))) return result('native_payout_attribution_ambiguous')
  if (unwrapperOut !== withdrawalWei) return result('native_payout_attribution_ambiguous')
  return result('native_eth_received_via_router_unwrap_verified', { kind: 'native', token: 'native', quantity: toUnits(walletFromUnwrapper, 18) })
}

function depositDestinations(chain: SupportedChain, logs: readonly ReceiptQuoteLog[]): string[] {
  return logs
    .filter((l) => isCanonicalWethAddress(chain, lower(l.address)) && lower(l.topics[0]) === WETH_DEPOSIT_TOPIC0)
    .map((l) => topicAddress(l.topics[1]))
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// PURE. See the TARGET-PATH ATTRIBUTION note in classifyReceiptQuoteEvidence.
export function attributeTargetPath(params: {
  chain: SupportedChain
  wallet: string
  target: string
  logs: readonly ReceiptQuoteLog[]
  startNodes: readonly string[]
}): { status: 'single_target_path' | 'unrelated_swap_path' | 'unrelated_token_flow' | 'unrelated_outputs'; unrelatedOutputs: ReceiptQuoteForensics['unrelatedOutputs'] } {
  const { chain, wallet, target, logs } = params
  const transfers = logs
    .filter((l) => lower(l.topics[0]) === TRANSFER_TOPIC0 && l.topics.length >= 3)
    .map((l) => ({ token: lower(l.address), from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), raw: dataWord(l.data) }))
  const emitters = new Set(logs.filter((l) => SWAP_TOPIC0S[lower(l.topics[0])]).map((l) => lower(l.address)))
  // Reachability from the start nodes over this tx's token flows (never back out of the wallet).
  const reached = new Set(params.startNodes.map(lower))
  let grew = true
  while (grew) {
    grew = false
    for (const t of transfers) {
      if (reached.has(t.from) && !reached.has(t.to) && t.to !== wallet) {
        reached.add(t.to)
        grew = true
      }
    }
  }
  if ([...emitters].some((pool) => !reached.has(pool))) return { status: 'unrelated_swap_path', unrelatedOutputs: [] }
  if (transfers.some((t) => !reached.has(t.from) && t.from !== wallet && t.from !== ZERO_ADDRESS)) return { status: 'unrelated_token_flow', unrelatedOutputs: [] }
  // Net per (address, token): WETH deposits credit the wrapper, withdrawals debit the unwrapper.
  const nets = new Map<string, bigint>()
  const add = (address: string, token: string, delta: bigint) => nets.set(`${address}|${token}`, (nets.get(`${address}|${token}`) ?? ZERO) + delta)
  for (const t of transfers) {
    add(t.from, t.token, -t.raw)
    add(t.to, t.token, t.raw)
  }
  for (const l of logs) {
    const address = lower(l.address)
    if (!isCanonicalWethAddress(chain, address)) continue
    const topic0 = lower(l.topics[0])
    if (topic0 === WETH_DEPOSIT_TOPIC0) add(topicAddress(l.topics[1]), address, dataWord(l.data))
    if (topic0 === WETH_WITHDRAWAL_TOPIC0) add(topicAddress(l.topics[1]), address, -dataWord(l.data))
  }
  const unrelatedOutputs: ReceiptQuoteForensics['unrelatedOutputs'] = []
  for (const [key, net] of nets) {
    const [address, token] = key.split('|')
    if (net === ZERO || address === wallet || address === ZERO_ADDRESS || emitters.has(address)) continue
    if (isCanonicalWethAddress(chain, address)) continue
    if (token === target && net > ZERO) continue // transfer tax on the target token itself
    unrelatedOutputs.push({ address, token, netRaw: net.toString() })
  }
  if (unrelatedOutputs.length > 0) return { status: 'unrelated_outputs', unrelatedOutputs }
  return { status: 'single_target_path', unrelatedOutputs }
}

// Mined transactions are immutable — a process-lifetime cache never serves stale data.
const receiptQuoteTxCache = new Map<string, ReceiptQuoteTx>()
export function __resetReceiptQuoteTxCacheForTest(): void {
  receiptQuoteTxCache.clear()
}

// One JSON-RPC batch (eth_getTransactionReceipt + eth_getTransactionByHash). Never throws.
export const fetchReceiptQuoteTx: ReceiptQuoteTxFetcher = async (chain, txHash) => {
  const cacheKey = `${chain}:${txHash.toLowerCase()}`
  const cached = receiptQuoteTxCache.get(cacheKey)
  if (cached) return cached
  const url = receiptRpcUrl(chain)
  if (!url) return { status: 'unavailable' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] },
        { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionByHash', params: [txHash] },
      ]),
    })
    if (!res.ok) return { status: 'unavailable' }
    const json = await res.json().catch(() => null) as Array<{ id?: number; result?: Record<string, unknown> | null }> | null
    if (!Array.isArray(json)) return { status: 'unavailable' }
    const receipt = json.find((r) => r.id === 1)?.result
    const tx = json.find((r) => r.id === 2)?.result
    if (!receipt || !tx) return { status: 'missing' }
    if (receipt.status === '0x0') {
      receiptQuoteTxCache.set(cacheKey, { status: 'reverted' })
      return { status: 'reverted' }
    }
    const logs = Array.isArray(receipt.logs) ? (receipt.logs as Array<Record<string, unknown>>) : []
    const value = typeof tx.value === 'string' && /^0x[0-9a-f]*$/i.test(tx.value) ? BigInt(tx.value === '0x' ? '0x0' : tx.value).toString() : '0'
    const outcome: ReceiptQuoteTx = {
      status: 'ok',
      from: typeof tx.from === 'string' ? tx.from : '',
      to: typeof tx.to === 'string' ? tx.to : null,
      valueWei: value,
      input: typeof tx.input === 'string' ? tx.input : '',
      logs: logs
        .filter((l) => l.removed !== true && typeof l.address === 'string' && Array.isArray(l.topics) && typeof l.data === 'string')
        .map((l) => ({ address: l.address as string, topics: l.topics as string[], data: l.data as string })),
    }
    // Native recipient proof is needed only when the receipt shows a WETH unwrap.
    if (outcome.status === 'ok' && outcome.logs.some((l) => lower(l.topics[0]) === WETH_WITHDRAWAL_TOPIC0)) {
      const trace = await fetchInternalNativeTransfers(chain, txHash, url)
      outcome.internalTransfers = trace?.transfers ?? null
      outcome.traceSource = trace?.source ?? null
    }
    // A missing trace may be a transient provider failure: only fully evidenced results are cached.
    if (outcome.status !== 'ok' || outcome.internalTransfers !== null) receiptQuoteTxCache.set(cacheKey, outcome)
    return outcome
  } catch {
    return { status: 'unavailable' }
  } finally {
    clearTimeout(timeout)
  }
}

type CallFrame = { type?: string; from?: string; to?: string; value?: string; error?: string; calls?: CallFrame[] }

// PURE. Flattens a callTracer result into executed internal value transfers. The top-level frame is
// the transaction itself (tx.value), not an internal transfer; a reverted frame and everything below
// it moved nothing.
export function internalTransfersFromCallTrace(root: CallFrame): InternalNativeTransfer[] {
  const out: InternalNativeTransfer[] = []
  const walk = (frame: CallFrame, depth: number) => {
    if (frame.error) return
    if (depth > 0 && typeof frame.value === 'string' && /^0x[0-9a-f]+$/i.test(frame.value) && BigInt(frame.value) > ZERO
      && typeof frame.from === 'string' && typeof frame.to === 'string' && (frame.type ?? 'CALL').toUpperCase() !== 'DELEGATECALL') {
      out.push({ from: frame.from.toLowerCase(), to: frame.to.toLowerCase(), valueWei: BigInt(frame.value).toString() })
    }
    for (const child of frame.calls ?? []) walk(child, depth + 1)
  }
  walk(root, 0)
  return out
}

const BLOCKSCOUT_API: Partial<Record<SupportedChain, string>> = {
  base: 'https://base.blockscout.com',
  eth: 'https://eth.blockscout.com',
}

// PURE. Blockscout v2 internal-transactions page → executed internal value transfers. Returns null
// when the page is paginated (incomplete evidence is no evidence) or malformed.
export function internalTransfersFromBlockscout(json: unknown): InternalNativeTransfer[] | null {
  const body = json as { items?: Array<Record<string, unknown>>; next_page_params?: unknown } | null
  if (!body || !Array.isArray(body.items) || body.next_page_params != null) return null
  const out: InternalNativeTransfer[] = []
  for (const item of body.items) {
    const from = (item.from as { hash?: string } | null)?.hash
    const to = (item.to as { hash?: string } | null)?.hash
    const value = typeof item.value === 'string' ? item.value : null
    if (item.success === false || !from || !to || !value || !/^[0-9]+$/.test(value) || value === '0') continue
    if (String(item.type ?? 'call').toLowerCase() === 'delegatecall') continue
    out.push({ from: from.toLowerCase(), to: to.toLowerCase(), valueWei: value })
  }
  return out
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// debug_traceTransaction (callTracer) on the configured RPC first; Blockscout's indexed internal
// transactions second. Null when neither yields complete evidence.
async function fetchInternalNativeTransfers(chain: SupportedChain, txHash: string, rpcUrl: string): Promise<{ transfers: InternalNativeTransfer[]; source: InternalTraceSource } | null> {
  const traced = await fetchJson(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_traceTransaction', params: [txHash, { tracer: 'callTracer' }] }),
  }) as { result?: CallFrame } | null
  if (traced?.result && typeof traced.result === 'object' && typeof traced.result.from === 'string') {
    return { transfers: internalTransfersFromCallTrace(traced.result), source: 'debug_trace_call_tracer' }
  }
  const base = BLOCKSCOUT_API[chain]
  if (!base) return null
  const indexed = internalTransfersFromBlockscout(await fetchJson(`${base}/api/v2/transactions/${txHash}/internal-transactions`, { headers: { accept: 'application/json' } }))
  return indexed ? { transfers: indexed, source: 'blockscout_internal_transactions' } : null
}
