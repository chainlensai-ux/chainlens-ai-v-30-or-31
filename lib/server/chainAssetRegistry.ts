// lib/server/chainAssetRegistry.ts — per-chain registry of the assets a pool's OTHER side may be priced
// by without a further hop: the native gas asset, its canonical wrapped-native token and verified USD
// stablecoins. Chain-specific by construction: an address is only ever looked up under its own chain,
// and a symbol ("WETH", "USDC") is never evidence of anything.
//
// Evidence per entry (never from memory):
//  - base / eth / bnb wrapped natives + stables and their decimals: lib/server/walletSnapshot.ts
//    (WRAPPED_NATIVE_CONTRACT_BY_CHAIN, STABLE_DECIMALS), the values the V4 reader already used.
//  - robinhood (4663): native gas asset ETH (lib/server/robinhoodChainConfig.ts).
//    Wrapped native: the repo's candidate ROBINHOOD_SIM_WETH (lib/server/robinhoodHoneypotSimulation.ts,
//    the token the live Robinhood trading simulation wraps ETH into) is accepted ONLY after the chain
//    itself confirms it: WETH9() on the Uniswap V3 NonfungiblePositionManager for chain 4663
//    (0x73991a25…, taken from Uniswap's deployments/4663.md — lib/server/lpProof.ts) must return
//    exactly that address. Until that read succeeds it is 'unverified' and is NOT priced as ETH.
//    Decimals 18: WETH9 mints exactly one raw unit per wei deposited, so its raw amounts are wei.
//    USD stables: none. No USDC/USDT/other stable contract for chain 4663 is recorded anywhere in
//    this repo or in the verified deployment metadata above, so none is priced at $1; such tokens
//    take the independent one-hop lane like any other quote token.

import { ROBINHOOD_SIM_WETH } from './robinhoodHoneypotSimulation.ts'

export const NATIVE_ASSET = '0x0000000000000000000000000000000000000000'
export const WETH9_SELECTOR = '0x4aa4a4fc' // WETH9()

export type RegistryAsset = { address: string; symbol: string; decimals: number; source: string }
export type WrappedNativeEntry =
  | (RegistryAsset & { proof: 'static' })
  | (RegistryAsset & { proof: 'onchain_getter'; verifier: string; verifierSource: string; selector: string })

export type ChainAssetRegistry = {
  chain: 'base' | 'eth' | 'bnb' | 'robinhood'
  chainId: number
  native: { address: string; symbol: 'ETH' | 'BNB'; decimals: 18; coinId: 'ethereum' | 'binancecoin' }
  wrappedNative: WrappedNativeEntry | null
  verifiedUsdStables: ReadonlyArray<RegistryAsset>
}

const WALLET_SNAPSHOT = 'lib/server/walletSnapshot.ts (WRAPPED_NATIVE_CONTRACT_BY_CHAIN / STABLE_DECIMALS)'

export const CHAIN_ASSET_REGISTRY: Readonly<Record<string, ChainAssetRegistry>> = {
  base: {
    chain: 'base',
    chainId: 8453,
    native: { address: NATIVE_ASSET, symbol: 'ETH', decimals: 18, coinId: 'ethereum' },
    wrappedNative: { proof: 'static', address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, source: WALLET_SNAPSHOT },
    verifiedUsdStables: [
      { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, source: WALLET_SNAPSHOT },
      { address: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', symbol: 'USDbC', decimals: 6, source: WALLET_SNAPSHOT },
    ],
  },
  eth: {
    chain: 'eth',
    chainId: 1,
    native: { address: NATIVE_ASSET, symbol: 'ETH', decimals: 18, coinId: 'ethereum' },
    wrappedNative: { proof: 'static', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18, source: WALLET_SNAPSHOT },
    verifiedUsdStables: [
      { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, source: WALLET_SNAPSHOT },
      { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6, source: WALLET_SNAPSHOT },
    ],
  },
  bnb: {
    chain: 'bnb',
    chainId: 56,
    native: { address: NATIVE_ASSET, symbol: 'BNB', decimals: 18, coinId: 'binancecoin' },
    wrappedNative: { proof: 'static', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18, source: WALLET_SNAPSHOT },
    verifiedUsdStables: [
      { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18, source: WALLET_SNAPSHOT },
      { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18, source: WALLET_SNAPSHOT },
    ],
  },
  robinhood: {
    chain: 'robinhood',
    chainId: 4663,
    native: { address: NATIVE_ASSET, symbol: 'ETH', decimals: 18, coinId: 'ethereum' },
    wrappedNative: {
      proof: 'onchain_getter',
      address: ROBINHOOD_SIM_WETH.toLowerCase(),
      symbol: 'WETH',
      decimals: 18,
      source: 'lib/server/robinhoodHoneypotSimulation.ts ROBINHOOD_SIM_WETH',
      verifier: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
      verifierSource: 'Uniswap V3 NonfungiblePositionManager, Uniswap deployments/4663.md (lib/server/lpProof.ts)',
      selector: WETH9_SELECTOR,
    },
    verifiedUsdStables: [],
  },
}

/** Assets usable with no runtime proof: native + a statically verified wrapped native -> decimals. */
export function staticNativeLike(chain: string): Record<string, number> {
  const reg = CHAIN_ASSET_REGISTRY[chain]
  if (!reg) return {}
  const out: Record<string, number> = { [reg.native.address]: reg.native.decimals }
  if (reg.wrappedNative?.proof === 'static') out[reg.wrappedNative.address] = reg.wrappedNative.decimals
  return out
}

export function verifiedUsdStableDecimals(chain: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of CHAIN_ASSET_REGISTRY[chain]?.verifiedUsdStables ?? []) out[s.address] = s.decimals
  return out
}

// ── Runtime proof of an on-chain-verified wrapped native ─────────────────────────────────────────
export type WrappedNativeStatus = 'static' | 'proven' | 'mismatch' | 'rpc_error' | 'budget' | 'none'
export type WrappedNativeProof = { address: string | null; decimals: number | null; status: WrappedNativeStatus; cached: boolean; callsUsed: number }

const PROOF_OK_TTL_MS = 24 * 3_600_000
const PROOF_FAIL_TTL_MS = 60_000
const proofCache = new Map<string, { expiresAt: number; status: 'proven' | 'mismatch' | 'rpc_error' }>()
export function resetChainAssetRegistryCache() { proofCache.clear() }

/**
 * The chain's wrapped native, only when proven: 'static' entries directly; 'onchain_getter' entries
 * after one eth_call to the verified verifier contract returns exactly the registry address (cached
 * 24h per chain; a failed read 60s). `call` is only invoked when `canCall()` allows it.
 */
export async function resolveWrappedNative(
  chain: string,
  call: (to: string, data: string) => Promise<{ result: unknown; error: boolean }>,
  canCall: () => boolean,
  now: () => number = Date.now,
): Promise<WrappedNativeProof> {
  const w = CHAIN_ASSET_REGISTRY[chain]?.wrappedNative ?? null
  if (!w) return { address: null, decimals: null, status: 'none', cached: false, callsUsed: 0 }
  if (w.proof === 'static') return { address: w.address, decimals: w.decimals, status: 'static', cached: false, callsUsed: 0 }
  const hit = proofCache.get(chain)
  if (hit && hit.expiresAt > now()) return { address: hit.status === 'proven' ? w.address : null, decimals: hit.status === 'proven' ? w.decimals : null, status: hit.status, cached: true, callsUsed: 0 }
  if (!canCall()) return { address: null, decimals: null, status: 'budget', cached: false, callsUsed: 0 }
  const res = await call(w.verifier, w.selector)
  const word = typeof res.result === 'string' && /^0x[0-9a-fA-F]{64}$/.test(res.result) ? res.result.toLowerCase() : null
  const status: 'proven' | 'mismatch' | 'rpc_error' = res.error || !word ? 'rpc_error' : `0x${word.slice(-40)}` === w.address && /^0x0{24}$/.test(word.slice(0, 26)) ? 'proven' : 'mismatch'
  if (proofCache.size >= 50) proofCache.delete(proofCache.keys().next().value!)
  proofCache.set(chain, { expiresAt: now() + (status === 'proven' ? PROOF_OK_TTL_MS : PROOF_FAIL_TTL_MS), status })
  return { address: status === 'proven' ? w.address : null, decimals: status === 'proven' ? w.decimals : null, status, cached: false, callsUsed: 1 }
}

// ── Classification ───────────────────────────────────────────────────────────────────────────────
export type QuoteClassification = 'native' | 'verified_wrapped_native' | 'verified_stable' | 'arbitrary_quote' | 'unverified'

/** Exact-address classification on exactly this chain. `provenWrapped` is resolveWrappedNative's address. */
export function classifyQuoteAsset(chain: string, address: string, provenWrapped: string | null): QuoteClassification {
  const reg = CHAIN_ASSET_REGISTRY[chain]
  const a = address.toLowerCase()
  if (!reg) return 'unverified'
  if (a === reg.native.address) return 'native'
  if (reg.verifiedUsdStables.some((s) => s.address === a)) return 'verified_stable'
  if (reg.wrappedNative && reg.wrappedNative.address === a) {
    return reg.wrappedNative.proof === 'static' || provenWrapped === a ? 'verified_wrapped_native' : 'unverified'
  }
  return 'arbitrary_quote'
}
