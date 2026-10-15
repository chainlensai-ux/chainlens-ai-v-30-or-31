// UNISWAP V4 SELL PROOF (behind WALLET_V4_SELL_PROOF=1). Called by sellReceiptProof.ts for a one-legged
// outbound event whose receipt contains Uniswap V4 swaps, which the pool-based decoder cannot read: V4
// settles every hop inside the PoolManager, so there is no pool contract and no per-pool Transfer.
//
// Accepted (`v4_exact_route`) only when ALL hold:
//   1. every swap event in the tx is a V4 Swap from the chain's canonical PoolManager (no mixed venues);
//   2. no ModifyLiquidity, Donate, or V2/V3/Aerodrome Mint/Burn anywhere in the tx;
//   3. every poolId's currencies are proven by its Initialize on that PoolManager (cached resolver);
//   4. the only token the wallet sends is the sold token (or, for native ETH, the wallet sent the tx
//      and its ETH value funds the first hop);
//   5. the token the PoolManager receives equals the first hop's input exactly, and it descends from
//      the wallet's own debit (attributeTargetPath: single_target_path — nothing from outside);
//   6. ALL V4 swaps in the tx form one connected route in log order from that token (one sign
//      convention, never mixed), hop-to-hop leftovers within MAX_PATH_FEE_FRACTION — exactly one such
//      reading; a swap off the route rejects;
//   7. the route's output reaches the wallet: an ERC-20 Transfer to the wallet, or — for native ETH /
//      unwrapped WETH — an internal-transfer trace proving the ETH reached the wallet.
// Same rules whether the wallet or a relayer sent the tx (a relayed native payout always needs the trace).
// Anything else rejects with a named reason. Pure over its injected resolvers.

import { toEventSelector } from 'viem'
import { attributeTargetPath, LIQUIDITY_TOPIC0S, SWAP_TOPIC0S, TRANSFER_TOPIC0, type InternalNativeTransfer } from '../../lib/receiptQuoteRecovery'
import { MAX_PATH_FEE_FRACTION, NATIVE_CURRENCY, V4_POOL_MANAGERS, V4_SWAP_TOPIC0, type V4PoolCurrencies } from '../../lib/v4RouteQuote'
import { wethAddressFor } from './signatures'
import type { RawReceiptLog } from './types'

export const V4_DONATE_TOPIC0 = toEventSelector('Donate(bytes32,address,uint256,uint256)')
// Aerodrome Classic's Burn differs from Uniswap V2's (already in LIQUIDITY_TOPIC0S).
const AERODROME_CLASSIC_BURN_TOPIC0 = toEventSelector('Burn(address,address,uint256,uint256)')
/** The pseudo-address normalized events use for native ETH. */
export const NATIVE_EVENT_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

export type V4SellRejection =
  | 'no_v4_swap' | 'mixed_venue' | 'liquidity_or_donate_in_tx' | 'pool_key_unproven' | 'malformed_swap_delta'
  | 'wallet_sent_other_token' | 'wallet_did_not_send_token' | 'native_input_unproven' | 'input_amount_mismatch'
  | 'token_not_from_wallet' | 'route_does_not_chain' | 'swap_off_route' | 'ambiguous_route'
  | 'output_not_to_wallet' | 'native_payout_unproven'

export type V4SellDeps = {
  resolvePoolKeys: (chain: 'base' | 'eth', poolIds: readonly string[]) => Promise<Map<string, V4PoolCurrencies>>
  /** Executed internal ETH transfers of this tx; null when no complete trace could be obtained. */
  fetchInternalTransfers?: (chain: 'base' | 'eth', txHash: string) => Promise<InternalNativeTransfer[] | null>
  /** The tx's sender and ETH value; only needed when the sold "token" is native ETH. */
  fetchTxSenderAndValue?: (chain: 'base' | 'eth', txHash: string) => Promise<{ from: string; valueWei: string } | null>
}

const ZERO = BigInt(0)
const lower = (s: string | null | undefined) => (s ?? '').toLowerCase()
function signedWord(data: string, index: number): bigint | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const word = hex.slice(index * 64, index * 64 + 64)
  if (word.length !== 64 || !/^[0-9a-f]+$/i.test(word)) return null
  const v = BigInt(`0x${word}`)
  return v >= BigInt(2) ** BigInt(255) ? v - BigInt(2) ** BigInt(256) : v
}
function topicAddress(topic: string | undefined): string {
  return topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : ''
}
const abs = (v: bigint) => (v < ZERO ? -v : v)
function withinFee(leftover: bigint, flow: bigint): boolean {
  if (leftover < ZERO) return false
  if (leftover === ZERO) return true
  return leftover * BigInt(10_000) <= flow * BigInt(Math.round(MAX_PATH_FEE_FRACTION * 10_000))
}

type Hop = { inCurrency: string; outCurrency: string; in: bigint; out: bigint }

export async function proveV4SellFromReceipt(params: {
  chain: 'base' | 'eth'
  txHash: string
  walletAddress: string
  token: string
  logs: readonly RawReceiptLog[]
  deps: V4SellDeps
}): Promise<{ proof: 'v4_exact_route' } | { proof: null; rejection: V4SellRejection }> {
  const reject = (rejection: V4SellRejection) => ({ proof: null, rejection }) as const
  const { chain, logs, deps } = params
  const wallet = lower(params.walletAddress)
  const manager = V4_POOL_MANAGERS[chain]
  const weth = wethAddressFor(chain)
  const nativeSold = lower(params.token) === NATIVE_EVENT_ADDRESS
  const token = nativeSold ? NATIVE_CURRENCY : lower(params.token)
  if (!manager) return reject('no_v4_swap')

  if (logs.some((l) => {
    const t = lower(l.topics[0])
    return LIQUIDITY_TOPIC0S.has(t) || t === V4_DONATE_TOPIC0 || t === AERODROME_CLASSIC_BURN_TOPIC0
  })) return reject('liquidity_or_donate_in_tx')

  const swapLogs = logs.filter((l) => SWAP_TOPIC0S[lower(l.topics[0])])
  const v4Swaps = swapLogs.filter((l) => lower(l.topics[0]) === V4_SWAP_TOPIC0 && lower(l.address) === manager)
  if (v4Swaps.length === 0) return reject('no_v4_swap')
  if (v4Swaps.length !== swapLogs.length) return reject('mixed_venue')

  const poolIds = [...new Set(v4Swaps.map((l) => lower(l.topics[1])))]
  const keys = await deps.resolvePoolKeys(chain, poolIds).catch(() => new Map<string, V4PoolCurrencies>())
  if (poolIds.some((id) => !keys.has(id))) return reject('pool_key_unproven')

  const raw = v4Swaps.map((l) => ({ key: keys.get(lower(l.topics[1]))!, a0: signedWord(l.data, 0), a1: signedWord(l.data, 1) }))
  if (raw.some((h) => h.a0 == null || h.a1 == null || h.a0 === ZERO || h.a1 === ZERO || (h.a0 < ZERO) === (h.a1 < ZERO))) {
    return reject('malformed_swap_delta')
  }

  // Wallet-side input.
  const transfers = logs
    .filter((l) => lower(l.topics[0]) === TRANSFER_TOPIC0 && l.topics.length >= 3)
    .map((l) => ({ token: lower(l.address), from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), value: signedWord(l.data, 0) ?? ZERO }))
  const walletDebits = transfers.filter((t) => t.from === wallet)
  let nativeInputWei: bigint | null = null
  if (nativeSold) {
    if (walletDebits.length > 0) return reject('wallet_sent_other_token')
    const tx = deps.fetchTxSenderAndValue ? await deps.fetchTxSenderAndValue(chain, params.txHash).catch(() => null) : null
    if (!tx || lower(tx.from) !== wallet || !/^\d+$/.test(tx.valueWei) || BigInt(tx.valueWei) === ZERO) return reject('native_input_unproven')
    nativeInputWei = BigInt(tx.valueWei)
  } else {
    if (walletDebits.some((t) => t.token !== token)) return reject('wallet_sent_other_token')
    if (!walletDebits.some((t) => t.value > ZERO)) return reject('wallet_did_not_send_token')
  }

  // Exactly one sign convention must chain EVERY V4 swap, in log order, starting at the sold token.
  const readings: Hop[][] = []
  let prefixChained = false
  for (const negativeIsInput of [true, false]) {
    const hops: Hop[] = raw.map((h) => {
      const zeroIsIn = (h.a0! < ZERO) === negativeIsInput
      return {
        inCurrency: lower(zeroIsIn ? h.key.currency0 : h.key.currency1),
        outCurrency: lower(zeroIsIn ? h.key.currency1 : h.key.currency0),
        in: abs(zeroIsIn ? h.a0! : h.a1!), out: abs(zeroIsIn ? h.a1! : h.a0!),
      }
    })
    if (hops[0].inCurrency !== token) continue
    let chained = 1
    for (; chained < hops.length; chained += 1) {
      const prev = hops[chained - 1]
      const next = hops[chained]
      if (next.inCurrency !== prev.outCurrency || next.in > prev.out || !withinFee(prev.out - next.in, prev.out)) break
    }
    if (chained === hops.length) readings.push(hops)
    else prefixChained = true
  }
  if (readings.length > 1) return reject('ambiguous_route')
  if (readings.length === 0) return reject(prefixChained ? 'swap_off_route' : 'route_does_not_chain')
  const route = readings[0]
  const first = route[0]
  const last = route[route.length - 1]

  // The swapped input is exactly what reached the PoolManager, and it came from the wallet.
  if (nativeSold) {
    if (first.in > nativeInputWei! || !withinFee(nativeInputWei! - first.in, nativeInputWei!)) return reject('input_amount_mismatch')
  } else {
    const intoManager = transfers.filter((t) => t.token === token && t.to === manager).reduce((sum, t) => sum + t.value, ZERO)
    if (intoManager !== first.in) return reject('input_amount_mismatch')
    const path = attributeTargetPath({ chain, wallet, target: token, logs: logs as RawReceiptLog[], startNodes: [wallet] })
    if (path.status !== 'single_target_path') return reject('token_not_from_wallet')
  }

  // The output reached the wallet.
  const output = last.outCurrency
  const erc20ToWallet = transfers.filter((t) => t.token === output && t.to === wallet).reduce((sum, t) => sum + t.value, ZERO)
  const nativeOut = output === NATIVE_CURRENCY || (output === weth && erc20ToWallet === ZERO)
  if (!nativeOut) {
    if (erc20ToWallet === ZERO || erc20ToWallet > last.out || !withinFee(last.out - erc20ToWallet, last.out)) return reject('output_not_to_wallet')
    return { proof: 'v4_exact_route' }
  }
  const internal = deps.fetchInternalTransfers ? await deps.fetchInternalTransfers(chain, params.txHash).catch(() => null) : null
  if (internal == null) return reject('native_payout_unproven')
  const toWallet = internal.filter((t) => lower(t.to) === wallet).reduce((sum, t) => sum + (/^\d+$/.test(t.valueWei) ? BigInt(t.valueWei) : ZERO), ZERO)
  if (toWallet === ZERO || toWallet > last.out || !withinFee(last.out - toWallet, last.out)) return reject('native_payout_unproven')
  return { proof: 'v4_exact_route' }
}
