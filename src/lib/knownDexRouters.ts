// SHARED VERIFIED ROUTER REGISTRY, DISCLOSED (Wallet Scanner audit — Priority 1, "highest
// priority": router coverage was split across at least four independent, drifting copies —
// lib/server/walletSnapshot.ts's own KNOWN_DEX_ROUTERS + EXTENDED_DEX_ROUTERS (the fullest,
// best-verified set), src/modules/swapNormalizer/routers.ts's chain-scoped ROUTER_REGISTRY (missing
// Uniswap Universal Router, 1inch, 0x, Paraswap, Permit2, LI.FI, AlienBase, Virtuals, Balancer,
// Curve), and src/pipeline/index.ts's own literal "KNOWN_DEX_ROUTER_ADDRESSES" copy (a manually
// re-typed subset, itself missing SwapRouter02 — see that file's own header disclosing exactly why
// it couldn't reuse swapNormalizer's shape). A tx to a real, verified router absent from whichever
// copy a given call site happened to consult resolved as an unknown counterparty there even though
// another call site in the SAME scan correctly recognized it.
//
// NO NEW ADDRESSES: every entry below is copied byte-for-byte from an existing, already-verified
// entry in walletSnapshot.ts's KNOWN_DEX_ROUTERS/EXTENDED_DEX_ROUTERS (that file's own header
// disclosures — SwapRouter02's multi-chain deterministic deployment, Permit2's canonical singleton
// deployment, LI.FI Diamond's proxy address, etc. — carry over unchanged) or swapNormalizer's own
// ROUTER_REGISTRY (SwapRouter02). Odos/Bebop/CoW and any other unverified router are deliberately
// still absent — walletSnapshot.ts's own policy (see docs/audit-router-swap-candidates-0xe896.md)
// is never to add a router address without independent on-chain verification; that policy is
// unchanged here, only consolidated into one place.
//
// This module is the SINGLE source of truth going forward. Consumers with a different required
// SHAPE (swapNormalizer's per-chain RouterType map, walletSnapshot's labeled
// Record<string,string>, pipeline's flat Set<string>) derive their own shape from this module's
// exports rather than keeping a second hand-maintained address list.

export type KnownDexRouterProtocol =
  | 'UniswapV2Router'
  | 'UniswapV3Router'
  | 'UniswapV3SwapRouter02'
  | 'UniswapUniversalRouter_ETH'
  | 'UniswapUniversalRouter_ETH_CommandRouter'
  | 'UniswapUniversalRouter_Base'
  | 'OneInchRouter'
  | 'OneInchRouterV5'
  | 'OneInchRouterV6'
  | 'ZeroExExchangeProxy'
  | 'ZeroExSettler'
  | 'Paraswap'
  | 'ParaswapV6'
  | 'SushiSwapRouter'
  | 'SushiSwapRouteProcessor'
  | 'Aerodrome'
  | 'AerodromeSecondary'
  | 'AerodromeSlipstream'
  | 'BaseSwap'
  | 'AlienBaseRouter'
  | 'AlienBaseV3SmartRouter'
  | 'VirtualsProtocolSellOrderExecutor'
  | 'Balancer'
  | 'Curve'
  | 'CurveSecondary'
  | 'Permit2'
  | 'LiFiDiamond'

// KNOWN_DEX_ROUTERS ∪ EXTENDED_DEX_ROUTERS (lib/server/walletSnapshot.ts) ∪ SwapRouter02
// (src/modules/swapNormalizer/routers.ts — the one verified address present there but absent from
// both of walletSnapshot.ts's own tables). Deduplicated; every address lowercase.
export const KNOWN_DEX_ROUTERS: Readonly<Record<string, KnownDexRouterProtocol>> = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'UniswapV2Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'UniswapV3Router',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'UniswapV3SwapRouter02',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'UniswapUniversalRouter_ETH',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'UniswapUniversalRouter_ETH',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'UniswapUniversalRouter_ETH_CommandRouter',
  '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc': 'UniswapUniversalRouter_Base',
  '0x1111111254fb6c44bac0bed2854e76f90643097d': 'OneInchRouter',
  '0x1111111254eeb25477b68fb85ed929f73a960582': 'OneInchRouterV5',
  '0x111111125421ca6dc452d289314280a0f8842a65': 'OneInchRouterV6',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': 'ZeroExExchangeProxy',
  '0x55dc0e69ec00debcebdc25fe6f7cad62e63c8f81': 'ZeroExSettler',
  '0x216b4b4ba9f3e719726886d34a177484278bfcae': 'Paraswap',
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'ParaswapV6',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwapRouter',
  '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506': 'SushiSwapRouteProcessor',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome',
  '0x6cb442acf35158d68425b2a89f7e7b02fb5e42d5': 'AerodromeSecondary',
  '0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5': 'AerodromeSlipstream',
  '0x327df1e6de05895d2ab08513aadd9313fe505d86': 'BaseSwap',
  '0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7': 'AlienBaseRouter',
  '0xb20c411fc84fbb27e78608c24d0056d974ea9411': 'AlienBaseV3SmartRouter',
  '0xf8dd39c71a278fe9f4377d009d7627ef140f809e': 'VirtualsProtocolSellOrderExecutor',
  '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer',
  '0x99a58482bd75cbab83b27ec03ca68ff489b5788f': 'Curve',
  '0xf0d4c12a5768d806021f80a262b4d39d26c58b8d': 'CurveSecondary',
  '0x000000000022d473030f116ddee9f6b43ac78ba9': 'Permit2',
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae': 'LiFiDiamond',
}

export const KNOWN_DEX_ROUTER_ADDRESSES: ReadonlySet<string> = new Set(Object.keys(KNOWN_DEX_ROUTERS))

export function isKnownDexRouter(address: string | null | undefined): boolean {
  if (!address) return false
  return KNOWN_DEX_ROUTER_ADDRESSES.has(address.toLowerCase())
}

export function knownDexRouterProtocol(address: string | null | undefined): KnownDexRouterProtocol | null {
  if (!address) return null
  return KNOWN_DEX_ROUTERS[address.toLowerCase()] ?? null
}
