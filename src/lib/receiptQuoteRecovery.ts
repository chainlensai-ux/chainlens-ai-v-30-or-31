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
// `cacheHit` reports a process-cache/singleflight hit (no new provider call). `signal` carries the
// lane's scan-wide deadline.
export type ReceiptQuoteTxFetcher = (chain: SupportedChain, txHash: string, signal?: AbortSignal) => Promise<ReceiptQuoteTx & { cacheHit?: boolean }>

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
  // The wallet's only other asset is a single NON-canonical token on the quote side (e.g. paid with
  // or received a non-WETH/non-stable token): a token-to-token swap with no USD quote in the tx.
  | 'token_to_token_swap_no_canonical_quote'
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
  unrelatedOutputs: Array<{ address: string; token: string; netRaw: string; rule: string }>
  // Full deterministic dump (path-attribution audit). Every amount is a raw integer string.
  side: 'entry' | 'exit'
  targetToken: string
  targetAmountExpected: number
  targetAmountReproduced: number
  txFrom: string
  txTo: string | null
  swapEmitters: Array<{ address: string; venue: string }>
  walletLegsDetailed: Array<{ token: string; from: string; to: string; raw: string; normalized: number; direction: 'in' | 'out' }>
  nonWalletTransfers: Array<{ token: string; from: string; to: string; raw: string }>
  wethEvents: Array<{ type: 'deposit' | 'withdrawal'; account: string; raw: string }>
  unrelatedWalletLegs: Array<{ token: string; direction: 'in' | 'out'; raw: string; reason: string }>
  reachedPathNodes: string[]
  unreachableSwapEmitters: string[]
  outsideInputFlows: Array<{ token: string; from: string; to: string; raw: string }>
  // Native payout proof (sell via unwrap only).
  traceSource: InternalTraceSource | null
  walletNativeReceivedWei: string | null
  unwrapperNativeOutWei: string | null
}

export type ReceiptQuoteResult = {
  classification: ReceiptQuoteClassification
  // True only when every receipt check passed and the single missing piece is the native payout
  // recipient — the ONLY case the lane spends an internal-transfer trace request on.
  needsNativeRecipientProof?: boolean
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
  const walletLegsDetailed: ReceiptQuoteForensics['walletLegsDetailed'] = []
  const nonWalletTransfers: ReceiptQuoteForensics['nonWalletTransfers'] = []
  const wethEvents: ReceiptQuoteForensics['wethEvents'] = []
  for (const log of tx.logs) {
    const address = lower(log.address)
    const topic0 = lower(log.topics[0])
    if (SWAP_TOPIC0S[topic0]) swapEvents.push(SWAP_TOPIC0S[topic0])
    if (LIQUIDITY_TOPIC0S.has(topic0)) liquidityEvents += 1
    if (isCanonicalWethAddress(chain, address) && topic0 === WETH_DEPOSIT_TOPIC0) {
      depositWei += dataWord(log.data)
      wethEvents.push({ type: 'deposit', account: topicAddress(log.topics[1]), raw: dataWord(log.data).toString() })
    }
    if (isCanonicalWethAddress(chain, address) && topic0 === WETH_WITHDRAWAL_TOPIC0) {
      withdrawalWei += dataWord(log.data)
      withdrawalSources.add(topicAddress(log.topics[1]))
      wethEvents.push({ type: 'withdrawal', account: topicAddress(log.topics[1]), raw: dataWord(log.data).toString() })
    }
    if (topic0 !== TRANSFER_TOPIC0 || log.topics.length < 3) continue
    tokenAddresses.add(address)
    const from = topicAddress(log.topics[1])
    const to = topicAddress(log.topics[2])
    const raw = dataWord(log.data)
    if (isCanonicalWethAddress(chain, address)) wethInByAddress.set(to, (wethInByAddress.get(to) ?? ZERO) + raw)
    const normalized = toUnits(raw, address === target ? params.targetDecimals : resolveTokenDecimals({ chain, token: address }).decimals)
    if (from === wallet) {
      walletTouchingLegs.push({ token: address, direction: 'out', raw: raw.toString() })
      walletLegsDetailed.push({ token: address, from, to, raw: raw.toString(), normalized, direction: 'out' })
    } else if (to === wallet) {
      walletTouchingLegs.push({ token: address, direction: 'in', raw: raw.toString() })
      walletLegsDetailed.push({ token: address, from, to, raw: raw.toString(), normalized, direction: 'in' })
    } else {
      poolRouterOnlyLegs += 1
      nonWalletTransfers.push({ token: address, from, to, raw: raw.toString() })
    }
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
    side,
    targetToken: target,
    targetAmountExpected: params.targetAmount,
    targetAmountReproduced: 0,
    txFrom: lower(tx.from),
    txTo: tx.to ? lower(tx.to) : null,
    swapEmitters: tx.logs.filter((l) => SWAP_TOPIC0S[lower(l.topics[0])]).map((l) => ({ address: lower(l.address), venue: SWAP_TOPIC0S[lower(l.topics[0])] })),
    walletLegsDetailed,
    nonWalletTransfers,
    wethEvents,
    unrelatedWalletLegs: [],
    reachedPathNodes: [],
    unreachableSwapEmitters: [],
    outsideInputFlows: [],
  }
  const result = (classification: ReceiptQuoteClassification, quote: ReceiptQuoteResult['quote'] = null): ReceiptQuoteResult => ({ classification, quote, forensics })

  // The target leg itself must be exactly reproduced: wallet sends (exit) / receives (entry) the
  // target token, totalling the normalized amount the lot is built from.
  const targetDirection = side === 'entry' ? 'in' : 'out'
  const targetRaw = walletTouchingLegs
    .filter((leg) => leg.token === target && leg.direction === targetDirection)
    .reduce((sum, leg) => sum + BigInt(leg.raw), ZERO)
  const targetFromReceipt = toUnits(targetRaw, params.targetDecimals)
  forensics.targetAmountReproduced = targetFromReceipt
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
  // Every non-quote wallet leg carries the exact reason it is not attributable to the target swap.
  forensics.unrelatedWalletLegs = unrelatedWalletLegs.map((leg) => {
    const canonical = isCanonicalWethAddress(chain, leg.token) || isVerifiedStablecoinAddress(chain, leg.token)
    const reason = canonical
      ? 'canonical_quote_asset_in_opposite_direction (refund/change or a second action)'
      : leg.direction === quoteDirection
        ? side === 'entry' ? 'non_canonical_input_asset (wallet paid a non-WETH/non-stable token)' : 'non_canonical_output_asset (wallet received a non-WETH/non-stable token)'
        : side === 'entry' ? 'unrelated_asset_sent_by_wallet' : 'unrelated_asset_received_by_wallet'
    return { token: leg.token, direction: leg.direction, raw: leg.raw, reason }
  })

  // TARGET-PATH ATTRIBUTION: the quote must belong to the target's own swap path. Starting from the
  // target outflow (exit), the wallet's quote outflow, or the tx.value wrap (entry), every pool that
  // emitted a Swap must be reachable through this tx's token flows; no token may enter the path from
  // an outside address; and no non-pool intermediary may keep an output (only the target token may
  // land with a third party — transfer tax). Otherwise the same receipt funds or pays out more than
  // one economic action and the quote cannot be attributed. Always evaluated so the forensic dump is
  // complete, even when an earlier rule rejects the candidate.
  const attribution = attributeTargetPath({
    chain, wallet, target, logs: tx.logs,
    startNodes: side === 'exit' || walletQuoteLegs.length > 0 ? [wallet] : depositDestinations(chain, tx.logs),
  })
  forensics.pathAttribution = attribution.status
  forensics.unrelatedOutputs = attribution.unrelatedOutputs
  forensics.reachedPathNodes = attribution.reachedPathNodes
  forensics.unreachableSwapEmitters = attribution.unreachableSwapEmitters
  forensics.outsideInputFlows = attribution.outsideInputFlows

  if (swapEvents.length === 0) return result('non_swap_contract_interaction')
  if (unrelatedWalletLegs.length > 0) {
    // Same rejection as before, named precisely: a single non-canonical token on the quote side with
    // no other quote evidence is a token-to-token swap (no USD quote exists in this tx), not a
    // multicall. Anything else stays multicall_unrelated_wallet_assets.
    const singleNonCanonicalQuoteSide = unrelatedWalletLegs.length > 0
      && new Set(unrelatedWalletLegs.map((leg) => leg.token)).size === 1
      && unrelatedWalletLegs.every((leg) => leg.direction === quoteDirection && !isCanonicalWethAddress(chain, leg.token) && !isVerifiedStablecoinAddress(chain, leg.token))
      && walletQuoteLegs.length === 0 && valueWei === ZERO && depositWei === ZERO && withdrawalWei === ZERO
    return result(singleNonCanonicalQuoteSide ? 'token_to_token_swap_no_canonical_quote' : 'multicall_unrelated_wallet_assets')
  }
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
  if (internal === undefined) return { ...result('native_unwrap_recipient_unverified'), needsNativeRecipientProof: true }
  if (internal === null) return result('native_unwrap_recipient_unverified')
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
}): {
  status: 'single_target_path' | 'unrelated_swap_path' | 'unrelated_token_flow' | 'unrelated_outputs'
  unrelatedOutputs: ReceiptQuoteForensics['unrelatedOutputs']
  reachedPathNodes: string[]
  unreachableSwapEmitters: string[]
  outsideInputFlows: ReceiptQuoteForensics['outsideInputFlows']
} {
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
  const unreachableSwapEmitters = [...emitters].filter((pool) => !reached.has(pool)).sort()
  const outsideInputFlows = transfers
    .filter((t) => !reached.has(t.from) && t.from !== wallet && t.from !== ZERO_ADDRESS)
    .map((t) => ({ token: t.token, from: t.from, to: t.to, raw: t.raw.toString() }))
  const detail = { reachedPathNodes: [...reached].sort(), unreachableSwapEmitters, outsideInputFlows }
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
    unrelatedOutputs.push({
      address, token, netRaw: net.toString(),
      rule: net > ZERO
        ? 'non_pool_intermediary_keeps_non_target_token (net inflow not forwarded along the target path)'
        : 'non_pool_intermediary_spends_more_than_it_received (unbacked outflow)',
    })
  }
  // Same precedence as before: unreachable swap path, then outside inputs, then retained outputs.
  if (unreachableSwapEmitters.length > 0) return { status: 'unrelated_swap_path', unrelatedOutputs, ...detail }
  if (outsideInputFlows.length > 0) return { status: 'unrelated_token_flow', unrelatedOutputs, ...detail }
  if (unrelatedOutputs.length > 0) return { status: 'unrelated_outputs', unrelatedOutputs, ...detail }
  return { status: 'single_target_path', unrelatedOutputs, ...detail }
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

// ================================================================================================
// FETCHING — bounded, deadline-aware, fail-closed.
// ================================================================================================

export type JsonFetch = { kind: 'ok'; status: number; json: unknown } | { kind: 'http_error'; status: number; json: unknown } | { kind: 'timeout' } | { kind: 'network_error' }

const RECEIPT_REQUEST_TIMEOUT_MS = 5000
const TRACE_REQUEST_TIMEOUT_MS = 4000

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
}

async function fetchJson(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<JsonFetch> {
  if (signal?.aborted) return { kind: 'timeout' }
  try {
    const res = await fetchImpl(url, { ...init, signal: combinedSignal(timeoutMs, signal) })
    const json = await res.json().catch(() => null)
    return res.ok ? { kind: 'ok', status: res.status, json } : { kind: 'http_error', status: res.status, json }
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : ''
    return name === 'AbortError' || name === 'TimeoutError' ? { kind: 'timeout' } : { kind: 'network_error' }
  }
}

// Mined transactions are immutable — a process-lifetime cache never serves stale data. In-flight
// reads are shared (singleflight) so two lots on the same tx, or two concurrent scans, fetch once.
// (receiptSwapDecoder's permanent receipt cache and the ROI backfill KV hold receipt LOGS only — no
// sender / tx.value / input — so they cannot satisfy this lane's evidence and are not reused.)
const receiptQuoteTxCache = new Map<string, ReceiptQuoteTx>()
const receiptQuoteTxInFlight = new Map<string, Promise<ReceiptQuoteTx>>()
export function __resetReceiptQuoteTxCacheForTest(): void {
  receiptQuoteTxCache.clear()
  receiptQuoteTxInFlight.clear()
}

export function createReceiptQuoteTxFetcher(deps: { fetchImpl?: typeof fetch; rpcUrlFor?: (chain: SupportedChain) => string | null; timeoutMs?: number } = {}): ReceiptQuoteTxFetcher {
  const fetchImpl = deps.fetchImpl ?? fetch
  const rpcUrlFor = deps.rpcUrlFor ?? receiptRpcUrl
  const timeoutMs = deps.timeoutMs ?? RECEIPT_REQUEST_TIMEOUT_MS
  return async (chain, txHash, signal) => {
    const cacheKey = `${chain}:${txHash.toLowerCase()}`
    const cached = receiptQuoteTxCache.get(cacheKey)
    if (cached) return { ...cached, cacheHit: true }
    if (signal?.aborted) return { status: 'unavailable' }
    const inFlight = receiptQuoteTxInFlight.get(cacheKey)
    if (inFlight) {
      const joined = await raceCallerDeadline(inFlight, signal)
      return joined ? { ...joined, cacheHit: true } : { status: 'unavailable' }
    }
    const url = rpcUrlFor(chain)
    if (!url) return { status: 'unavailable' }
    // SHARED WORK IS NOT TIED TO ANY CALLER: the provider request runs under its own strict timeout,
    // never a scan's deadline signal. Each caller only stops WAITING at its own deadline, so one scan
    // running out of time can never cancel an immutable read another concurrent scan still needs.
    const work = (async (): Promise<ReceiptQuoteTx> => {
      const response = await fetchJson(fetchImpl, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] },
          { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionByHash', params: [txHash] },
        ]),
      }, timeoutMs)
      if (response.kind !== 'ok' || !Array.isArray(response.json)) return { status: 'unavailable' }
      const rows = response.json as Array<{ id?: number; result?: Record<string, unknown> | null }>
      const receipt = rows.find((r) => r.id === 1)?.result
      const tx = rows.find((r) => r.id === 2)?.result
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
      receiptQuoteTxCache.set(cacheKey, outcome)
      return outcome
    })()
    receiptQuoteTxInFlight.set(cacheKey, work)
    // Removed from the in-flight map when the WORK settles (not when this caller gives up). Only
    // successful/reverted results are process-cached; unavailable/missing are never persisted.
    work.finally(() => receiptQuoteTxInFlight.delete(cacheKey)).catch(() => undefined)
    const own = await raceCallerDeadline(work, signal)
    return own ?? { status: 'unavailable' }
  }
}

export const fetchReceiptQuoteTx: ReceiptQuoteTxFetcher = createReceiptQuoteTxFetcher()

// Resolves with the shared promise's value, or null as soon as THIS caller's signal aborts. The
// abort listener is always removed, so a long-lived shared promise never accumulates listeners.
export function raceCallerDeadline<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(null)
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

// --------------------------------------------------------------------------- internal transfers ---

export type TraceAttemptOutcome =
  | 'ok' | 'ok_empty' | 'unsupported' | 'timeout' | 'provider_error' | 'incomplete' | 'malformed' | 'skipped_unsupported' | 'not_configured'
export type TraceAttempt = { source: 'debug_trace' | 'blockscout'; outcome: TraceAttemptOutcome }
export type InternalTransferEvidence = {
  // null = no complete evidence (never guessed); [] = a valid trace with no internal value transfers.
  transfers: InternalNativeTransfer[] | null
  source: InternalTraceSource | null
  attempts: TraceAttempt[]
}
export type InternalTransferFetcher = (chain: SupportedChain, txHash: string, signal?: AbortSignal) => Promise<InternalTransferEvidence>

const UNSUPPORTED_TRACE_MESSAGE = /not supported|unsupported|not available|does not exist|not found|method not allowed|not enabled|upgrade|tracer/i

// PURE. Classifies one debug_traceTransaction response. Only an explicit "this method/tracer is not
// available" answer is `unsupported`; HTTP 5xx, rate limits and odd payloads are provider errors
// (transient — they never disable tracing for the rest of the scan).
export function classifyTraceResponse(response: JsonFetch): { outcome: TraceAttemptOutcome; transfers: InternalNativeTransfer[] | null } {
  if (response.kind === 'timeout') return { outcome: 'timeout', transfers: null }
  if (response.kind === 'network_error') return { outcome: 'provider_error', transfers: null }
  const body = response.json as { result?: unknown; error?: { code?: number; message?: string } } | null
  const error = body?.error
  if (error && (error.code === -32601 || UNSUPPORTED_TRACE_MESSAGE.test(String(error.message ?? '')))) return { outcome: 'unsupported', transfers: null }
  if (response.kind === 'http_error') {
    return { outcome: response.status === 405 || response.status === 501 ? 'unsupported' : 'provider_error', transfers: null }
  }
  const root = body?.result as CallFrame | undefined
  if (!root || typeof root !== 'object' || typeof root.from !== 'string') return { outcome: error ? 'provider_error' : 'malformed', transfers: null }
  const transfers = internalTransfersFromCallTrace(root)
  return { outcome: transfers.length > 0 ? 'ok' : 'ok_empty', transfers }
}

// One tracer per scan. debug_traceTransaction is probed first; once the configured RPC explicitly
// reports the method/tracer as unsupported, later candidates in THIS scan go straight to Blockscout.
// A timeout or provider error never disables tracing.
export function createInternalTransferTracer(deps: {
  fetchImpl?: typeof fetch
  rpcUrlFor?: (chain: SupportedChain) => string | null
  blockscoutBaseFor?: (chain: SupportedChain) => string | null
  traceTimeoutMs?: number
  blockscoutTimeoutMs?: number
} = {}): InternalTransferFetcher & { traceUnsupported: (chain: SupportedChain) => boolean } {
  const fetchImpl = deps.fetchImpl ?? fetch
  const rpcUrlFor = deps.rpcUrlFor ?? receiptRpcUrl
  const blockscoutBaseFor = deps.blockscoutBaseFor ?? ((chain: SupportedChain) => BLOCKSCOUT_API[chain] ?? null)
  const traceTimeoutMs = deps.traceTimeoutMs ?? TRACE_REQUEST_TIMEOUT_MS
  const blockscoutTimeoutMs = deps.blockscoutTimeoutMs ?? TRACE_REQUEST_TIMEOUT_MS
  // Per-chain support state for THIS scan. While support is unknown, only one probe is in flight:
  // concurrent candidates wait for it instead of each probing an RPC that may not support tracing.
  const support = new Map<SupportedChain, 'supported' | 'unsupported'>()
  const probes = new Map<SupportedChain, Promise<unknown>>()
  const tracer = async (chain: SupportedChain, txHash: string, signal?: AbortSignal): Promise<InternalTransferEvidence> => {
    const attempts: TraceAttempt[] = []
    const rpcUrl = rpcUrlFor(chain)
    if (!support.has(chain) && probes.has(chain)) await probes.get(chain)
    if (support.get(chain) === 'unsupported') attempts.push({ source: 'debug_trace', outcome: 'skipped_unsupported' })
    else if (!rpcUrl) attempts.push({ source: 'debug_trace', outcome: 'not_configured' })
    else {
      const request = fetchJson(fetchImpl, rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'debug_traceTransaction', params: [txHash, { tracer: 'callTracer' }] }),
      }, traceTimeoutMs, signal).then(classifyTraceResponse)
      const isProbe = !support.has(chain) && !probes.has(chain)
      if (isProbe) probes.set(chain, request.catch(() => null))
      const traced = await request
      if (isProbe) probes.delete(chain)
      attempts.push({ source: 'debug_trace', outcome: traced.outcome })
      // Only an explicit "unsupported" answer changes the scan's state; a timeout or provider error
      // leaves it unknown, so the next candidate probes again.
      if (traced.outcome === 'unsupported') support.set(chain, 'unsupported')
      if (traced.transfers) {
        support.set(chain, 'supported')
        return { transfers: traced.transfers, source: 'debug_trace_call_tracer', attempts }
      }
    }
    const base = blockscoutBaseFor(chain)
    if (!base) {
      attempts.push({ source: 'blockscout', outcome: 'not_configured' })
      return { transfers: null, source: null, attempts }
    }
    if (signal?.aborted) {
      attempts.push({ source: 'blockscout', outcome: 'timeout' })
      return { transfers: null, source: null, attempts }
    }
    const response = await fetchJson(fetchImpl, `${base}/api/v2/transactions/${txHash}/internal-transactions`, { headers: { accept: 'application/json' } }, blockscoutTimeoutMs, signal)
    if (response.kind !== 'ok') {
      attempts.push({ source: 'blockscout', outcome: response.kind === 'timeout' ? 'timeout' : 'provider_error' })
      return { transfers: null, source: null, attempts }
    }
    const body = response.json as { next_page_params?: unknown } | null
    const indexed = internalTransfersFromBlockscout(response.json)
    if (!indexed) {
      attempts.push({ source: 'blockscout', outcome: body && body.next_page_params != null ? 'incomplete' : 'malformed' })
      return { transfers: null, source: null, attempts }
    }
    attempts.push({ source: 'blockscout', outcome: indexed.length > 0 ? 'ok' : 'ok_empty' })
    return { transfers: indexed, source: 'blockscout_internal_transactions', attempts }
  }
  return Object.assign(tracer, { traceUnsupported: (chain: SupportedChain) => support.get(chain) === 'unsupported' })
}
