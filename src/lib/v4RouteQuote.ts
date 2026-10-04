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
  | 'unrelated_second_economic_action'
  | 'no_canonical_intermediary_on_route'
  | 'ambiguous_route'

// Connected-route extraction diagnostics (hop indexes are positions among the receipt's V4 swaps).
export type V4PathSelection = {
  v4SwapCount: number
  candidatePathCount: number
  ambiguousPathCount: number
  selectedPathHopIndexes: number[]
  selectedPathCurrencies: string[]
  excludedV4HopIndexes: number[]
  excludedV4HopReasons: string[]
  selectedPathInputRaw: string | null
  selectedPathOutputRaw: string | null
}
export type V4RouteHop = { poolId: string; inCurrency: string; outCurrency: string; inRaw: string; outRaw: string }
export type PathFee = { kind: 'protocol_fee_on_target_path'; currency: string; raw: string; where: string }

export type V4RouteQuoteResult =
  | {
    status: 'route_proven'
    hops: V4RouteHop[]
    // null when the caller's quote token is itself canonical (the route only proves attribution).
    intermediary: { currency: string; kind: 'native' | 'stable'; raw: string; quantity: number } | null
    fees: PathFee[]
    selection: V4PathSelection
  }
  | { status: V4RouteFailure; hops: V4RouteHop[]; detail: string; selection: V4PathSelection }

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
  const wallet = lower(params.wallet)
  const manager = V4_POOL_MANAGERS[chain]
  const selection: V4PathSelection = {
    v4SwapCount: 0, candidatePathCount: 0, ambiguousPathCount: 0,
    selectedPathHopIndexes: [], selectedPathCurrencies: [], excludedV4HopIndexes: [], excludedV4HopReasons: [],
    selectedPathInputRaw: null, selectedPathOutputRaw: null,
  }
  const fail = (status: V4RouteFailure, detail: string, hops: V4RouteHop[] = []): V4RouteQuoteResult => ({ status, hops, detail, selection })

  const swapLogs = logs.filter((l) => params.swapTopic0s.has(lower(l.topics[0])))
  const v4Swaps = swapLogs.filter((l) => lower(l.topics[0]) === V4_SWAP_TOPIC0 && lower(l.address) === manager)
  selection.v4SwapCount = v4Swaps.length
  if (v4Swaps.length === 0) return fail('no_v4_swap_in_tx', 'no Swap from the canonical PoolManager')
  if (v4Swaps.length !== swapLogs.length) return fail('non_v4_swap_in_tx', 'mixed venues are not route-decoded')

  // Every V4 hop in the receipt: pool currencies (proven by Initialize) + signed deltas.
  const raw = v4Swaps.map((log, index) => {
    const poolId = lower(log.topics[1])
    const key = params.poolKeys.get(poolId)
    return { index, poolId, key, a0: signedWord(log.data, 0), a1: signedWord(log.data, 1) }
  })
  const unproven = raw.find((h) => !h.key)
  if (unproven) return fail('pool_key_unproven', unproven.poolId)
  if (raw.some((h) => h.a0 == null || h.a1 == null || h.a0 === BigInt(0) || h.a1 === BigInt(0) || (h.a0 < BigInt(0)) === (h.a1 < BigInt(0)))) {
    return fail('malformed_swap_delta', 'each hop must have exactly one negative and one positive delta')
  }

  // CONNECTED ROUTE EXTRACTION. A receipt may contain V4 swaps besides the wallet's own route (a token
  // tax swap-back, a hook action, another order in the same bundle). Every directed path from the
  // wallet's input currency to its output currency is enumerated over hops in strictly increasing log
  // order; each hop's direction comes from its signed deltas under ONE reporting convention per path
  // (both conventions are tried, never mixed). A path stops at its first arrival at the output.
  const inputCurrency = side === 'entry' ? quoteToken : target
  const outputCurrency = side === 'entry' ? target : quoteToken
  type DirectedHop = { index: number; poolId: string; inCurrency: string; outCurrency: string; in: bigint; out: bigint }
  const MAX_CANDIDATE_PATHS = 64
  const MAX_PATH_HOPS = 6
  const candidates: DirectedHop[][] = []
  for (const negativeIsInput of [true, false]) {
    const directed: DirectedHop[] = raw.map((h) => {
      const c0 = lower(h.key!.currency0)
      const c1 = lower(h.key!.currency1)
      const zeroIsIn = (h.a0! < BigInt(0)) === negativeIsInput
      return {
        index: h.index, poolId: h.poolId,
        inCurrency: zeroIsIn ? c0 : c1, outCurrency: zeroIsIn ? c1 : c0,
        in: abs(zeroIsIn ? h.a0! : h.a1!), out: abs(zeroIsIn ? h.a1! : h.a0!),
      }
    })
    const walk = (current: string, after: number, path: DirectedHop[]) => {
      if (candidates.length > MAX_CANDIDATE_PATHS || path.length >= MAX_PATH_HOPS) return
      for (const h of directed) {
        if (h.index <= after || h.inCurrency !== current) continue
        const next = [...path, h]
        if (h.outCurrency === outputCurrency) candidates.push(next)
        else walk(h.outCurrency, h.index, next)
      }
    }
    walk(inputCurrency, -1, [])
  }
  if (candidates.length > MAX_CANDIDATE_PATHS) return fail('ambiguous_route', `more than ${MAX_CANDIDATE_PATHS} candidate paths`)
  if (candidates.length === 0) {
    return fail('route_does_not_chain', `no connected V4 path from ${inputCurrency} to ${outputCurrency} among ${raw.length} swaps`)
  }

  // A candidate satisfies the wallet trade only if it reproduces the wallet's own amounts under the
  // existing fee bound and conserves its own flow hop to hop (nothing from outside can top it up).
  type Checked = { path: DirectedHop[]; fees: PathFee[] } | { path: DirectedHop[]; failure: string }
  const check = (path: DirectedHop[]): Checked => {
    const fees: PathFee[] = []
    const inputLeft = params.walletInRaw - path[0].in
    if (!withinFee(inputLeft, params.walletInRaw)) return { path, failure: `wallet input ${params.walletInRaw} vs path input ${path[0].in}` }
    if (inputLeft > BigInt(0)) fees.push({ kind: 'protocol_fee_on_target_path', currency: inputCurrency, raw: inputLeft.toString(), where: 'before_first_hop' })
    for (let i = 0; i + 1 < path.length; i++) {
      const left = path[i].out - path[i + 1].in
      if (!withinFee(left, path[i].out)) return { path, failure: `hop #${path[i].index} output ${path[i].out} vs hop #${path[i + 1].index} input ${path[i + 1].in}` }
      if (left > BigInt(0)) fees.push({ kind: 'protocol_fee_on_target_path', currency: path[i].outCurrency, raw: left.toString(), where: `between_hop_${path[i].index}_and_${path[i + 1].index}` })
    }
    const last = path[path.length - 1]
    const outputLeft = last.out - params.walletOutRaw
    // The target leg may carry an arbitrary transfer tax; a non-target output is held to the fee bound.
    if (outputLeft < BigInt(0) || (outputCurrency !== target && !withinFee(outputLeft, last.out))) {
      return { path, failure: `path output ${last.out} vs wallet received ${params.walletOutRaw}` }
    }
    if (outputLeft > BigInt(0)) fees.push({ kind: 'protocol_fee_on_target_path', currency: outputCurrency, raw: outputLeft.toString(), where: 'after_last_hop' })
    return { path, fees }
  }
  const checked = candidates.map(check)
  const satisfying = checked.filter((c): c is { path: DirectedHop[]; fees: PathFee[] } => 'fees' in c)
  selection.candidatePathCount = satisfying.length
  const toHops = (path: DirectedHop[]): V4RouteHop[] => path.map((h) => ({ poolId: h.poolId, inCurrency: h.inCurrency, outCurrency: h.outCurrency, inRaw: h.in.toString(), outRaw: h.out.toString() }))
  if (satisfying.length === 0) {
    const first = checked[0] as { path: DirectedHop[]; failure: string }
    return fail('unrelated_second_economic_action', `no connected path reproduces the wallet trade: ${first.failure}`, toHops(first.path))
  }
  if (satisfying.length > 1) {
    selection.ambiguousPathCount = satisfying.length
    return fail('ambiguous_route', `${satisfying.length} connected paths satisfy the wallet trade`)
  }
  const { path, fees } = satisfying[0]
  const hops = toHops(path)
  const selected = new Set(path.map((h) => h.index))
  selection.selectedPathHopIndexes = path.map((h) => h.index)
  selection.selectedPathCurrencies = [inputCurrency, ...path.map((h) => h.outCurrency)]
  selection.selectedPathInputRaw = path[0].in.toString()
  selection.selectedPathOutputRaw = path[path.length - 1].out.toString()

  // EXCLUDED HOPS. Every other V4 swap must be unable to change what the wallet paid or received:
  //  - it cannot feed the selected path (the path's own hop-to-hop conservation above would fail);
  //  - it must not produce the wallet's own output currency (it could be part of what the wallet got);
  //  - it must not produce native ETH (a payout to the wallet would be an invisible internal transfer).
  // An excluded hop that consumes what the selected path produced (e.g. a tax swap-back of the target)
  // stays off-wallet by these rules, so it is a cost of the trade, never value returned to the wallet.
  const pathProduced = new Set(path.map((h) => h.outCurrency))
  // The selected path's reporting convention (which delta sign marks a hop's input).
  const ref = raw[path[0].index]
  const negativeIsInput = (ref.a0! < BigInt(0)) === (lower(ref.key!.currency0) === path[0].inCurrency)
  const allHops = raw.map((h) => {
    const c0 = lower(h.key!.currency0)
    const c1 = lower(h.key!.currency1)
    const zeroIsIn = (h.a0! < BigInt(0)) === negativeIsInput
    return { index: h.index, c0, c1, consumed: zeroIsIn ? c0 : c1, produced: zeroIsIn ? c1 : c0, consumedRaw: abs(zeroIsIn ? h.a0! : h.a1!) }
  })
  for (const h of allHops) {
    if (selected.has(h.index)) continue
    selection.excludedV4HopIndexes.push(h.index)
    if (h.produced === outputCurrency) {
      selection.excludedV4HopReasons.push(`#${h.index}: produces the wallet output currency ${outputCurrency}`)
      return fail('unrelated_second_economic_action', `excluded V4 hop #${h.index} also produces ${outputCurrency}`, hops)
    }
    if (h.produced === NATIVE_CURRENCY) {
      selection.excludedV4HopReasons.push(`#${h.index}: produces native ETH (destination not provable from logs)`)
      return fail('unrelated_second_economic_action', `excluded V4 hop #${h.index} produces native ETH`, hops)
    }
    selection.excludedV4HopReasons.push(pathProduced.has(h.consumed)
      ? `#${h.index}: off-path swap of a currency the path produced (${h.consumed} -> ${h.produced}); output stays off-wallet`
      : `#${h.index}: independent swap (${h.consumed} -> ${h.produced}); output stays off-wallet`)
  }

  // No token may move in this tx that is not traded by some V4 hop in it.
  const v4Currencies = new Set(allHops.flatMap((h) => [h.c0, h.c1]))
  const nativeTraded = v4Currencies.has(NATIVE_CURRENCY)
  for (const log of logs) {
    if (lower(log.topics[0]) !== TRANSFER_TOPIC0 || log.topics.length < 3) continue
    const token = lower(log.address)
    if (v4Currencies.has(token)) continue
    if (nativeTraded && isCanonicalWethAddress(chain, token)) continue // native <-> WETH settlement
    return fail('unrelated_second_economic_action', `transfer of ${token}, which no V4 hop in this tx trades`, hops)
  }

  // RETAINED BALANCES OF THE WALLET-SIDE QUOTE CURRENCY. Whoever keeps part of what the wallet paid
  // (entry) or of what the wallet should have received (exit) is a protocol fee on the target path only
  // if everything it sends settles this route (PoolManager / wallet) and it is within the fee bound.
  const quoteCurrency = side === 'entry' ? inputCurrency : outputCurrency
  const quoteFlow = side === 'entry' ? params.walletInRaw : path[path.length - 1].out
  const nets = new Map<string, bigint>()
  const spendsOutsideRoute = new Set<string>()
  for (const log of logs) {
    if (lower(log.topics[0]) !== TRANSFER_TOPIC0 || log.topics.length < 3) continue
    const token = lower(log.address)
    const from = `0x${log.topics[1].slice(-40)}`.toLowerCase()
    const to = `0x${log.topics[2].slice(-40)}`.toLowerCase()
    const hex = log.data.startsWith('0x') ? log.data.slice(2, 66) : log.data.slice(0, 64)
    const amount = /^[0-9a-f]{64}$/i.test(hex) ? BigInt(`0x${hex}`) : BigInt(0)
    if (to !== manager && to !== wallet) spendsOutsideRoute.add(from)
    if (token !== quoteCurrency) continue
    nets.set(from, (nets.get(from) ?? BigInt(0)) - amount)
    nets.set(to, (nets.get(to) ?? BigInt(0)) + amount)
  }
  // Quote currency supplied from outside the wallet may only settle EXCLUDED hops (never the path,
  // which conservation already pins to the wallet's own amount): at most what they consume.
  const excludedQuoteConsumption = allHops.filter((h) => !selected.has(h.index) && h.consumed === quoteCurrency).reduce((sum, h) => sum + h.consumedRaw, BigInt(0))
  let outsideQuoteSupply = BigInt(0)
  for (const [address, net] of nets) {
    if (net < BigInt(0) && address !== manager && address !== wallet && address !== NATIVE_CURRENCY) outsideQuoteSupply += -net
  }
  if (outsideQuoteSupply > excludedQuoteConsumption) {
    return fail('unrelated_second_economic_action', `${outsideQuoteSupply} ${quoteCurrency} supplied from outside the wallet exceeds what off-path swaps consume (${excludedQuoteConsumption})`, hops)
  }
  for (const [address, net] of nets) {
    if (net === BigInt(0) || address === manager || address === wallet || address === NATIVE_CURRENCY) continue
    if (net < BigInt(0)) continue
    if (spendsOutsideRoute.has(address) || !withinFee(net, quoteFlow)) {
      return fail('unrelated_second_economic_action', `${address} keeps ${net} ${quoteCurrency} (wallet flow ${quoteFlow})${spendsOutsideRoute.has(address) ? ' and sends tokens outside the route' : ''}`, hops)
    }
    fees.push({ kind: 'protocol_fee_on_target_path', currency: quoteCurrency, raw: net.toString(), where: `retained_by_${address}` })
  }
  if (params.quoteIsCanonical) return { status: 'route_proven', hops, intermediary: null, fees, selection }

  // The canonical intermediary nearest the target side of the selected path carries the quote: for an
  // entry the amount ENTERING the hop toward the target, for an exit the amount PRODUCED from the target.
  const boundaries = path.slice(0, -1).map((h, i) => ({ currency: h.outCurrency, entryRaw: path[i + 1].in, exitRaw: h.out }))
  const ordered = side === 'entry' ? [...boundaries].reverse() : boundaries
  const chosen = ordered.find((b) => canonicalKind(chain, b.currency) !== null)
  if (!chosen) return fail('no_canonical_intermediary_on_route', `route ${selection.selectedPathCurrencies.join(' -> ')}`, hops)
  const kind = canonicalKind(chain, chosen.currency)!
  const amountRaw = side === 'entry' ? chosen.entryRaw : chosen.exitRaw
  return {
    status: 'route_proven',
    hops,
    intermediary: { currency: chosen.currency, kind, raw: amountRaw.toString(), quantity: toUnits(amountRaw, decimalsOf(chain, chosen.currency)) },
    fees,
    selection,
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
