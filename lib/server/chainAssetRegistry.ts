// lib/server/chainAssetRegistry.ts — per-chain registry of the assets a pool's OTHER side may be priced
// by without a further hop: the native gas asset, its canonical wrapped-native token and verified USD
// stablecoins. Chain-specific by construction: an address is only ever looked up under its own chain,
// and a symbol ("WETH", "USDC") is never evidence of anything.
//
// Evidence per entry (never from memory):
//  - base / eth / bnb wrapped natives + stables and their decimals: lib/server/walletSnapshot.ts
//    (WRAPPED_NATIVE_CONTRACT_BY_CHAIN, STABLE_DECIMALS), the values the V4 reader already used.
//  - robinhood (4663): native gas asset ETH (lib/server/robinhoodChainConfig.ts).
//    Wrapped native WETH 0x0bd7d308f8e1639fab988df18a8011f41eacad73 — statically verified by Uniswap's
//    official deployment metadata for chain 4663 (github.com/Uniswap/contracts deployments/4663.md, the
//    same file lib/server/lpProof.ts takes the Robinhood NPM / PoolManager / PositionManager from): it is
//    the `_WETH9` / `_weth9` / `_wrappedNative` constructor argument of NonfungiblePositionManager
//    0x73991a25…, V4 PositionManager 0x58daec31…, SwapRouter02 0xcaf681a6…, QuoterV2 0x33e885ed… and
//    the `weth9` of UniversalRouter 0x248a454a…'s deployment config. The same address is the WETH the
//    repo's live Robinhood trading simulation already wraps ETH into (ROBINHOOD_SIM_WETH, with that same
//    SwapRouter02 and V2 router). Decimals 18: WETH9 mints one raw unit per wei deposited.
//    USD stables: none. No USDC/USDT/other stable contract for chain 4663 appears in that metadata or in
//    this repo, so none is priced at $1; such tokens take the independent one-hop lane.

export const NATIVE_ASSET = '0x0000000000000000000000000000000000000000'

export type RegistryAsset = { address: string; symbol: string; decimals: number; source: string }

export type ChainAssetRegistry = {
  chain: 'base' | 'eth' | 'bnb' | 'robinhood'
  chainId: number
  native: { address: string; symbol: 'ETH' | 'BNB'; decimals: 18; coinId: 'ethereum' | 'binancecoin' }
  /** Statically verified canonical wrapped native (exact address + decimals + evidence). */
  wrappedNative: RegistryAsset | null
  verifiedUsdStables: ReadonlyArray<RegistryAsset>
  /**
   * How the independent quote lane ranks anchored pools: 'liquidity' (the most liquid anchored pool,
   * unchanged behavior) or 'wrapped_native_first' (quote/WETH before quote/stable, then liquidity).
   */
  anchorPriority: 'liquidity' | 'wrapped_native_first'
}

const WALLET_SNAPSHOT = 'lib/server/walletSnapshot.ts (WRAPPED_NATIVE_CONTRACT_BY_CHAIN / STABLE_DECIMALS)'
export const ROBINHOOD_WETH_EVIDENCE = 'Uniswap deployments/4663.md: _WETH9 of NonfungiblePositionManager 0x73991a25…, PositionManager 0x58daec31…, SwapRouter02 0xcaf681a6…, QuoterV2 0x33e885ed…; weth9 of UniversalRouter 0x248a454a…'

export const CHAIN_ASSET_REGISTRY: Readonly<Record<string, ChainAssetRegistry>> = {
  base: {
    chain: 'base',
    chainId: 8453,
    native: { address: NATIVE_ASSET, symbol: 'ETH', decimals: 18, coinId: 'ethereum' },
    wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, source: WALLET_SNAPSHOT },
    verifiedUsdStables: [
      { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, source: WALLET_SNAPSHOT },
      { address: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', symbol: 'USDbC', decimals: 6, source: WALLET_SNAPSHOT },
    ],
    anchorPriority: 'liquidity',
  },
  eth: {
    chain: 'eth',
    chainId: 1,
    native: { address: NATIVE_ASSET, symbol: 'ETH', decimals: 18, coinId: 'ethereum' },
    wrappedNative: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18, source: WALLET_SNAPSHOT },
    verifiedUsdStables: [
      { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, source: WALLET_SNAPSHOT },
      { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6, source: WALLET_SNAPSHOT },
    ],
    anchorPriority: 'liquidity',
  },
  bnb: {
    chain: 'bnb',
    chainId: 56,
    native: { address: NATIVE_ASSET, symbol: 'BNB', decimals: 18, coinId: 'binancecoin' },
    wrappedNative: { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18, source: WALLET_SNAPSHOT },
    verifiedUsdStables: [
      { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18, source: WALLET_SNAPSHOT },
      { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18, source: WALLET_SNAPSHOT },
    ],
    anchorPriority: 'liquidity',
  },
  robinhood: {
    chain: 'robinhood',
    chainId: 4663,
    native: { address: NATIVE_ASSET, symbol: 'ETH', decimals: 18, coinId: 'ethereum' },
    wrappedNative: { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', symbol: 'WETH', decimals: 18, source: ROBINHOOD_WETH_EVIDENCE },
    verifiedUsdStables: [],
    // A new chain with no verified stable: WETH is the only anchor; the rule is explicit for when one is added.
    anchorPriority: 'wrapped_native_first',
  },
}

/** Native + statically verified wrapped native -> decimals (priced by the chain's native USD series). */
export function staticNativeLike(chain: string): Record<string, number> {
  const reg = CHAIN_ASSET_REGISTRY[chain]
  if (!reg) return {}
  const out: Record<string, number> = { [reg.native.address]: reg.native.decimals }
  if (reg.wrappedNative) out[reg.wrappedNative.address] = reg.wrappedNative.decimals
  return out
}

export function verifiedUsdStableDecimals(chain: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of CHAIN_ASSET_REGISTRY[chain]?.verifiedUsdStables ?? []) out[s.address] = s.decimals
  return out
}

/**
 * Anchors an ordinary (ERC-20 only) pool can actually pair with: the wrapped native and the verified
 * stables. Native 0x0 is never an ERC-20 pool token, so it is deliberately not an anchor here.
 */
export function normalPoolAnchors(chain: string): string[] {
  const reg = CHAIN_ASSET_REGISTRY[chain]
  if (!reg) return []
  return [...(reg.wrappedNative ? [reg.wrappedNative.address] : []), ...reg.verifiedUsdStables.map((s) => s.address)]
}

/** Debug view of the chain's wrapped native (candidate, proof mode, source, status). */
export function wrappedNativeDebug(chain: string): { address: string; proof: 'static'; source: string; status: 'verified' } | null {
  const w = CHAIN_ASSET_REGISTRY[chain]?.wrappedNative
  return w ? { address: w.address, proof: 'static', source: w.source, status: 'verified' } : null
}

// ── Classification ───────────────────────────────────────────────────────────────────────────────
export type QuoteClassification = 'native' | 'verified_wrapped_native' | 'verified_stable' | 'arbitrary_quote' | 'unverified'

/** Exact-address classification on exactly this chain ('unverified' only for an unregistered chain). */
export function classifyQuoteAsset(chain: string, address: string): QuoteClassification {
  const reg = CHAIN_ASSET_REGISTRY[chain]
  const a = address.toLowerCase()
  if (!reg) return 'unverified'
  if (a === reg.native.address) return 'native'
  if (reg.wrappedNative?.address === a) return 'verified_wrapped_native'
  if (reg.verifiedUsdStables.some((s) => s.address === a)) return 'verified_stable'
  return 'arbitrary_quote'
}
