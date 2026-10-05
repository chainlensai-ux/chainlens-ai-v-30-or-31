// ROBINHOOD MIXED-VENUE ROUTE FORENSICS — diagnostic only; PnL V1 acceptance is unchanged by this module.
//
// A receipt with a canonical V4 swap plus V2/V3-style swaps is either ONE aggregator route the wallet owns
// (wallet token → V4 → V3 → … → wallet), or a V4 trade next to an independent second economic action. This
// builds the receipt's flow graph from log evidence only and decides which:
//
//   hops     every swap log in log order with its exact (inToken, inRaw) → (outToken, outRaw):
//              V2  Swap(amount0In, amount1In, amount0Out, amount1Out) — tokens proven by the ERC-20 Transfers
//                  into / out of that pool carrying exactly those amounts;
//              V3  Swap(int256 amount0, int256 amount1, …) pool-perspective deltas — tokens proven the same way;
//              V4  canonical PoolManager Swap, currencies from the proven pool key (both sign readings tried;
//                  only one that conserves is accepted).
//            WETH and native ETH are one asset for flow purposes (wrap / unwrap is settlement, not a trade).
//   wallet   exactly one net debit and one net credit; ERC-20 legs from Transfers, the native leg only from the
//            exact balance proof (balanceAfter − balanceBefore + gas, with the wallet's nonce advancing by
//            exactly one in that block — its only tx there).
//   proof    every hop reachable from the wallet's input token AND leading to its output token; per-token
//            conservation (no asset consumed beyond what the route produced or the wallet supplied — that
//            would be outside funding; leftovers within the existing fee bound); no address other than the
//            wallet, a swap venue or a pass-through supplying a route token; no wallet transfer of a token the
//            route does not trade; no liquidity event; the tx is the wallet's own (tx.from == wallet).
// Router / helper addresses are never ownership evidence: they only ever appear as net-zero pass-through.

// Value imports from robinhoodPnlV1 are only read at call time (the two modules import each other).
import { ROBINHOOD_ROUTE_MAX_FEE_FRACTION, ERC20_TRANSFER_TOPIC0, V4_SWAP_TOPIC0, RH_WETH, RH_NATIVE, type RhPoolKey, type RhReceipt } from './robinhoodPnlV1'

export const V2_SWAP_TOPIC0 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
export const V3_SWAP_TOPIC0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const LIQUIDITY_TOPICS = new Set([
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec', // V4 ModifyLiquidity
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
])
const ZERO = BigInt(0)
// WETH9 wrap / unwrap emit these instead of a Transfer; counted so a router that wraps the wallet's ETH (or
// unwraps the route's WETH for the wallet) nets to zero instead of looking like an outside funder / holder.
export const WETH_DEPOSIT_TOPIC0 = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'
export const WETH_WITHDRAWAL_TOPIC0 = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'
export const NATIVE_ASSET = 'native'
const norm = (token: string) => (token === RH_WETH || token === RH_NATIVE ? NATIVE_ASSET : token)
const addr = (topic: string) => `0x${topic.slice(-40)}`
const abs = (v: bigint) => (v < ZERO ? -v : v)
function word(data: string, i: number, signed: boolean): bigint | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const w = hex.slice(i * 64, i * 64 + 64)
  if (!/^[0-9a-f]{64}$/i.test(w)) return null
  const v = BigInt(`0x${w}`)
  return signed && v >= BigInt(2) ** BigInt(255) ? v - BigInt(2) ** BigInt(256) : v
}
const withinFee = (left: bigint, flow: bigint) => left >= ZERO && (left === ZERO || left * BigInt(10_000) <= flow * BigInt(Math.round(ROBINHOOD_ROUTE_MAX_FEE_FRACTION * 10_000)))

// NATIVE EVIDENCE HIERARCHY. A whole-block balance delta (after − before + gas) cannot attribute native ETH
// to the target tx: a nonce delta of 1 proves the wallet SENT one tx in the block, not that no other tx in the
// block PAID it. Only an execution trace of the target tx itself (its internal native transfers to the
// wallet) is proof. A WETH Withdrawal in the receipt only shows WETH was unwrapped, not who got the ETH.
//   proven_target_tx_native_transfer         the target tx's own trace; the only status that may feed a route
//   block_balance_delta_only                 no trace; the block delta is kept as a diagnostic bound only
//   unavailable_multiple_wallet_txs_in_block no trace, and the wallet sent more than one tx in the block
//   unavailable_no_trace                     trace unavailable and no usable balance evidence
//   unavailable_no_balance_evidence          nothing to go on
export type RhNativeStatus =
  | 'not_needed' | 'proven_target_tx_native_transfer' | 'block_balance_delta_only'
  | 'unavailable_multiple_wallet_txs_in_block' | 'unavailable_no_trace' | 'unavailable_no_balance_evidence'
export type RhNativeTransfer = { from: string; to: string; value: bigint; success: boolean }
export type RhNativeEvidence = {
  walletBalanceBefore: string | null
  walletBalanceAfter: string | null
  gasPaid: string
  txValue: string | null
  walletTxsInBlock: number | null
  /** after − before + gas: diagnostic bound only — never used as proof. */
  blockBalanceDeltaExGas: string | null
  traceSource: 'blockscout_internal_transactions' | null
  /** Native ETH the target tx itself paid to / took from the wallet (successful internal transfers). */
  traceNativeToWallet: string | null
  traceNativeFromWallet: string | null
  /** The wallet's exact native net for the TARGET tx (gas excluded) — set ONLY when status is proven_target_tx_native_transfer. */
  nativeNetExGas: bigint | null
  status: RhNativeStatus
}

/** PURE. Builds native evidence; only the target tx's own trace can make it proven. */
export function deriveRhNativeEvidence(input: {
  wallet: string
  isSender: boolean
  gasPaid: bigint
  txValue: bigint | null
  balanceBefore: bigint | null
  balanceAfter: bigint | null
  nonceBefore: number | null
  nonceAfter: number | null
  /** The target tx's internal native transfers; null when no trace could be read. */
  trace: ReadonlyArray<RhNativeTransfer> | null
}): RhNativeEvidence {
  const wallet = input.wallet.toLowerCase()
  const haveBal = input.balanceBefore != null && input.balanceAfter != null
  const txs = input.nonceBefore != null && input.nonceAfter != null ? input.nonceAfter - input.nonceBefore : null
  const ev: RhNativeEvidence = {
    walletBalanceBefore: input.balanceBefore?.toString() ?? null,
    walletBalanceAfter: input.balanceAfter?.toString() ?? null,
    gasPaid: input.gasPaid.toString(),
    txValue: input.txValue?.toString() ?? null,
    walletTxsInBlock: txs,
    blockBalanceDeltaExGas: haveBal ? (input.balanceAfter! - input.balanceBefore! + (input.isSender ? input.gasPaid : ZERO)).toString() : null,
    traceSource: input.trace ? 'blockscout_internal_transactions' : null,
    traceNativeToWallet: null,
    traceNativeFromWallet: null,
    nativeNetExGas: null,
    status: 'unavailable_no_balance_evidence',
  }
  // The target tx's own top-level value is part of it; a wallet-sent tx's value is known only from the tx.
  if (input.trace && (!input.isSender || input.txValue != null)) {
    const ok = input.trace.filter((t) => t.success && t.value > ZERO)
    const toWallet = ok.filter((t) => t.to.toLowerCase() === wallet).reduce((s, t) => s + t.value, ZERO)
    const fromWallet = ok.filter((t) => t.from.toLowerCase() === wallet).reduce((s, t) => s + t.value, ZERO)
    ev.traceNativeToWallet = toWallet.toString()
    ev.traceNativeFromWallet = fromWallet.toString()
    ev.nativeNetExGas = toWallet - fromWallet - (input.isSender ? input.txValue! : ZERO)
    ev.status = 'proven_target_tx_native_transfer'
    return ev
  }
  ev.status = !haveBal || txs == null
    ? (input.trace === null ? 'unavailable_no_trace' : 'unavailable_no_balance_evidence')
    : txs === (input.isSender ? 1 : 0) ? 'block_balance_delta_only' : 'unavailable_multiple_wallet_txs_in_block'
  return ev
}

export type RhMixedHop = { index: number; logIndex: number; venue: 'v2' | 'v3' | 'v4'; address: string; inToken: string | null; inRaw: string | null; outToken: string | null; outRaw: string | null; unresolved: string | null }
export type RhMixedClassification = 'direct_mixed_route_proven' | 'independent_second_action' | 'ambiguous'

export type RobinhoodMixedRouteForensics = {
  txHash: string
  walletInputToken: string | null
  walletInputRaw: string | null
  walletOutputToken: string | null
  walletOutputRaw: string | null
  walletNativeOutputRaw: string | null
  venuesInOrder: Array<'v2' | 'v3' | 'v4'>
  swapAddresses: string[]
  routeCurrencies: string[]
  routeHopCount: number
  hops: RhMixedHop[]
  connectedSwapIndexes: number[]
  excludedSwapIndexes: number[]
  outsideFundingFlows: Array<{ token: string; from: string; to: string; raw: string }>
  unrelatedWalletFlows: Array<{ token: string; direction: 'out' | 'in'; raw: string }>
  retainedFeeFlows: Array<{ token: string; holder: string; raw: string }>
  nativeEvidence: Omit<RhNativeEvidence, 'nativeNetExGas'> & { nativeNetExGas: string | null }
  nativeAttributionStatus: RhNativeEvidence['status']
  v4SignReading: 'negative_is_input' | 'positive_is_input' | null
  singleConnectedEconomicRoute: boolean
  amountConservationPassed: boolean
  ownershipProven: boolean
  finalClassification: RhMixedClassification
  reason: string
}

type Transfer = { token: string; from: string; to: string; amount: bigint; logIndex: number }

/** PURE. */
export function analyzeRobinhoodMixedRoute(input: {
  wallet: string
  txHash: string
  receipt: RhReceipt
  poolManager: string
  v4PoolKeys: ReadonlyMap<string, RhPoolKey>
  native: RhNativeEvidence
}): RobinhoodMixedRouteForensics {
  const wallet = input.wallet.toLowerCase()
  const pm = input.poolManager.toLowerCase()
  const { receipt } = input
  const transfers: Transfer[] = []
  for (const l of receipt.logs) {
    if (l.topics[0] !== ERC20_TRANSFER_TOPIC0 || l.topics.length !== 3) continue
    const amount = word(l.data, 0, false)
    if (amount != null) transfers.push({ token: l.address, from: addr(l.topics[1]), to: addr(l.topics[2]), amount, logIndex: l.logIndex })
  }
  const swapLogs = receipt.logs.filter((l) => l.topics[0] === V2_SWAP_TOPIC0 || l.topics[0] === V3_SWAP_TOPIC0 || (l.topics[0] === V4_SWAP_TOPIC0 && l.address === pm))
  const venueAddresses = new Set(swapLogs.map((l) => l.address))

  // ── Hops ────────────────────────────────────────────────────────────────────────────────────────
  const matchToken = (pool: string, amount: bigint, dir: 'in' | 'out'): { token: string | null; why: string | null } => {
    const tokens = [...new Set(transfers.filter((t) => t.amount === amount && (dir === 'in' ? t.to === pool : t.from === pool)).map((t) => t.token))]
    if (tokens.length === 1) return { token: tokens[0], why: null }
    return { token: null, why: tokens.length === 0 ? `no Transfer ${dir === 'in' ? 'into' : 'out of'} ${pool} of exactly ${amount}` : `${tokens.length} tokens match ${amount} ${dir}` }
  }
  const nonV4Hops: RhMixedHop[] = []
  const v4Raw: Array<{ index: number; logIndex: number; key: RhPoolKey | undefined; a0: bigint | null; a1: bigint | null }> = []
  swapLogs.forEach((l, index) => {
    if (l.topics[0] === V4_SWAP_TOPIC0) {
      v4Raw.push({ index, logIndex: l.logIndex, key: input.v4PoolKeys.get(l.topics[1]), a0: word(l.data, 0, true), a1: word(l.data, 1, true) })
      return
    }
    let inAmt: bigint | null = null
    let outAmt: bigint | null = null
    let why: string | null = null
    if (l.topics[0] === V2_SWAP_TOPIC0) {
      const [i0, i1, o0, o1] = [0, 1, 2, 3].map((i) => word(l.data, i, false))
      if ([i0, i1, o0, o1].some((v) => v == null)) why = 'malformed V2 Swap data'
      else if ((i0! > ZERO) === (i1! > ZERO) || (o0! > ZERO) === (o1! > ZERO)) why = 'V2 Swap is not a single in / single out trade'
      else { inAmt = i0! > ZERO ? i0! : i1!; outAmt = o0! > ZERO ? o0! : o1! }
    } else {
      const [a0, a1] = [word(l.data, 0, true), word(l.data, 1, true)]
      if (a0 == null || a1 == null || a0 === ZERO || a1 === ZERO || (a0 > ZERO) === (a1 > ZERO)) why = 'V3 Swap deltas are not one positive (in) and one negative (out)'
      else { inAmt = a0 > ZERO ? a0 : a1; outAmt = abs(a0 > ZERO ? a1 : a0) }
    }
    const hop: RhMixedHop = { index, logIndex: l.logIndex, venue: l.topics[0] === V2_SWAP_TOPIC0 ? 'v2' : 'v3', address: l.address, inToken: null, inRaw: inAmt?.toString() ?? null, outToken: null, outRaw: outAmt?.toString() ?? null, unresolved: why }
    if (!why && inAmt != null && outAmt != null) {
      const i = matchToken(l.address, inAmt, 'in')
      const o = matchToken(l.address, outAmt, 'out')
      hop.inToken = i.token ? norm(i.token) : null
      hop.outToken = o.token ? norm(o.token) : null
      hop.unresolved = i.why ?? o.why
    }
    nonV4Hops.push(hop)
  })
  const v4Hops = (negativeIsInput: boolean): RhMixedHop[] => v4Raw.map((h) => {
    if (!h.key) return { index: h.index, logIndex: h.logIndex, venue: 'v4', address: pm, inToken: null, inRaw: null, outToken: null, outRaw: null, unresolved: 'V4 pool key unproven' }
    if (h.a0 == null || h.a1 == null || h.a0 === ZERO || h.a1 === ZERO || (h.a0 < ZERO) === (h.a1 < ZERO)) return { index: h.index, logIndex: h.logIndex, venue: 'v4', address: pm, inToken: null, inRaw: null, outToken: null, outRaw: null, unresolved: 'malformed V4 swap delta' }
    const zeroIsIn = (h.a0 < ZERO) === negativeIsInput
    return {
      index: h.index, logIndex: h.logIndex, venue: 'v4', address: pm,
      inToken: norm((zeroIsIn ? h.key.currency0 : h.key.currency1).toLowerCase()), inRaw: abs(zeroIsIn ? h.a0 : h.a1).toString(),
      outToken: norm((zeroIsIn ? h.key.currency1 : h.key.currency0).toLowerCase()), outRaw: abs(zeroIsIn ? h.a1 : h.a0).toString(),
      unresolved: null,
    }
  })

  // ── Wallet legs ───────────────────────────────────────────────────────────────────────────────────
  const walletNet = new Map<string, bigint>()
  for (const t of transfers) {
    if (t.from === wallet) walletNet.set(norm(t.token), (walletNet.get(norm(t.token)) ?? ZERO) - t.amount)
    if (t.to === wallet) walletNet.set(norm(t.token), (walletNet.get(norm(t.token)) ?? ZERO) + t.amount)
  }
  // Only the target tx's own trace may supply a native leg; a block balance delta is never used here.
  const nativeNet = input.native.status === 'proven_target_tx_native_transfer' ? input.native.nativeNetExGas : null
  if (nativeNet != null && nativeNet !== ZERO) walletNet.set(NATIVE_ASSET, (walletNet.get(NATIVE_ASSET) ?? ZERO) + nativeNet)
  for (const [k, v] of walletNet) if (v === ZERO) walletNet.delete(k)
  const debits = [...walletNet].filter(([, v]) => v < ZERO)
  const credits = [...walletNet].filter(([, v]) => v > ZERO)

  const liquidity = receipt.logs.some((l) => LIQUIDITY_TOPICS.has(l.topics[0] ?? ''))
  const nativeEvidenceOut = { ...input.native, nativeNetExGas: input.native.nativeNetExGas?.toString() ?? null }
  const base = {
    txHash: input.txHash,
    walletInputToken: debits.length === 1 ? debits[0][0] : null,
    walletInputRaw: debits.length === 1 ? (-debits[0][1]).toString() : null,
    walletOutputToken: credits.length === 1 ? credits[0][0] : null,
    walletOutputRaw: credits.length === 1 ? credits[0][1].toString() : null,
    walletNativeOutputRaw: nativeNet != null && nativeNet > ZERO ? nativeNet.toString() : null,
    venuesInOrder: swapLogs.map((l) => (l.topics[0] === V4_SWAP_TOPIC0 ? 'v4' : l.topics[0] === V2_SWAP_TOPIC0 ? 'v2' : 'v3') as 'v2' | 'v3' | 'v4'),
    swapAddresses: swapLogs.map((l) => l.address),
    routeHopCount: swapLogs.length,
    nativeEvidence: nativeEvidenceOut,
    nativeAttributionStatus: input.native.status,
    ownershipProven: receipt.from === wallet,
  }
  const finish = (o: Partial<RobinhoodMixedRouteForensics> & { finalClassification: RhMixedClassification; reason: string }): RobinhoodMixedRouteForensics => ({
    ...base,
    routeCurrencies: [], hops: [...nonV4Hops, ...v4Hops(true)].sort((a, b) => a.index - b.index), connectedSwapIndexes: [], excludedSwapIndexes: [],
    outsideFundingFlows: [], unrelatedWalletFlows: [], retainedFeeFlows: [], v4SignReading: null,
    singleConnectedEconomicRoute: false, amountConservationPassed: false,
    ...o,
  })

  if (!base.ownershipProven) return finish({ finalClassification: 'ambiguous', reason: 'tx.from != wallet: mixed routes are only considered for the wallet\'s own transactions' })
  if (receipt.status !== 1) return finish({ finalClassification: 'ambiguous', reason: 'reverted tx' })
  if (liquidity) return finish({ finalClassification: 'independent_second_action', reason: 'liquidity add/remove in the same tx' })
  if (v4Raw.length === 0) return finish({ finalClassification: 'ambiguous', reason: 'no canonical V4 swap in this receipt' })
  const unresolved = nonV4Hops.find((h) => h.unresolved)
  if (unresolved) return finish({ finalClassification: 'ambiguous', reason: `swap #${unresolved.index} (${unresolved.venue} ${unresolved.address}) not resolvable from transfers: ${unresolved.unresolved}` })
  if (debits.length > 1) return finish({ finalClassification: 'independent_second_action', reason: `wallet paid ${debits.length} different assets`, unrelatedWalletFlows: debits.slice(1).map(([token, v]) => ({ token, direction: 'out', raw: (-v).toString() })) })
  if (credits.length > 1) return finish({ finalClassification: 'independent_second_action', reason: `wallet received ${credits.length} different assets`, unrelatedWalletFlows: credits.slice(1).map(([token, v]) => ({ token, direction: 'in', raw: v.toString() })) })
  if (debits.length === 0) return finish({ finalClassification: 'ambiguous', reason: 'no wallet input debit' })
  if (credits.length === 0) {
    const nativeWhy = input.native.status === 'proven_target_tx_native_transfer' ? 'the target tx\'s trace paid the wallet no native ETH' : `native output not attributable to this tx (${input.native.status})`
    return finish({ finalClassification: 'ambiguous', reason: `no provable final wallet output: no ERC-20 credit and ${nativeWhy}` })
  }
  const [inToken, inNeg] = debits[0]
  const [outToken, outRaw] = credits[0]
  const inRaw = -inNeg

  // ── Flow proof, for one V4 sign reading at a time ────────────────────────────────────────────────
  type Attempt = { ok: boolean; cls: RhMixedClassification; reason: string; connected: number[]; excluded: number[]; conservation: boolean; currencies: string[]; hops: RhMixedHop[]; retained: RobinhoodMixedRouteForensics['retainedFeeFlows']; outside: RobinhoodMixedRouteForensics['outsideFundingFlows'] }
  const attempt = (negativeIsInput: boolean): Attempt => {
    const hops = [...nonV4Hops, ...v4Hops(negativeIsInput)].sort((a, b) => a.index - b.index)
    const fail = (cls: RhMixedClassification, reason: string, extra: Partial<Attempt> = {}): Attempt => ({ ok: false, cls, reason, connected: [], excluded: [], conservation: false, currencies: [], hops, retained: [], outside: [], ...extra })
    const bad = hops.find((h) => h.unresolved)
    if (bad) return fail('ambiguous', `swap #${bad.index}: ${bad.unresolved}`)
    // Reachability: forward from the wallet's input asset, backward from its output asset.
    const fwd = new Set([inToken])
    for (let changed = true; changed;) { changed = false; for (const h of hops) if (fwd.has(h.inToken!) && !fwd.has(h.outToken!)) { fwd.add(h.outToken!); changed = true } }
    const back = new Set([outToken])
    for (let changed = true; changed;) { changed = false; for (const h of hops) if (back.has(h.outToken!) && !back.has(h.inToken!)) { back.add(h.inToken!); changed = true } }
    const connected = hops.filter((h) => fwd.has(h.inToken!) && back.has(h.outToken!)).map((h) => h.index)
    const excluded = hops.filter((h) => !connected.includes(h.index)).map((h) => h.index)
    const currencies = [...new Set(hops.flatMap((h) => [h.inToken!, h.outToken!]))]
    if (!back.has(inToken) || !fwd.has(outToken)) return fail('ambiguous', `no connected route from ${inToken} to ${outToken}`, { connected, excluded, currencies })
    if (excluded.length > 0) return fail('independent_second_action', `swap(s) ${excluded.join(',')} are not on the wallet's ${inToken} → ${outToken} route`, { connected, excluded, currencies })
    // Conservation per asset: supply (wallet input + produced) vs demand (consumed + wallet output).
    const supply = new Map<string, bigint>([[inToken, inRaw]])
    const demand = new Map<string, bigint>([[outToken, outRaw]])
    for (const h of hops) {
      supply.set(h.outToken!, (supply.get(h.outToken!) ?? ZERO) + BigInt(h.outRaw!))
      demand.set(h.inToken!, (demand.get(h.inToken!) ?? ZERO) + BigInt(h.inRaw!))
    }
    const retained: Attempt['retained'] = []
    for (const asset of new Set([...supply.keys(), ...demand.keys()])) {
      const s = supply.get(asset) ?? ZERO
      const d = demand.get(asset) ?? ZERO
      if (d > s) return fail('independent_second_action', `${asset}: route consumed ${d} but only ${s} was supplied by the wallet / produced by the route (outside funding)`, { connected, excluded, currencies })
      if (!withinFee(s - d, s)) return fail('independent_second_action', `${asset}: ${s - d} left the route beyond the fee bound (value diverted)`, { connected, excluded, currencies })
      if (s > d) retained.push({ token: asset, holder: 'route_leftover', raw: (s - d).toString() })
    }
    // Who supplied route assets: anyone other than the wallet, a venue, the PoolManager or a net-zero
    // pass-through is outside funding.
    const nets = new Map<string, Map<string, bigint>>()
    const bump = (asset: string, holder: string, v: bigint) => {
      const per = nets.get(asset) ?? new Map<string, bigint>()
      per.set(holder, (per.get(holder) ?? ZERO) + v)
      nets.set(asset, per)
    }
    for (const t of transfers) {
      const a = norm(t.token)
      if (!currencies.includes(a)) continue
      bump(a, t.from, -t.amount)
      bump(a, t.to, t.amount)
    }
    if (currencies.includes(NATIVE_ASSET)) {
      for (const l of receipt.logs) {
        if (l.address !== RH_WETH || l.topics.length < 2) continue
        const wad = word(l.data, 0, false)
        if (wad == null) continue
        if (l.topics[0] === WETH_DEPOSIT_TOPIC0) bump(NATIVE_ASSET, addr(l.topics[1]), wad) // ETH in → WETH credited
        if (l.topics[0] === WETH_WITHDRAWAL_TOPIC0) bump(NATIVE_ASSET, addr(l.topics[1]), -wad) // WETH burned → ETH out
      }
    }
    const outside: Attempt['outside'] = []
    for (const [asset, per] of nets) {
      for (const [holder, v] of per) {
        if (holder === wallet || holder === pm || venueAddresses.has(holder) || holder === RH_NATIVE || holder === RH_WETH) continue
        if (v < ZERO) {
          const t = transfers.find((x) => norm(x.token) === asset && x.from === holder)!
          outside.push({ token: asset, from: holder, to: t.to, raw: (-v).toString() })
        } else if (v > ZERO) retained.push({ token: asset, holder, raw: v.toString() })
      }
    }
    if (outside.length > 0) return fail('independent_second_action', `route assets supplied by ${outside.map((o) => o.from).join(',')}`, { connected, excluded, currencies, outside, retained, conservation: true })
    return { ok: true, cls: 'direct_mixed_route_proven', reason: `one connected ${hops.map((h) => h.venue).join('→')} route from ${inToken} to ${outToken}`, connected, excluded, conservation: true, currencies, hops, retained, outside }
  }
  // The wallet's transfers of assets the route never trades are unrelated actions.
  const pass = [attempt(true), attempt(false)]
  const okOnes = pass.filter((a) => a.ok)
  const chosen = okOnes.length === 1 ? okOnes[0] : pass[0]
  const reading = okOnes.length === 1 ? (okOnes[0] === pass[0] ? 'negative_is_input' : 'positive_is_input') : null
  const unrelated = transfers
    .filter((t) => (t.from === wallet || t.to === wallet) && !chosen.currencies.includes(norm(t.token)))
    .map((t) => ({ token: t.token, direction: (t.from === wallet ? 'out' : 'in') as 'out' | 'in', raw: t.amount.toString() }))
  const common = {
    routeCurrencies: chosen.currencies, hops: chosen.hops, connectedSwapIndexes: chosen.connected, excludedSwapIndexes: chosen.excluded,
    outsideFundingFlows: chosen.outside, retainedFeeFlows: chosen.retained, unrelatedWalletFlows: unrelated, v4SignReading: reading as RobinhoodMixedRouteForensics['v4SignReading'],
    amountConservationPassed: chosen.conservation,
  }
  if (okOnes.length > 1) return finish({ ...common, finalClassification: 'ambiguous', reason: 'both V4 sign readings produce a valid route' })
  if (okOnes.length === 0) return finish({ ...common, finalClassification: chosen.cls, reason: chosen.reason })
  if (unrelated.length > 0) return finish({ ...common, finalClassification: 'independent_second_action', reason: 'wallet moved an asset the route does not trade' })
  return finish({ ...common, singleConnectedEconomicRoute: true, finalClassification: 'direct_mixed_route_proven', reason: chosen.reason })
}
