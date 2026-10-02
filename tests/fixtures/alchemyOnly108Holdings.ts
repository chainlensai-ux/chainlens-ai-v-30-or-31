// tests/fixtures/alchemyOnly108Holdings.ts — the production shape behind "103 eligible / 0 selected / 0 priced".
//
// GoldRush balances_v2 failed (transient http_503), so every current holding came from Alchemy's
// alchemy_getTokenBalances: no symbol ('?'), no price, and decimals ASSUMED 18 (src/modules/holdings/utils.ts).
// 108 holdings on Base:
//   - 2 canonical stablecoins (USDC, USDbC — real 6 decimals). With the assumed 18 decimals their
//     quantity collapses below the dust floor, so they were skipped as "dust" before any lookup.
//   - 3 tiny-raw spam rows (raw 1000 / 5000 / 70000) — also below the floor.
//   - 3 genuine tokens whose ONLY price source is the DexScreener fallback (one with real 9 decimals).
//   - 60 one-unit airdrop rows (raw exactly 1e18) and 40 round-number airdrop rows (1e3..1e6 units).
// Pure data — no I/O.

import type { ChainHolding } from '@/lib/engine/modules/holdings/types'

export const BASE_CHAIN_ID = 8453
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const BASE_USDBC = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'

/** Genuine holdings with a real DexScreener market (price per WHOLE token, real decimals). */
export const REAL_FALLBACK_TOKENS = [
  { address: '0x7a1f3c09be3b5c1e0d8f2a4b6c9e1d3f5a7b9c01', raw: '4213557912083344519021', realDecimals: 18, priceUsd: 0.8312 },
  { address: '0x1b2c3d4e5f60718293a4b5c6d7e8f90112233445', raw: '5000123456789', realDecimals: 9, priceUsd: 0.0421 },
  { address: '0x9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807', raw: '87361902211940018833', realDecimals: 18, priceUsd: 12.37 },
] as const

/** Every DexScreener price this fixture's market knows (by lowercase address). */
export const FIXTURE_DEXSCREENER_PRICES: Record<string, number> = {
  [BASE_USDC]: 1.0001,
  [BASE_USDBC]: 0.9998,
  ...Object.fromEntries(REAL_FALLBACK_TOKENS.map((t) => [t.address, t.priceUsd])),
}

/** Real on-chain decimals (what an RPC decimals() read returns). */
export const FIXTURE_ONCHAIN_DECIMALS: Record<string, number> = {
  [BASE_USDC]: 6,
  [BASE_USDBC]: 6,
  ...Object.fromEntries(REAL_FALLBACK_TOKENS.map((t) => [t.address, t.realDecimals])),
}

function addr(prefix: string, i: number): string {
  return `0x${prefix}${i.toString(16).padStart(40 - prefix.length, '0')}`
}

/** An Alchemy-only row: symbol '?', decimals assumed 18, no price, no activity. */
function alchemyRow(tokenAddress: string, raw: string): ChainHolding {
  return {
    chainId: BASE_CHAIN_ID,
    tokenAddress,
    symbol: '?',
    decimals: 18,
    quantity: String(Number(raw) / 1e18),
    lastActivityAt: null,
    classification: 'other',
    providerPriceUsd: null,
    providerValueUsd: null,
    amountRaw: raw,
    decimalsVerified: false,
    metadataSource: 'alchemy',
  } as ChainHolding
}

export function buildAlchemyOnly108Holdings(): ChainHolding[] {
  const rows: ChainHolding[] = [
    alchemyRow(BASE_USDC, '1250000000'), // 1,250 USDC
    alchemyRow(BASE_USDBC, '310500000'), // 310.5 USDbC
    alchemyRow(addr('dd', 1), '1000'),
    alchemyRow(addr('dd', 2), '5000'),
    alchemyRow(addr('dd', 3), '70000'),
    ...REAL_FALLBACK_TOKENS.map((t) => alchemyRow(t.address, t.raw)),
  ]
  // Lexicographically EARLIER addresses than the real tokens, so an address-order tiebreak alone
  // would always pick spam first.
  for (let i = 0; i < 60; i += 1) rows.push(alchemyRow(addr('00a', i), '1000000000000000000'))
  for (let i = 0; i < 40; i += 1) rows.push(alchemyRow(addr('00b', i), `${10 ** (3 + (i % 4))}000000000000000000`))
  return rows
}

/** A DexScreener-shaped price function over this fixture's market (exact address only). */
export function fixturePriceFn(calls: string[] = []): (chainId: number, tokenAddress: string) => Promise<number | null> {
  return async (chainId, tokenAddress) => {
    calls.push(`${chainId}:${tokenAddress.toLowerCase()}`)
    if (chainId !== BASE_CHAIN_ID) return null
    return FIXTURE_DEXSCREENER_PRICES[tokenAddress.toLowerCase()] ?? null
  }
}

export async function fixtureDecimalsFn(_chainId: number, tokenAddress: string): Promise<number | null> {
  return FIXTURE_ONCHAIN_DECIMALS[tokenAddress.toLowerCase()] ?? null
}
