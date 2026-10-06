// ROBINHOOD ACQUISITION RECOVERY — classifies ONE earlier inbound of a sold token (pure, log evidence only).
//
// Receiving a token is never a buy by itself. An inbound is a verified_buy only when the receipt proves one
// economic action funded by the wallet:
//   wallet paid exactly one asset (ERC-20 Transfer from the wallet)  →  connected swap route  →  exactly the
//   target token delivered to the wallet (net), with no outside funding, no competing payer (another address
//   paying the route's input, or the tx sender attaching native value), no swap off the route, no other
//   wallet flow, no liquidity event, and per-asset amount conservation (leftovers within the fee bound).
// The tx sender / router identity is never ownership evidence. A relayed tx cannot debit the wallet's native
// ETH, so wallet funding here is always an ERC-20 (WETH included) Transfer out of the wallet.
// Without provable wallet funding an inbound is transfer_in / distribution_or_claim, or — when a swap in
// someone else's tx delivered it — relayed_swap_candidate. Never a buy.

import { ROBINHOOD_ROUTE_MAX_FEE_FRACTION, ERC20_TRANSFER_TOPIC0, V4_SWAP_TOPIC0, RH_WETH, RH_NATIVE, type RhPoolKey, type RhReceipt } from './robinhoodPnlV1'
import { V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, NATIVE_ASSET, type RhMixedHop } from './robinhoodMixedRouteForensics'

export type RhAcquisitionClass = 'verified_buy' | 'transfer_in' | 'distribution_or_claim' | 'relayed_swap_candidate' | 'ambiguous'

export type RhAcquisitionProof = {
  txHash: string
  classification: RhAcquisitionClass
  /** The wallet's exact debit (actual token address; WETH stays WETH). */
  walletFundingToken: string | null
  walletFundingRaw: string | null
  /** The wallet's exact net credit of the target token in this tx. */
  walletCreditRaw: string | null
  routeProven: boolean
  ownershipProven: boolean
  /** Connected hops in log order (verified_buy only). */
  hops: RhMixedHop[]
  firstLogIndex: number | null
  /** Native/WETH the route passed through, for token↔token routes priced via ETH (verified_buy only). */
  nativeThroughRaw: string | null
  rejectionReason: string | null
}

const ZERO = BigInt(0)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const LIQUIDITY_TOPICS = new Set([
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec', // V4 ModifyLiquidity
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
])
const addr = (topic: string) => `0x${topic.slice(-40)}`
const abs = (v: bigint) => (v < ZERO ? -v : v)
function word(data: string, i: number, signed: boolean): bigint | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const w = hex.slice(i * 64, i * 64 + 64)
  if (!/^[0-9a-f]{64}$/i.test(w)) return null
  const v = BigInt(`0x${w}`)
  return signed && v >= BigInt(2) ** BigInt(255) ? v - BigInt(2) ** BigInt(256) : v
}

type Transfer = { token: string; from: string; to: string; amount: bigint; logIndex: number }

/** PURE. */
export function classifyRobinhoodAcquisition(input: {
  wallet: string
  txHash: string
  receipt: RhReceipt
  targetToken: string
  /** The inbound amount the activity row reported; when given, the wallet's net credit must equal it. */
  inboundRaw: bigint | null
  poolManager: string
  v4PoolKeys: ReadonlyMap<string, RhPoolKey>
  /** The tx's own top-level native value (null = unknown). */
  txValue: bigint | null
}): RhAcquisitionProof {
  const norm = (token: string) => (token === RH_WETH || token === RH_NATIVE ? NATIVE_ASSET : token)
  const withinFee = (left: bigint, flow: bigint) => left >= ZERO && (left === ZERO || left * BigInt(10_000) <= flow * BigInt(Math.round(ROBINHOOD_ROUTE_MAX_FEE_FRACTION * 10_000)))
  const wallet = input.wallet.toLowerCase()
  const target = input.targetToken.toLowerCase()
  const pm = input.poolManager.toLowerCase()
  const { receipt } = input
  const isSender = receipt.from === wallet
  const out = (o: Partial<RhAcquisitionProof> & { classification: RhAcquisitionClass }): RhAcquisitionProof => ({
    txHash: input.txHash, walletFundingToken: null, walletFundingRaw: null, walletCreditRaw: null, routeProven: false, ownershipProven: false,
    hops: [], firstLogIndex: null, nativeThroughRaw: null, rejectionReason: null, ...o,
  })
  if (receipt.status !== 1) return out({ classification: 'ambiguous', rejectionReason: 'tx_reverted' })

  const transfers: Transfer[] = []
  for (const l of receipt.logs) {
    if (l.topics[0] !== ERC20_TRANSFER_TOPIC0 || l.topics.length !== 3) continue
    const amount = word(l.data, 0, false)
    if (amount != null) transfers.push({ token: l.address, from: addr(l.topics[1]), to: addr(l.topics[2]), amount, logIndex: l.logIndex })
  }
  const walletNet = new Map<string, bigint>()
  for (const t of transfers) {
    if (t.from === wallet) walletNet.set(norm(t.token), (walletNet.get(norm(t.token)) ?? ZERO) - t.amount)
    if (t.to === wallet) walletNet.set(norm(t.token), (walletNet.get(norm(t.token)) ?? ZERO) + t.amount)
  }
  for (const [k, v] of walletNet) if (v === ZERO) walletNet.delete(k)
  const targetKey = norm(target)
  const credit = walletNet.get(targetKey) ?? ZERO
  const walletCreditRaw = credit > ZERO ? credit.toString() : null
  if (credit <= ZERO) return out({ classification: 'ambiguous', rejectionReason: 'wallet_received_no_net_target_token' })
  const swapLogs = receipt.logs.filter((l) => l.topics[0] === V2_SWAP_TOPIC0 || l.topics[0] === V3_SWAP_TOPIC0 || (l.topics[0] === V4_SWAP_TOPIC0 && l.address === pm))
  if (receipt.logs.some((l) => LIQUIDITY_TOPICS.has(l.topics[0] ?? ''))) return out({ classification: 'ambiguous', walletCreditRaw, rejectionReason: 'liquidity_event_in_tx' })

  const debits = [...walletNet].filter(([, v]) => v < ZERO)
  const credits = [...walletNet].filter(([, v]) => v > ZERO)
  if (debits.length === 0) {
    // No wallet funding: never a buy.
    if (swapLogs.length > 0 && !isSender) return out({ classification: 'relayed_swap_candidate', walletCreditRaw, rejectionReason: 'swap in a tx the wallet did not send delivered the token, but no wallet funding is provable' })
    if (swapLogs.length > 0) return out({ classification: 'ambiguous', walletCreditRaw, rejectionReason: 'swap delivered the token, but the wallet paid nothing provable in this tx' })
    const inTarget = transfers.filter((t) => t.token === target && t.to === wallet)
    const minted = inTarget.some((t) => t.from === ZERO_ADDRESS)
    const senders = new Set(inTarget.map((t) => t.from))
    const fanOut = [...senders].some((s) => new Set(transfers.filter((t) => t.token === target && t.from === s).map((t) => t.to)).size >= 2)
    if (minted || fanOut || isSender) return out({ classification: 'distribution_or_claim', walletCreditRaw, rejectionReason: minted ? 'token minted to the wallet' : fanOut ? 'sender distributed the token to several recipients' : 'wallet-sent call that paid nothing (claim)' })
    return out({ classification: 'transfer_in', walletCreditRaw, rejectionReason: 'plain inbound transfer: no wallet funding, no swap' })
  }
  if (debits.length > 1 || credits.length > 1) {
    return out({ classification: 'ambiguous', walletCreditRaw, rejectionReason: `unrelated_second_action: wallet paid ${debits.length} and received ${credits.length} different assets` })
  }
  const [inToken, inNeg] = debits[0]
  const inRaw = -inNeg
  const fundingTransfer = transfers.find((t) => t.from === wallet && norm(t.token) === inToken)!
  const funding = { walletFundingToken: fundingTransfer.token, walletFundingRaw: inRaw.toString(), walletCreditRaw }
  if (input.inboundRaw != null && credit !== input.inboundRaw) return out({ classification: 'ambiguous', ...funding, rejectionReason: `wallet_credit_mismatch: net ${credit} vs inbound ${input.inboundRaw}` })
  if (swapLogs.length === 0) return out({ classification: 'ambiguous', ...funding, rejectionReason: 'no_swap_route: wallet paid and received without any swap' })
  if (!isSender && input.txValue != null && input.txValue > ZERO) return out({ classification: 'ambiguous', ...funding, rejectionReason: `competing_payer: tx sender ${receipt.from} attached ${input.txValue} native value` })

  // ── Hops (same evidence rules as the mixed-route analyzer) ─────────────────────────────────────────
  const venueAddresses = new Set(swapLogs.map((l) => l.address))
  const matchToken = (pool: string, amount: bigint, dir: 'in' | 'out'): { token: string | null; why: string | null } => {
    const tokens = [...new Set(transfers.filter((t) => t.amount === amount && (dir === 'in' ? t.to === pool : t.from === pool)).map((t) => t.token))]
    if (tokens.length === 1) return { token: tokens[0], why: null }
    return { token: null, why: tokens.length === 0 ? `no Transfer ${dir === 'in' ? 'into' : 'out of'} ${pool} of exactly ${amount}` : `${tokens.length} tokens match ${amount} ${dir}` }
  }
  const nonV4: RhMixedHop[] = []
  const v4Raw: Array<{ index: number; logIndex: number; key: RhPoolKey | undefined; a0: bigint | null; a1: bigint | null }> = []
  swapLogs.forEach((l, index) => {
    if (l.topics[0] === V4_SWAP_TOPIC0) { v4Raw.push({ index, logIndex: l.logIndex, key: input.v4PoolKeys.get(l.topics[1]), a0: word(l.data, 0, true), a1: word(l.data, 1, true) }); return }
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
    nonV4.push(hop)
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

  // ── Route proof for one V4 sign reading ────────────────────────────────────────────────────────────
  type Attempt = { ok: boolean; reason: string; hops: RhMixedHop[] }
  const attempt = (negativeIsInput: boolean): Attempt => {
    const hops = [...nonV4, ...v4Hops(negativeIsInput)].sort((a, b) => a.index - b.index)
    const fail = (reason: string): Attempt => ({ ok: false, reason, hops })
    const bad = hops.find((h) => h.unresolved)
    if (bad) return fail(`swap #${bad.index} (${bad.venue} ${bad.address}) unresolved: ${bad.unresolved}`)
    const fwd = new Set([inToken])
    for (let changed = true; changed;) { changed = false; for (const h of hops) if (fwd.has(h.inToken!) && !fwd.has(h.outToken!)) { fwd.add(h.outToken!); changed = true } }
    const back = new Set([targetKey])
    for (let changed = true; changed;) { changed = false; for (const h of hops) if (back.has(h.outToken!) && !back.has(h.inToken!)) { back.add(h.inToken!); changed = true } }
    if (!fwd.has(targetKey)) return fail(`route_not_connected: no swap path from ${inToken} to ${targetKey}`)
    const excluded = hops.filter((h) => !(fwd.has(h.inToken!) && back.has(h.outToken!)))
    if (excluded.length > 0) return fail(`unrelated_second_action: swap(s) ${excluded.map((h) => h.index).join(',')} are off the wallet's ${inToken} → ${targetKey} route`)
    const currencies = new Set(hops.flatMap((h) => [h.inToken!, h.outToken!]))
    const supply = new Map<string, bigint>([[inToken, inRaw]])
    const demand = new Map<string, bigint>([[targetKey, credit]])
    for (const h of hops) {
      supply.set(h.outToken!, (supply.get(h.outToken!) ?? ZERO) + BigInt(h.outRaw!))
      demand.set(h.inToken!, (demand.get(h.inToken!) ?? ZERO) + BigInt(h.inRaw!))
    }
    for (const asset of new Set([...supply.keys(), ...demand.keys()])) {
      const s = supply.get(asset) ?? ZERO
      const d = demand.get(asset) ?? ZERO
      if (d > s) return fail(`${asset === inToken ? 'competing_payer' : 'outside_funding'}: route consumed ${d} ${asset} but the wallet / route supplied only ${s}`)
      if (!withinFee(s - d, s)) return fail(`value_diverted: ${s - d} ${asset} left the route beyond the fee bound`)
    }
    // Every holder of a route asset other than the wallet, a venue, the PoolManager or a net-zero
    // pass-through that ends net negative paid into the route.
    const nets = new Map<string, Map<string, bigint>>()
    const bump = (asset: string, holder: string, v: bigint) => {
      const per = nets.get(asset) ?? new Map<string, bigint>()
      per.set(holder, (per.get(holder) ?? ZERO) + v)
      nets.set(asset, per)
    }
    for (const t of transfers) {
      const a = norm(t.token)
      if (!currencies.has(a)) continue
      bump(a, t.from, -t.amount)
      bump(a, t.to, t.amount)
    }
    if (currencies.has(NATIVE_ASSET)) {
      for (const l of receipt.logs) {
        if (l.address !== RH_WETH || l.topics.length < 2) continue
        const wad = word(l.data, 0, false)
        if (wad == null) continue
        if (l.topics[0] === WETH_DEPOSIT_TOPIC0) bump(NATIVE_ASSET, addr(l.topics[1]), wad)
        if (l.topics[0] === WETH_WITHDRAWAL_TOPIC0) bump(NATIVE_ASSET, addr(l.topics[1]), -wad)
      }
    }
    for (const [asset, per] of nets) {
      for (const [holder, v] of per) {
        if (holder === wallet || holder === pm || venueAddresses.has(holder) || holder === RH_NATIVE || holder === RH_WETH) continue
        if (v < ZERO) return fail(`${asset === inToken ? 'competing_payer' : 'outside_funding'}: ${holder} paid ${-v} ${asset} into the route`)
        if (asset === targetKey && !withinFee(v, credit + v)) return fail(`value_diverted: ${holder} kept ${v} of the target token`)
      }
    }
    return { ok: true, reason: `one connected ${hops.map((h) => h.venue).join('→')} route from ${inToken} to ${targetKey}`, hops }
  }
  const pass = v4Raw.length > 0 ? [attempt(true), attempt(false)] : [attempt(true)]
  const ok = pass.filter((a) => a.ok)
  if (ok.length > 1) return out({ classification: 'ambiguous', ...funding, rejectionReason: 'both V4 sign readings produce a valid route' })
  if (ok.length === 0) return out({ classification: 'ambiguous', ...funding, rejectionReason: pass[0].reason })
  const hops = ok[0].hops
  const nativeThrough = inToken === NATIVE_ASSET ? ZERO : hops.filter((h) => h.inToken === NATIVE_ASSET).reduce((s, h) => s + BigInt(h.inRaw!), ZERO)
  return out({
    classification: 'verified_buy', ...funding, routeProven: true, ownershipProven: true, hops,
    firstLogIndex: Math.min(...hops.map((h) => h.logIndex)),
    nativeThroughRaw: nativeThrough > ZERO ? nativeThrough.toString() : null,
  })
}

/**
 * PURE. Exact (bigint) FIFO replay of the token legs of verified swaps — the same chronology and rules as
 * buildRobinhoodPnlV1Fifo — returning each sell's unmatched raw quantity.
 */
export function robinhoodUnmatchedSellRaw(swaps: ReadonlyArray<{ txHash: string; timestampSec: number; blockNumber: number; firstLogIndex: number; inputToken: string; outputToken: string; inputRaw: bigint; outputRaw: bigint }>, isQuote: (token: string) => boolean): Map<string, { token: string; sellRaw: bigint; unmatchedRaw: bigint; timestampSec: number }> {
  const ordered = [...swaps].sort((a, b) => a.timestampSec - b.timestampSec || a.blockNumber - b.blockNumber || a.firstLogIndex - b.firstLogIndex || a.txHash.localeCompare(b.txHash))
  const lots = new Map<string, Array<{ ts: number; left: bigint }>>()
  const out = new Map<string, { token: string; sellRaw: bigint; unmatchedRaw: bigint; timestampSec: number }>()
  // Buys first within the walk, exactly as the FIFO engine builds all lots before matching (openedAt <= sell time).
  for (const s of ordered) if (!isQuote(s.outputToken)) { const q = lots.get(s.outputToken) ?? []; q.push({ ts: s.timestampSec, left: s.outputRaw }); lots.set(s.outputToken, q) }
  for (const s of ordered) {
    if (isQuote(s.inputToken)) continue
    let need = s.inputRaw
    for (const lot of lots.get(s.inputToken) ?? []) {
      if (need <= ZERO) break
      if (lot.ts > s.timestampSec) break
      const take = lot.left < need ? lot.left : need
      lot.left -= take
      need -= take
    }
    out.set(s.txHash, { token: s.inputToken, sellRaw: s.inputRaw, unmatchedRaw: need, timestampSec: s.timestampSec })
  }
  return out
}
