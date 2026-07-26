// MODULE — quoteLegPricing
//
// Pure, deterministic derivation of a token's historical USD price from a verified quote leg
// (stablecoin or native ETH/WETH) transferred in the SAME transaction as the target leg. Never
// makes a network/provider call, never fabricates a price, never touches FIFO/PnL/recovery.
//
// DATA-MODEL NOTE, DISCLOSED: NormalizedEvent (src/modules/normalization/types.ts) has no swap-type
// classification (swap vs. transfer vs. airdrop/mint/burn/bridge) and no real log index. Exclusion of
// non-swap events is therefore delegated to the caller via SwapLeg.excludeReason (set by whatever
// upstream classification already exists — e.g. router-refund/gas-transfer detection); this module
// treats any leg carrying excludeReason as if it were never present. logIndex is the leg's position
// within its own transaction's leg group, assigned deterministically by the caller (or by
// groupSwapLegsByTransaction below) from stable per-provider ordering — used only as a tie-break.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { NormalizedEvent } from '../normalization/types'

export type SwapLegDirection = 'inbound' | 'outbound' | 'unknown'

export type SwapLeg = {
  contract: string
  symbol: string
  decimals: number
  amount: number
  direction: SwapLegDirection
  logIndex: number
  // Set by the caller when an upstream check has already identified this leg as NOT a genuine swap
  // quote candidate (router refund, gas transfer, airdrop, mint, burn, bridge, unrelated transfer).
  // A leg with this set is filtered out before quote-leg selection — never chosen, never counted.
  excludeReason?: string | null
}

export type QuoteLegSource = 'same_tx_stable_quote' | 'same_tx_native_quote'

export type QuoteLegEvidence = {
  chain: SupportedChain
  txHash: string
  timestamp: number
  targetToken: string
  quoteToken: string | null
  targetDecimals: number | null
  quoteDecimals: number | null
  independentQuoteLeg: boolean
  rejectionReason: string | null
}

export type QuoteLegPriceSuccess = {
  priceUsd: number
  source: QuoteLegSource
  quoteToken: string
  quoteQuantity: number
  quoteValueUsd: number
  confidence: 'verified'
  evidence: QuoteLegEvidence
}

export type QuoteLegPriceFailure = {
  priceUsd: null
  source: null
  quoteToken: null
  quoteQuantity: null
  quoteValueUsd: null
  confidence: null
  evidence: QuoteLegEvidence
}

export type QuoteLegPriceResult = QuoteLegPriceSuccess | QuoteLegPriceFailure

export type DeriveSameTransactionQuotePriceParams = {
  chain: SupportedChain
  txHash: string
  timestamp: number
  targetToken: string
  targetDirection: SwapLegDirection
  targetQuantity: number
  groupedSwapLegs: SwapLeg[]
  // Verified per-unit historical native (ETH) USD price at `timestamp`. Must come from an
  // independently verified source (this module never resolves it itself) — required only when a
  // native/WETH quote leg is the best/only candidate.
  historicalNativePrice: number | null
}

// Canonical verified stablecoin registry — address-based (never symbol-only, per this module's
// requirement), lowercase-keyed. Chains without an entry simply never match a stablecoin quote leg.
const STABLECOIN_ADDRESSES: Partial<Record<SupportedChain, Record<string, string>>> = {
  eth: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  },
  base: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDBC',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
  },
  arbitrum: {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC',
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'DAI',
  },
}

// Canonical native-wrapper (WETH) addresses per chain — never inferred from symbol text alone.
const CANONICAL_WETH_ADDRESSES: Partial<Record<SupportedChain, Set<string>>> = {
  eth: new Set(['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']),
  base: new Set(['0x4200000000000000000000000000000000000006']),
  arbitrum: new Set(['0x82af49447d8a07e3bd95bd0d56f35241523fbab1']),
}

function isFinitePositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function stablecoinSymbolFor(chain: SupportedChain, contract: string): string | null {
  const map = STABLECOIN_ADDRESSES[chain]
  if (!map) return null
  return map[contract.toLowerCase()] ?? null
}

// Native ETH transfers carry no ERC20 contract to verify against a registry — matched by symbol
// only for the native asset itself. WETH, being an ERC20, is verified strictly by canonical address.
function isNativeOrCanonicalWeth(chain: SupportedChain, leg: SwapLeg): boolean {
  if (leg.symbol === 'ETH') return true
  if (leg.symbol !== 'WETH') return false
  const set = CANONICAL_WETH_ADDRESSES[chain]
  return set ? set.has(leg.contract.toLowerCase()) : false
}

function failure(params: DeriveSameTransactionQuotePriceParams, reason: string, targetDecimals: number | null): QuoteLegPriceFailure {
  return {
    priceUsd: null,
    source: null,
    quoteToken: null,
    quoteQuantity: null,
    quoteValueUsd: null,
    confidence: null,
    evidence: {
      chain: params.chain,
      txHash: params.txHash,
      timestamp: params.timestamp,
      targetToken: params.targetToken,
      quoteToken: null,
      targetDecimals,
      quoteDecimals: null,
      independentQuoteLeg: false,
      rejectionReason: reason,
    },
  }
}

function tieBreakSort(legs: SwapLeg[]): SwapLeg[] {
  // absolute quote value DESC (by raw amount here — USD valuation is applied by the caller before
  // comparing stablecoin vs. native candidates; within one candidate class, amount ordering and
  // USD-value ordering agree since both use the same per-unit conversion) → logIndex ASC → token
  // address ASC.
  return [...legs].sort((a, b) => {
    if (b.amount !== a.amount) return b.amount - a.amount
    if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex
    return a.contract.toLowerCase().localeCompare(b.contract.toLowerCase())
  })
}

export function deriveSameTransactionQuotePrice(
  params: DeriveSameTransactionQuotePriceParams,
): QuoteLegPriceResult {
  const { chain, txHash, timestamp, targetToken, targetDirection, targetQuantity, groupedSwapLegs, historicalNativePrice } = params

  const targetLeg = groupedSwapLegs.find(
    (leg) => leg.contract.toLowerCase() === targetToken.toLowerCase() && leg.direction === targetDirection,
  )
  const targetDecimals = targetLeg && Number.isFinite(targetLeg.decimals) ? targetLeg.decimals : null

  if (!isFinitePositive(targetQuantity)) return failure(params, 'invalid_target_quantity', targetDecimals)

  // Dedupe legs (same contract + direction + logIndex) before selecting a quote — a duplicated
  // provider record must never be double-counted as two independent quote legs.
  const seen = new Set<string>()
  const legs = groupedSwapLegs.filter((leg) => {
    if (leg.excludeReason) return false
    const key = `${leg.contract.toLowerCase()}:${leg.direction}:${leg.logIndex}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // NOT-SAME-DIRECTION MATCH, DISCLOSED (confirmed production root cause — see
  // src/modules/normalization/index.ts's classifyDirection: a leg whose from/to never touches the
  // scanned wallet directly — e.g. a router-to-pool WETH transfer inside a native-ETH-funded swap,
  // where the wallet only ever sent native ETH to the router — is honestly classified 'unknown', not
  // forced into 'inbound'/'outbound'. The previous `leg.direction === oppositeDirection` check only
  // ever matched a leg that ALSO independently touched the wallet, so every swap whose quote leg was
  // pool-side (the overwhelming majority — most DEX pairs are token/WETH, not token/USDC, and most
  // swaps route native ETH through a router rather than pre-wrapped WETH) produced zero candidates:
  // "no_opposite_leg_in_transaction" even though the quote leg was genuinely present in `merged`.
  // Matching on "not the same direction as the target" (which a same-tx swap's other leg can never
  // be, whether 'outbound'/'inbound' from the wallet's own perspective or 'unknown' from a pool's)
  // recovers exactly this case while still rejecting a genuine same-direction leg (two separate
  // inbound transfers in one tx, e.g. an airdrop alongside a swap) as required.
  const candidateLegs = legs.filter(
    (leg) =>
      leg.direction !== targetDirection &&
      leg.contract.toLowerCase() !== targetToken.toLowerCase() &&
      isFinitePositive(leg.amount) &&
      Number.isFinite(leg.decimals) &&
      leg.decimals >= 0,
  )

  if (candidateLegs.length === 0) return failure(params, 'no_opposite_leg_in_transaction', targetDecimals)

  // Stablecoin has priority over native/WETH.
  const stableCandidates = candidateLegs.filter((leg) => stablecoinSymbolFor(chain, leg.contract) !== null)
  if (stableCandidates.length > 0) {
    const chosen = tieBreakSort(stableCandidates)[0]
    const quoteQuantity = chosen.amount
    const quoteValueUsd = quoteQuantity // 1 verified stablecoin unit == $1, by definition
    const priceUsd = quoteValueUsd / targetQuantity
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return failure(params, 'non_finite_derived_price', targetDecimals)
    return {
      priceUsd,
      source: 'same_tx_stable_quote',
      quoteToken: chosen.contract,
      quoteQuantity,
      quoteValueUsd,
      confidence: 'verified',
      evidence: {
        chain,
        txHash,
        timestamp,
        targetToken,
        quoteToken: chosen.contract,
        targetDecimals,
        quoteDecimals: chosen.decimals,
        independentQuoteLeg: true,
        rejectionReason: null,
      },
    }
  }

  const nativeCandidates = candidateLegs.filter((leg) => isNativeOrCanonicalWeth(chain, leg))
  if (nativeCandidates.length > 0) {
    if (!isFinitePositive(historicalNativePrice)) return failure(params, 'missing_verified_native_price', targetDecimals)
    const chosen = tieBreakSort(nativeCandidates)[0]
    const quoteQuantity = chosen.amount
    const quoteValueUsd = quoteQuantity * historicalNativePrice
    const priceUsd = quoteValueUsd / targetQuantity
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return failure(params, 'non_finite_derived_price', targetDecimals)
    return {
      priceUsd,
      source: 'same_tx_native_quote',
      quoteToken: chosen.contract,
      quoteQuantity,
      quoteValueUsd,
      confidence: 'verified',
      evidence: {
        chain,
        txHash,
        timestamp,
        targetToken,
        quoteToken: chosen.contract,
        targetDecimals,
        quoteDecimals: chosen.decimals,
        independentQuoteLeg: true,
        rejectionReason: null,
      },
    }
  }

  return failure(params, 'no_verified_quote_leg_found', targetDecimals)
}

// Groups NormalizedEvents into per-(chain,txHash) swap-leg lists. Deterministic logIndex assigned
// by stable input order (the merged event array's own order — already deterministic upstream).
// Never combines legs from separate transactions: the map key is the full (chain,txHash) pair.
export function groupSwapLegsByTransaction(events: readonly NormalizedEvent[]): Map<string, SwapLeg[]> {
  const groups = new Map<string, SwapLeg[]>()
  for (const event of events) {
    const key = `${event.chain}:${event.txHash.toLowerCase()}`
    const list = groups.get(key) ?? []
    list.push({
      contract: event.contract,
      symbol: event.symbol,
      decimals: event.tokenDecimals,
      amount: event.amount,
      direction: event.direction,
      logIndex: list.length,
    })
    groups.set(key, list)
  }
  return groups
}

export function swapLegGroupKey(chain: SupportedChain, txHash: string): string {
  return `${chain}:${txHash.toLowerCase()}`
}

// Diagnostic helper — true when `contract` is a verified stablecoin or canonical WETH address on
// `chain`, or the native-asset symbol itself. Exported so callers can report "how many transactions
// even contain a verified quote asset" without duplicating the address registries above.
export function isVerifiedQuoteLegAddress(chain: SupportedChain, contract: string, symbol: string): boolean {
  if (symbol === 'ETH') return true
  if (stablecoinSymbolFor(chain, contract) !== null) return true
  const set = CANONICAL_WETH_ADDRESSES[chain]
  return set ? set.has(contract.toLowerCase()) : false
}
