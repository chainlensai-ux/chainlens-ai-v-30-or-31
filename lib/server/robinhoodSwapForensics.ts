// ROBINHOOD SWAP VERIFICATION FORENSICS — diagnostic only; never changes what PnL V1 accepts.
//
// For every candidate receipt it records who sent the tx, every wallet debit/credit, every V4 / other-venue
// log, and who paid and who received the traded assets. Every receipt with a V4 Swap from the canonical
// PoolManager is then put in exactly one class:
//   A direct_wallet_swap                     tx.from == wallet and the existing route proof passes
//   B relayed_wallet_swap_proven             tx.from != wallet, but the wallet alone supplies the exact route
//                                            input and alone receives the exact route output (proof below)
//   C wallet_transfer_inside_other_user_swap the wallet only appears in someone else's trade
//   D ambiguous                              anything that cannot be proven either way
//
// B ("exact economic attribution") requires ALL of: the existing route proof run without the sender check
// (exact wallet debit, exact wallet credit, one connected canonical-PoolManager V4 path between them, every
// V4 swap on that path, no transfer of a token the route does not trade, amounts within the existing fee
// bound); no other V4 venue or liquidity event; both wallet legs are ERC-20 (a native leg of a tx the
// wallet did not send is not visible in logs); no other address supplied the input token; no other address
// kept more than the fee bound of the output token. The router / relayer address is never evidence of
// ownership — only token movements are. tx.from != wallet alone is never sufficient.

import { verifyRobinhoodV4Route, ROBINHOOD_ROUTE_MAX_FEE_FRACTION, V4_SWAP_TOPIC0, V4_MODIFY_LIQUIDITY_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhPoolKey, type RhReceipt } from './robinhoodPnlV1'

const V2_SWAP_TOPIC0 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
const V3_SWAP_TOPIC0 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const OTHER_LIQUIDITY_TOPICS = new Set([
  '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
  '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
])
const ZERO = BigInt(0)

export type RhAttributionClass = 'direct_wallet_swap' | 'relayed_wallet_swap_proven' | 'wallet_transfer_inside_other_user_swap' | 'ambiguous'
type Flow = { token: string; raw: string; counterparty: string; logIndex: number }

export type RobinhoodSwapForensics = {
  txHash: string
  timestamp: number | null
  txFrom: string
  txTo: string | null
  wallet: string
  rejectionReason: string | null
  receiptLogCount: number
  v4SwapLogCount: number
  poolManagerAddresses: string[]
  otherSwapVenueLogs: Array<{ address: string; venue: 'uniswap_v2_style_swap' | 'uniswap_v3_style_swap'; logIndex: number }>
  liquidityEventLogs: Array<{ address: string; topic0: string; logIndex: number }>
  /** v4_only | other_only (no V4 at all) | mixed | none — separates genuine mixed-venue txs from plain V2/V3 trades. */
  venueMix: 'v4_only' | 'other_only' | 'mixed' | 'none'
  walletTokenOutflows: Flow[]
  walletTokenInflows: Flow[]
  /** Exact native change attributable to this tx (gas excluded); null when unproven. */
  walletNativeValueSent: string | null
  walletNativeValueReceived: string | null
  candidateInputToken: string | null
  candidateInputRaw: string | null
  candidateOutputToken: string | null
  candidateOutputRaw: string | null
  payerAddresses: string[]
  recipientAddresses: string[]
  settlementAddresses: string[]
  walletIsTxSender: boolean
  walletIsDirectTokenPayer: boolean
  walletIsDirectTokenRecipient: boolean
  walletIsNativePayer: boolean
  walletIsNativeRecipient: boolean
  connectedWalletToV4Input: boolean
  connectedV4OutputToWallet: boolean
  routeUniquelyAttributable: boolean
  /** Null when the receipt has no V4 Swap from the canonical PoolManager. */
  attributionClass: RhAttributionClass | null
  attributionDetail: string | null
}

const addr = (topic: string) => `0x${topic.slice(-40)}`
function wordAmount(data: string): bigint | null {
  const hex = data.startsWith('0x') ? data.slice(2, 66) : data.slice(0, 64)
  return /^[0-9a-f]{64}$/i.test(hex) ? BigInt(`0x${hex}`) : null
}
const withinFee = (left: bigint, flow: bigint) => left <= ZERO || left * BigInt(10_000) <= flow * BigInt(Math.round(ROBINHOOD_ROUTE_MAX_FEE_FRACTION * 10_000))

/** PURE. `walletNativeDelta`: the wallet's exact native change from this tx with gas added back; null when unproven. */
export function buildRobinhoodSwapForensics(input: {
  wallet: string
  txHash: string
  timestampSec: number | null
  receipt: RhReceipt
  poolManager: string
  poolKeys: ReadonlyMap<string, RhPoolKey>
  walletNativeDelta: bigint | null
  rejectionReason: string | null
}): RobinhoodSwapForensics {
  const wallet = input.wallet.toLowerCase()
  const pm = input.poolManager.toLowerCase()
  const { receipt } = input
  const v4Logs = receipt.logs.filter((l) => l.topics[0] === V4_SWAP_TOPIC0)
  const canonicalV4 = v4Logs.filter((l) => l.address === pm)
  const other = receipt.logs
    .filter((l) => l.topics[0] === V2_SWAP_TOPIC0 || l.topics[0] === V3_SWAP_TOPIC0)
    .map((l) => ({ address: l.address, venue: (l.topics[0] === V2_SWAP_TOPIC0 ? 'uniswap_v2_style_swap' : 'uniswap_v3_style_swap') as 'uniswap_v2_style_swap' | 'uniswap_v3_style_swap', logIndex: l.logIndex }))
  const liquidity = receipt.logs
    .filter((l) => l.topics[0] === V4_MODIFY_LIQUIDITY_TOPIC0 || OTHER_LIQUIDITY_TOPICS.has(l.topics[0] ?? ''))
    .map((l) => ({ address: l.address, topic0: l.topics[0], logIndex: l.logIndex }))
  const venueMix = v4Logs.length > 0 && other.length > 0 ? 'mixed' : v4Logs.length > 0 ? 'v4_only' : other.length > 0 ? 'other_only' : 'none'

  // Every ERC-20 Transfer, and each address's net per token.
  const outflows: Flow[] = []
  const inflows: Flow[] = []
  const net = new Map<string, Map<string, bigint>>() // token -> address -> net
  const touched = new Map<string, { in: boolean; out: boolean }>() // address -> moved any token in/out
  for (const l of receipt.logs) {
    if (l.topics[0] !== ERC20_TRANSFER_TOPIC0 || l.topics.length !== 3) continue
    const amount = wordAmount(l.data)
    if (amount == null) continue
    const from = addr(l.topics[1])
    const to = addr(l.topics[2])
    const per = net.get(l.address) ?? new Map<string, bigint>()
    per.set(from, (per.get(from) ?? ZERO) - amount)
    per.set(to, (per.get(to) ?? ZERO) + amount)
    net.set(l.address, per)
    touched.set(from, { in: touched.get(from)?.in ?? false, out: true })
    touched.set(to, { in: true, out: touched.get(to)?.out ?? false })
    if (from === wallet) outflows.push({ token: l.address, raw: amount.toString(), counterparty: to, logIndex: l.logIndex })
    if (to === wallet) inflows.push({ token: l.address, raw: amount.toString(), counterparty: from, logIndex: l.logIndex })
  }

  // The wallet's candidate legs: its single net debit and single net credit (ERC-20 + proven native).
  const walletNet = new Map<string, bigint>()
  for (const [token, per] of net) { const v = per.get(wallet) ?? ZERO; if (v !== ZERO) walletNet.set(token, v) }
  const native = '0x0000000000000000000000000000000000000000'
  if (input.walletNativeDelta != null && input.walletNativeDelta !== ZERO) walletNet.set(native, input.walletNativeDelta)
  const debits = [...walletNet].filter(([, v]) => v < ZERO)
  const credits = [...walletNet].filter(([, v]) => v > ZERO)
  const candIn = debits.length === 1 ? debits[0] : null
  const candOut = credits.length === 1 ? credits[0] : null

  const routeCurrencies = new Set([...input.poolKeys.values()].flatMap((k) => [k.currency0.toLowerCase(), k.currency1.toLowerCase()]))
  // Who actually paid into / took out of the traded currencies (any route currency, PoolManager excluded);
  // a pass-through router nets to zero and lands in settlementAddresses instead.
  const sideAddresses = (sign: 1 | -1) => [...new Set([...routeCurrencies].flatMap((token) =>
    [...(net.get(token) ?? new Map<string, bigint>()).entries()].filter(([a, v]) => a !== pm && (sign < 0 ? v < ZERO : v > ZERO)).map(([a]) => a)))]
  const payers = sideAddresses(-1)
  const recipients = sideAddresses(1)
  const settlement = new Set<string>(canonicalV4.length > 0 ? [pm] : [])
  for (const token of routeCurrencies) {
    for (const [a, v] of net.get(token) ?? new Map<string, bigint>()) {
      const t = touched.get(a)
      if (a !== wallet && v === ZERO && t?.in && t.out) settlement.add(a)
    }
  }

  const base: Omit<RobinhoodSwapForensics, 'attributionClass' | 'attributionDetail' | 'routeUniquelyAttributable' | 'connectedWalletToV4Input' | 'connectedV4OutputToWallet'> = {
    txHash: input.txHash,
    timestamp: input.timestampSec,
    txFrom: receipt.from,
    txTo: receipt.to,
    wallet,
    rejectionReason: input.rejectionReason,
    receiptLogCount: receipt.logs.length,
    v4SwapLogCount: v4Logs.length,
    poolManagerAddresses: [...new Set(v4Logs.map((l) => l.address))],
    otherSwapVenueLogs: other,
    liquidityEventLogs: liquidity,
    venueMix,
    walletTokenOutflows: outflows,
    walletTokenInflows: inflows,
    walletNativeValueSent: input.walletNativeDelta != null && input.walletNativeDelta < ZERO ? (-input.walletNativeDelta).toString() : input.walletNativeDelta != null ? '0' : null,
    walletNativeValueReceived: input.walletNativeDelta != null && input.walletNativeDelta > ZERO ? input.walletNativeDelta.toString() : input.walletNativeDelta != null ? '0' : null,
    candidateInputToken: candIn?.[0] ?? null,
    candidateInputRaw: candIn ? (-candIn[1]).toString() : null,
    candidateOutputToken: candOut?.[0] ?? null,
    candidateOutputRaw: candOut ? candOut[1].toString() : null,
    payerAddresses: payers,
    recipientAddresses: recipients,
    settlementAddresses: [...settlement],
    walletIsTxSender: receipt.from === wallet,
    walletIsDirectTokenPayer: outflows.length > 0,
    walletIsDirectTokenRecipient: inflows.length > 0,
    walletIsNativePayer: input.walletNativeDelta != null && input.walletNativeDelta < ZERO,
    walletIsNativeRecipient: input.walletNativeDelta != null && input.walletNativeDelta > ZERO,
  }
  const connectedIn = candIn != null && routeCurrencies.has(candIn[0])
  const connectedOut = candOut != null && routeCurrencies.has(candOut[0])
  const done = (cls: RhAttributionClass | null, detail: string | null, extra: { unique?: boolean; inOk?: boolean; outOk?: boolean } = {}): RobinhoodSwapForensics => ({
    ...base,
    connectedWalletToV4Input: extra.inOk ?? connectedIn,
    connectedV4OutputToWallet: extra.outOk ?? connectedOut,
    routeUniquelyAttributable: extra.unique ?? false,
    attributionClass: cls,
    attributionDetail: detail,
  })

  if (canonicalV4.length === 0) return done(null, v4Logs.length > 0 ? 'V4 Swap logs only from a non-canonical PoolManager' : 'no V4 Swap in this receipt')
  if (receipt.status !== 1) return done('ambiguous', 'reverted tx')
  if (other.length > 0) return done('ambiguous', `mixed venue: ${other.length} V2/V3-style swap log(s) besides V4`)
  if (liquidity.length > 0) return done('ambiguous', 'liquidity event in the same tx')
  if (v4Logs.length !== canonicalV4.length) return done('ambiguous', 'V4 Swap logs from more than one PoolManager')
  if (canonicalV4.some((l) => !input.poolKeys.has(l.topics[1]))) return done('ambiguous', 'a pool key is unproven')

  // The existing route proof, run WITHOUT the sender gate (the receipt's sender is irrelevant to it).
  const route = verifyRobinhoodV4Route({ wallet, txHash: input.txHash, receipt, poolKeys: input.poolKeys, nativeNet: input.walletNativeDelta })
  const isSender = receipt.from === wallet
  if (!route.ok) {
    const walletInvolved = outflows.length > 0 || inflows.length > 0 || base.walletIsNativeRecipient || base.walletIsNativePayer
    if (isSender) return done('ambiguous', `wallet sent the tx but the route proof fails: ${route.reason}`)
    if (walletInvolved && (debits.length === 0 || credits.length === 0)) {
      return done('wallet_transfer_inside_other_user_swap', `wallet only ${debits.length === 0 ? 'received' : 'paid'} in a trade it did not send (${route.reason})`)
    }
    return done('ambiguous', `route proof fails: ${route.reason}`)
  }
  if (isSender) return done('direct_wallet_swap', 'tx.from == wallet and the route proof passes', { unique: true, inOk: true, outOk: true })

  // Relayed: every extra condition of exact economic attribution.
  if (route.inputToken === native || route.outputToken === native || walletNet.has(native)) {
    return done('ambiguous', 'relayed tx with a native leg: native movements are not visible in logs', { inOk: true, outOk: true })
  }
  const otherPayers = [...(net.get(route.inputToken) ?? new Map<string, bigint>()).entries()].filter(([a, v]) => a !== wallet && a !== pm && v < ZERO).map(([a]) => a)
  if (otherPayers.length > 0) return done('wallet_transfer_inside_other_user_swap', `another address also supplied the input token: ${otherPayers.join(',')}`, { inOk: true, outOk: true })
  const pathOut = BigInt(route.hops[route.hops.length - 1].outRaw)
  const otherRecipients = [...(net.get(route.outputToken) ?? new Map<string, bigint>()).entries()].filter(([a, v]) => a !== wallet && a !== pm && v > ZERO)
  const keptElsewhere = otherRecipients.reduce((s, [, v]) => s + v, ZERO)
  if (keptElsewhere > ZERO && !withinFee(keptElsewhere, pathOut)) {
    return done('wallet_transfer_inside_other_user_swap', `another address received ${keptElsewhere} of the output token: ${otherRecipients.map(([a]) => a).join(',')}`, { inOk: true, outOk: true })
  }
  return done('relayed_wallet_swap_proven', 'wallet alone paid the exact input and alone received the exact output of one canonical V4 route', { unique: true, inOk: true, outOk: true })
}

export function summarizeAttribution(rows: ReadonlyArray<RobinhoodSwapForensics>): Record<RhAttributionClass, number> {
  const out: Record<RhAttributionClass, number> = { direct_wallet_swap: 0, relayed_wallet_swap_proven: 0, wallet_transfer_inside_other_user_swap: 0, ambiguous: 0 }
  for (const r of rows) if (r.attributionClass) out[r.attributionClass] += 1
  return out
}
