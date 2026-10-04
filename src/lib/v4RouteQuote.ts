// MODULE — v4RouteQuote
//
// Token-to-token receipt quotes through Uniswap V4. Production shape (1clawAI, Base): the wallet pays
// a NON-canonical token X and receives the target T through a 3-hop V4 route, e.g.
//
//     X --pool1--> ETH --pool2--> B --pool3--> T
//
// V4 settles every hop inside the PoolManager (flash accounting), so the intermediate currencies
// never appear as wallet transfers. Each hop's Swap event still carries the exact signed currency
// deltas, and each pool's own Initialize event proves which two currencies it trades. When the hops
// chain into ONE deterministic path from the wallet's input to the wallet's output, and that path
// passes through native ETH / canonical WETH / a verified stablecoin, the exact amount of that
// canonical intermediary on the path is the trade's quote: amount × historical ETH/USD (or $1).
//
// Fail closed on anything else: a non-V4 swap in the tx, an unproven pool key, hops that do not chain,
// inconsistent swap direction, a route leftover larger than a bounded fee, a token outside the route,
// or no canonical intermediary. Never a symbol, never a current price.

import type { SupportedChain } from '../modules/providerFetchWindow/types'
import { isCanonicalWethAddress, isVerifiedStablecoinAddress } from '../modules/quoteLegPricing/index'
import { resolveTokenDecimals } from '../modules/normalization/canonicalDecimals'
import { receiptRpcUrl } from './roiQuoteLegTxBackfill'

export const V4_SWAP_TOPIC0 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
export const V4_INITIALIZE_TOPIC0 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const V4_POOL_MANAGERS: Partial<Record<SupportedChain, string>> = {
  base: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  eth: '0x000000000004444c5dc75cb358380d2e3de08a90',
}
export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000'
// A route leftover (a hop's output not passed to the next hop, or an endpoint difference) is accepted
// as a protocol/hook fee on the target path only up to this fraction of the flow it came from.
export const MAX_PATH_FEE_FRACTION = 0.01

export type V4PoolCurrencies = { currency0: string; currency1: string }
export type V4RouteLog = { address: string; topics: string[]; data: string }

export type V4RouteFailure =
  | 'no_v4_swap_in_tx'
  | 'non_v4_swap_in_tx'
  | 'pool_key_unproven'
  | 'malformed_swap_delta'
  | 'route_does_not_chain'
  | 'route_direction_inconsistent'
  | 'unrelated_second_economic_action'
  | 'no_canonical_intermediary_on_route'

export type V4RouteHop = { poolId: string; inCurrency: string; outCurrency: string; inRaw: string; outRaw: string }
export type PathFee = { kind: 'protocol_fee_on_target_path'; currency: string; raw: string; where: string }

export type V4RouteQuoteResult =
  | {
    status: 'route_proven'
    hops: V4RouteHop[]
    // null when the caller's quote token is itself canonical (the route only proves attribution).
    intermediary: { currency: string; kind: 'native' | 'stable'; raw: string; quantity: number } | null
    fees: PathFee[]
  }
  | { status: V4RouteFailure; hops: V4RouteHop[]; detail: string }

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase()
function signedWord(data: string, index: number): bigint | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const word = hex.slice(index * 64, index * 64 + 64)
  if (word.length !== 64 || !/^[0-9a-f]+$/i.test(word)) return null
  const v = BigInt(`0x${word}`)
  return v >= BigInt(2) ** BigInt(255) ? v - BigInt(2) ** BigInt(256) : v
}
const abs = (v: bigint) => (v < BigInt(0) ? -v : v)
function withinFee(leftover: bigint, flow: bigint): boolean {
  if (leftover < BigInt(0)) return false
  if (leftover === BigInt(0)) return true
  // leftover / flow <= MAX_PATH_FEE_FRACTION, in integer arithmetic
  return leftover * BigInt(10_000) <= flow * BigInt(Math.round(MAX_PATH_FEE_FRACTION * 10_000))
}
function canonicalKind(chain: SupportedChain, currency: string): 'native' | 'stable' | null {
  if (currency === NATIVE_CURRENCY || isCanonicalWethAddress(chain, currency)) return 'native'
  if (isVerifiedStablecoinAddress(chain, currency)) return 'stable'
  return null
}
function decimalsOf(chain: SupportedChain, currency: string): number {
  return currency === NATIVE_CURRENCY ? 18 : resolveTokenDecimals({ chain, token: currency }).decimals
}
function toUnits(raw: bigint, decimals: number): number {
  const scale = BigInt(10) ** BigInt(decimals)
  return Number(raw / scale) + Number(raw % scale) / Number(scale)
}

/** Distinct V4 PoolIds swapped through in this receipt (on the chain's canonical PoolManager). */
export function v4PoolIdsInLogs(chain: SupportedChain, logs: readonly V4RouteLog[]): string[] {
  const manager = V4_POOL_MANAGERS[chain]
  return [...new Set(logs
    .filter((l) => lower(l.topics[0]) === V4_SWAP_TOPIC0 && lower(l.address) === manager && l.topics[1])
    .map((l) => lower(l.topics[1])))]
}

// PURE.
// side 'entry': wallet pays `walletInToken` (walletInRaw) and receives the target (walletOutRaw).
// side 'exit' : wallet pays the target (walletInRaw) and receives `walletOutToken` (walletOutRaw).
export function decodeV4RouteQuote(params: {
  chain: SupportedChain
  side: 'entry' | 'exit'
  target: string
  quoteToken: string
  walletInRaw: bigint
  walletOutRaw: bigint
  logs: readonly V4RouteLog[]
  poolKeys: ReadonlyMap<string, V4PoolCurrencies>
  swapTopic0s: ReadonlySet<string>
  // The wallet's quote token is already a verified stable/WETH: prove attribution only.
  quoteIsCanonical?: boolean
  // The scanned wallet (its own balance changes are the trade, not retained balances).
  wallet: string
}): V4RouteQuoteResult {
  const { chain, side, logs } = params
  const target = lower(params.target)
  const quoteToken = lower(params.quoteToken)
  const manager = V4_POOL_MANAGERS[chain]
  const fail = (status: V4RouteFailure, detail: string, hops: V4RouteHop[] = []): V4RouteQuoteResult => ({ status, hops, detail })

  const swapLogs = logs.filter((l) => params.swapTopic0s.has(lower(l.topics[0])))
  const v4Swaps = swapLogs.filter((l) => lower(l.topics[0]) === V4_SWAP_TOPIC0 && lower(l.address) === manager)
  if (v4Swaps.length === 0) return fail('no_v4_swap_in_tx', 'no Swap from the canonical PoolManager')
  if (v4Swaps.length !== swapLogs.length) return fail('non_v4_swap_in_tx', 'mixed venues are not route-decoded')

  // Each hop: pool currencies (proven by Initialize) + signed deltas from the Swap event.
  const raw = v4Swaps.map((log) => {
    const poolId = lower(log.topics[1])
    const key = params.poolKeys.get(poolId)
    const a0 = signedWord(log.data, 0)
    const a1 = signedWord(log.data, 1)
    return { poolId, key, a0, a1 }
  })
  const unproven = raw.find((h) => !h.key)
  if (unproven) return fail('pool_key_unproven', unproven.poolId)
  if (raw.some((h) => h.a0 == null || h.a1 == null || h.a0 === BigInt(0) || h.a1 === BigInt(0) || (h.a0 < BigInt(0)) === (h.a1 < BigInt(0)))) {
    return fail('malformed_swap_delta', 'each hop must have exactly one negative and one positive delta')
  }

  // Chain the hops in log order from the wallet's input currency to its output currency. Direction is
  // checked by sign consistency (every hop's input delta has the same sign as hop 1's), so the result
  // does not depend on which side's perspective the deltas are reported from.
  const inputCurrency = side === 'entry' ? quoteToken : target
  const outputCurrency = side === 'entry' ? target : quoteToken
  const hops: V4RouteHop[] = []
  let current = inputCurrency
  let inSign: boolean | null = null
  const hopAmounts: Array<{ in: bigint; out: bigint }> = []
  for (const h of raw) {
    const c0 = lower(h.key!.currency0)
    const c1 = lower(h.key!.currency1)
    if (c0 !== current && c1 !== current) return fail('route_does_not_chain', `hop ${hops.length + 1} does not trade ${current}`, hops)
    const inIs0 = c0 === current
    const aIn = inIs0 ? h.a0! : h.a1!
    const aOut = inIs0 ? h.a1! : h.a0!
    const negIn = aIn < BigInt(0)
    if (inSign == null) inSign = negIn
    else if (inSign !== negIn) return fail('route_direction_inconsistent', `hop ${hops.length + 1}`, hops)
    const outCurrency = inIs0 ? c1 : c0
    hops.push({ poolId: h.poolId, inCurrency: current, outCurrency, inRaw: abs(aIn).toString(), outRaw: abs(aOut).toString() })
    hopAmounts.push({ in: abs(aIn), out: abs(aOut) })
    current = outCurrency
  }
  if (current !== outputCurrency) return fail('route_does_not_chain', `route ends in ${current}, wallet received ${outputCurrency}`, hops)

  // Conservation along the path. Every leftover must be a bounded fee that never leaves the path.
  const fees: PathFee[] = []
  const first = hopAmounts[0]
  const last = hopAmounts[hopAmounts.length - 1]
  const inputLeft = params.walletInRaw - first.in
  if (!withinFee(inputLeft, params.walletInRaw)) return fail('unrelated_second_economic_action', `wallet input ${params.walletInRaw} vs route input ${first.in}`, hops)
  if (inputLeft > BigInt(0)) fees.push({ kind: 'protocol_fee_on_target_path', currency: inputCurrency, raw: inputLeft.toString(), where: 'before_hop_1' })
  for (let i = 0; i + 1 < hopAmounts.length; i++) {
    const left = hopAmounts[i].out - hopAmounts[i + 1].in
    if (!withinFee(left, hopAmounts[i].out)) return fail('unrelated_second_economic_action', `hop ${i + 1} output ${hopAmounts[i].out} vs hop ${i + 2} input ${hopAmounts[i + 1].in}`, hops)
    if (left > BigInt(0)) fees.push({ kind: 'protocol_fee_on_target_path', currency: hops[i].outCurrency, raw: left.toString(), where: `between_hop_${i + 1}_and_${i + 2}` })
  }
  const outputLeft = last.out - params.walletOutRaw
  // The target leg may carry an arbitrary transfer tax; a non-target output is held to the fee bound.
  if (outputLeft < BigInt(0) || (outputCurrency !== target && !withinFee(outputLeft, last.out))) {
    return fail('unrelated_second_economic_action', `route output ${last.out} vs wallet received ${params.walletOutRaw}`, hops)
  }
  if (outputLeft > BigInt(0)) fees.push({ kind: 'protocol_fee_on_target_path', currency: outputCurrency, raw: outputLeft.toString(), where: 'after_last_hop' })

  // No token may move in this tx that is not on the route.
  const routeCurrencies = new Set([inputCurrency, ...hops.map((h) => h.outCurrency)])
  const wethOnRoute = [...routeCurrencies].some((c) => c === NATIVE_CURRENCY || isCanonicalWethAddress(chain, c))
  for (const log of logs) {
    if (lower(log.topics[0]) !== TRANSFER_TOPIC0 || log.topics.length < 3) continue
    const token = lower(log.address)
    if (routeCurrencies.has(token)) continue
    if (wethOnRoute && isCanonicalWethAddress(chain, token)) continue // native <-> WETH settlement of the same route currency
    return fail('unrelated_second_economic_action', `transfer of ${token}, which is not on the route`, hops)
  }

  // RETAINED BALANCES. Outside the wallet and the PoolManager, a token kept by any address is a
  // protocol fee on the target path only if everything that address sends in this tx settles this same
  // route (into the PoolManager or to the wallet) and the amount is within the fee bound of the
  // route's own flow of that token (target-token transfer tax excepted).
  // Anything else could fund a separate action and is rejected.
  const routeFlow = new Map<string, bigint>()
  const bump = (token: string, v: bigint) => { if (v > (routeFlow.get(token) ?? BigInt(0))) routeFlow.set(token, v) }
  bump(inputCurrency, params.walletInRaw)
  bump(outputCurrency, params.walletOutRaw)
  hops.forEach((h, i) => { bump(h.inCurrency, hopAmounts[i].in); bump(h.outCurrency, hopAmounts[i].out) })
  if (routeFlow.has(NATIVE_CURRENCY)) for (const w of [...routeCurrencies].filter((c) => isCanonicalWethAddress(chain, c))) bump(w, routeFlow.get(NATIVE_CURRENCY)!)
  const nets = new Map<string, bigint>()
  // An address whose only outflows settle this route (into the PoolManager, or to the wallet) cannot
  // be funding a separate action with what it spends.
  const spendsOutsideRoute = new Set<string>()
  for (const log of logs) {
    if (lower(log.topics[0]) !== TRANSFER_TOPIC0 || log.topics.length < 3) continue
    const token = lower(log.address)
    const from = `0x${log.topics[1].slice(-40)}`.toLowerCase()
    const to = `0x${log.topics[2].slice(-40)}`.toLowerCase()
    const hex = log.data.startsWith('0x') ? log.data.slice(2, 66) : log.data.slice(0, 64)
    const amount = /^[0-9a-f]{64}$/i.test(hex) ? BigInt(`0x${hex}`) : BigInt(0)
    if (to !== manager && to !== lower(params.wallet)) spendsOutsideRoute.add(from)
    nets.set(`${from}|${token}`, (nets.get(`${from}|${token}`) ?? BigInt(0)) - amount)
    nets.set(`${to}|${token}`, (nets.get(`${to}|${token}`) ?? BigInt(0)) + amount)
  }
  const wallet = lower(params.wallet)
  for (const [key, net] of nets) {
    const [address, token] = key.split('|')
    if (net === BigInt(0) || address === manager || address === wallet || address === NATIVE_CURRENCY || isCanonicalWethAddress(chain, address)) continue
    if (token === target && net > BigInt(0)) continue
    const flow = routeFlow.get(token) ?? BigInt(0)
    if (net < BigInt(0)) return fail('unrelated_second_economic_action', `${address} spends ${-net} more ${token} than it received`, hops)
    if (spendsOutsideRoute.has(address) || !withinFee(net, flow)) return fail('unrelated_second_economic_action', `${address} keeps ${net} ${token} (route flow ${flow})${spendsOutsideRoute.has(address) ? ' and sends tokens outside the route' : ''}`, hops)
    fees.push({ kind: 'protocol_fee_on_target_path', currency: token, raw: net.toString(), where: `retained_by_${address}` })
  }
  if (params.quoteIsCanonical) return { status: 'route_proven', hops, intermediary: null, fees }

  // The canonical intermediary nearest the target side of the route carries the quote: for an entry
  // the amount ENTERING the hop toward the target, for an exit the amount PRODUCED from the target.
  const boundaries = hops.slice(0, -1).map((h, i) => ({ currency: h.outCurrency, entryRaw: hopAmounts[i + 1].in, exitRaw: hopAmounts[i].out }))
  const ordered = side === 'entry' ? [...boundaries].reverse() : boundaries
  const chosen = ordered.find((b) => canonicalKind(chain, b.currency) !== null)
  if (!chosen) return fail('no_canonical_intermediary_on_route', `route ${[inputCurrency, ...hops.map((h) => h.outCurrency)].join(' -> ')}`, hops)
  const kind = canonicalKind(chain, chosen.currency)!
  const amountRaw = side === 'entry' ? chosen.entryRaw : chosen.exitRaw
  return {
    status: 'route_proven',
    hops,
    intermediary: { currency: chosen.currency, kind, raw: amountRaw.toString(), quantity: toUnits(amountRaw, decimalsOf(chain, chosen.currency)) },
    fees,
  }
}

// ------------------------------------------------------------------------------ pool key proof ---

export type V4PoolKeyResolver = (chain: SupportedChain, poolIds: readonly string[], signal?: AbortSignal) => Promise<Map<string, V4PoolCurrencies>>

// Pool keys are immutable: a process-lifetime cache. Only proven keys are cached.
const poolKeyCache = new Map<string, V4PoolCurrencies>()
export function __resetV4PoolKeyCacheForTest(): void {
  poolKeyCache.clear()
}

function topicAddress(topic: string | undefined): string | null {
  return topic && /^0x[0-9a-f]{64}$/i.test(topic) && /^0x0{24}/i.test(topic) ? `0x${topic.slice(-40)}`.toLowerCase() : null
}

// One exact-PoolId Initialize query per unknown pool on the chain's canonical PoolManager (the same
// read the V4 chart path already uses). The PoolManager derives the PoolId from the key itself, so an
// Initialize for exactly this id, emitted by the canonical manager, proves the pool's two currencies.
export function createV4PoolKeyResolver(deps: { fetchImpl?: typeof fetch; rpcUrlFor?: (chain: SupportedChain) => string | null; timeoutMs?: number } = {}): V4PoolKeyResolver & { calls: () => number } {
  const fetchImpl = deps.fetchImpl ?? fetch
  const rpcUrlFor = deps.rpcUrlFor ?? receiptRpcUrl
  const timeoutMs = deps.timeoutMs ?? 4000
  let calls = 0
  const resolver = async (chain: SupportedChain, poolIds: readonly string[], signal?: AbortSignal) => {
    const out = new Map<string, V4PoolCurrencies>()
    const manager = V4_POOL_MANAGERS[chain]
    const url = rpcUrlFor(chain)
    for (const id of poolIds) {
      const poolId = lower(id)
      const cached = poolKeyCache.get(`${chain}:${poolId}`)
      if (cached) { out.set(poolId, cached); continue }
      if (!manager || !url || signal?.aborted) continue
      calls += 1
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: manager, topics: [V4_INITIALIZE_TOPIC0, poolId], fromBlock: '0x0', toBlock: 'latest' }] }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        })
        const json = await res.json().catch(() => null) as { result?: Array<{ address?: string; topics?: string[]; removed?: boolean }> } | null
        const log = (json?.result ?? []).find((l) => l.removed !== true && lower(l.address) === manager && lower(l.topics?.[0]) === V4_INITIALIZE_TOPIC0 && lower(l.topics?.[1]) === poolId)
        const currency0 = topicAddress(log?.topics?.[2])
        const currency1 = topicAddress(log?.topics?.[3])
        if (!currency0 || !currency1) continue
        const key = { currency0, currency1 }
        poolKeyCache.set(`${chain}:${poolId}`, key)
        out.set(poolId, key)
      } catch {
        // unproven pool stays absent -> pool_key_unproven (fail closed)
      }
    }
    return out
  }
  return Object.assign(resolver, { calls: () => calls })
}
