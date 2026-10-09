// Robinhood HISTORICAL ACQUISITION FUNDING audit — DIAGNOSTIC ONLY (never changes acceptance, FIFO, PnL or pricing).
//
// For an acquisition candidate that recovery did not prove: did the WALLET fund the route that produced the target
// token? Token receipt alone is never ownership, and a wallet native debit somewhere in the tx is never funding by
// itself. The funding path is "proven" only when the unchanged mixed-route analyzer, given the wallet's exact native
// leg from the COMPLETE target-tx trace (gas mechanics already removed by the caller), finds one connected,
// conserved route from a wallet-funded asset to the target token with no outside funding — and the trace shows no
// competing native payer. Everything else is reported with the deterministic reason it is not.

import {
  analyzeRobinhoodMixedRoute, deriveRhNativeEvidence, robinhoodMixedRouteGraph, NATIVE_ASSET,
  type RhNativeTransfer, type RobinhoodMixedRouteForensics,
} from './robinhoodMixedRouteForensics'
import type { RhPoolKey, RhReceipt } from './robinhoodPnlV1'

const ZERO = BigInt(0)
const ERC20_TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const lower = (s: string) => s.toLowerCase()
const addr = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase()

export type RhAcquisitionFundingAudit = {
  txHash: string; wallet: string; targetToken: string; txFrom: string; executor: string | null
  traceComplete: boolean
  topLevelTxValueRaw: string | null
  walletFundingAssets: string[]
  walletFundingRawByAsset: Record<string, string>
  directWalletDebits: Array<{ asset: string; to: string; raw: string; source: 'erc20_transfer' | 'native_trace' | 'tx_value' }>
  /** Everything that flowed INTO the executor (tx.to), by source: who prefunded it. */
  executorFundingSources: Array<{ asset: string; from: string; raw: string }>
  /** Non-wallet addresses with a net native debit (existing competing-payer rule) or outside funding of a route asset. */
  competingFundingSources: Array<{ asset: string; from: string; raw: string }>
  /** Wallet-funding asset flowing back to the wallet (refunds). */
  refundFlows: Array<{ asset: string; from: string; raw: string }>
  targetTokenCreditRaw: string
  connectedSwapActions: number[]
  independentSwapActions: number[]
  routeClassification: string
  routeReason: string
  fundingToOutputPathProven: boolean
  fundingPathReason: string
  safePromotionPossible: boolean
}

/** PURE. */
export function robinhoodAcquisitionFundingAudit(input: {
  wallet: string; txHash: string; receipt: RhReceipt; targetToken: string; poolManager: string; wethAddress: string
  v4PoolKeys: ReadonlyMap<string, RhPoolKey>
  /** The COMPLETE target-tx native trace with gas mechanics removed; null when no complete trace exists. */
  trace: readonly RhNativeTransfer[] | null
  txValue: bigint | null
}): RhAcquisitionFundingAudit {
  const wallet = lower(input.wallet)
  const target = lower(input.targetToken)
  const { receipt } = input
  const executor = receipt.to ? lower(receipt.to) : null
  const pm = lower(input.poolManager)
  const weth = lower(input.wethAddress)
  const transfers = receipt.logs
    .filter((l) => l.topics[0] === ERC20_TRANSFER_TOPIC0 && l.topics.length === 3 && /^0x[0-9a-fA-F]{1,64}$/.test(l.data))
    .map((l) => ({ token: lower(l.address), from: addr(l.topics[1]), to: addr(l.topics[2]), raw: BigInt(l.data) }))
  const native = (input.trace ?? []).filter((t) => t.success === true && t.value > ZERO).map((t) => ({ from: lower(t.from), to: lower(t.to), raw: t.value }))
  const isSender = lower(receipt.from) === wallet

  // Wallet debits: ERC-20 out of the wallet, native out of the wallet (trace), the top-level value when it sent the tx.
  const directWalletDebits: RhAcquisitionFundingAudit['directWalletDebits'] = [
    ...transfers.filter((t) => t.from === wallet).map((t) => ({ asset: t.token, to: t.to, raw: t.raw.toString(), source: 'erc20_transfer' as const })),
    ...native.filter((t) => t.from === wallet).map((t) => ({ asset: NATIVE_ASSET, to: t.to, raw: t.raw.toString(), source: 'native_trace' as const })),
    ...(isSender && input.txValue != null && input.txValue > ZERO && executor ? [{ asset: NATIVE_ASSET, to: executor, raw: input.txValue.toString(), source: 'tx_value' as const }] : []),
  ]
  const byAsset = new Map<string, bigint>()
  for (const d of directWalletDebits) byAsset.set(d.asset, (byAsset.get(d.asset) ?? ZERO) + BigInt(d.raw))
  // Refunds of a funding asset back to the wallet net it down.
  const refundFlows = [
    ...transfers.filter((t) => t.to === wallet && byAsset.has(t.token)).map((t) => ({ asset: t.token, from: t.from, raw: t.raw.toString() })),
    ...native.filter((t) => t.to === wallet && byAsset.has(NATIVE_ASSET)).map((t) => ({ asset: NATIVE_ASSET, from: t.from, raw: t.raw.toString() })),
  ]
  for (const r of refundFlows) byAsset.set(r.asset, (byAsset.get(r.asset) ?? ZERO) - BigInt(r.raw))
  const funding = [...byAsset].filter(([, v]) => v > ZERO)

  const executorFundingSources = executor ? [
    ...transfers.filter((t) => t.to === executor).map((t) => ({ asset: t.token, from: t.from, raw: t.raw.toString() })),
    ...native.filter((t) => t.to === executor).map((t) => ({ asset: NATIVE_ASSET, from: t.from, raw: t.raw.toString() })),
    ...(input.txValue != null && input.txValue > ZERO ? [{ asset: NATIVE_ASSET, from: lower(receipt.from), raw: input.txValue.toString() }] : []),
  ] : []

  // Existing competing-payer rule (relayed verdict): any non-wallet address with a NET native debit, other than the
  // PoolManager / WETH / swap venues.
  const venues = new Set(receipt.logs.map((l) => lower(l.address)))
  const net = new Map<string, bigint>()
  for (const t of native) { net.set(t.from, (net.get(t.from) ?? ZERO) - t.raw); net.set(t.to, (net.get(t.to) ?? ZERO) + t.raw) }
  if (input.txValue != null && input.txValue > ZERO && executor) { net.set(lower(receipt.from), (net.get(lower(receipt.from)) ?? ZERO) - input.txValue); net.set(executor, (net.get(executor) ?? ZERO) + input.txValue) }
  const competingNative = [...net].filter(([a, v]) => v < ZERO && a !== wallet && a !== pm && a !== weth && !venues.has(a)).map(([a, v]) => ({ asset: NATIVE_ASSET, from: a, raw: (-v).toString() }))

  // The unchanged analyzer, with the wallet's exact trace-derived native leg (diagnostic re-read only).
  const nativeEvidence = deriveRhNativeEvidence({
    wallet, isSender, gasPaid: ZERO, txValue: input.txValue, balanceBefore: null, balanceAfter: null, nonceBefore: null, nonceAfter: null,
    trace: input.trace, txFrom: lower(receipt.from), txTo: executor,
  })
  const m: RobinhoodMixedRouteForensics = analyzeRobinhoodMixedRoute({ wallet, txHash: input.txHash, receipt, poolManager: pm, v4PoolKeys: input.v4PoolKeys, native: nativeEvidence, relayed: !isSender })
  const g = robinhoodMixedRouteGraph({ wallet, receipt, poolManager: pm, forensics: m })
  const competingFundingSources = [...competingNative, ...m.outsideFundingFlows.map((o) => ({ asset: o.token, from: o.from, raw: o.raw }))]
  const targetCredit = transfers.filter((t) => t.token === target && t.to === wallet).reduce((s, t) => s + t.raw, ZERO)
    - transfers.filter((t) => t.token === target && t.from === wallet).reduce((s, t) => s + t.raw, ZERO)

  const proven = m.finalClassification === 'direct_mixed_route_proven' && m.walletOutputToken === target
  const fundingPathReason = input.trace == null ? 'no_complete_native_trace'
    : targetCredit <= ZERO ? 'target_token_not_credited_to_wallet'
    : funding.length === 0 ? 'no_wallet_funding_asset: the wallet paid nothing in this tx (no ERC-20 out, no traced native out, no top-level value) — it only received the output'
    : competingNative.length > 0 ? `competing_native_payers:${competingNative.map((c) => c.from).join(',')}`
    : proven ? `proven: ${m.reason}`
    : `funding_not_connected_to_target: ${m.finalClassification}: ${m.reason}`
  const fundingToOutputPathProven = proven && competingNative.length === 0 && funding.length > 0
  return {
    txHash: input.txHash, wallet, targetToken: target, txFrom: lower(receipt.from), executor, traceComplete: input.trace != null,
    topLevelTxValueRaw: input.txValue?.toString() ?? null,
    walletFundingAssets: funding.map(([a]) => a),
    walletFundingRawByAsset: Object.fromEntries(funding.map(([a, v]) => [a, v.toString()])),
    directWalletDebits, executorFundingSources, competingFundingSources, refundFlows,
    targetTokenCreditRaw: targetCredit.toString(),
    connectedSwapActions: g.connectedActions, independentSwapActions: g.independentActions,
    routeClassification: m.finalClassification, routeReason: m.reason,
    fundingToOutputPathProven,
    fundingPathReason,
    // Existing semantics also need the top-level value to be known for a relayed tx (never assumed zero).
    safePromotionPossible: fundingToOutputPathProven && (isSender || input.txValue != null),
  }
}
