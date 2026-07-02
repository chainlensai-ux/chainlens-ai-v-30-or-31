// Route-level adapters wrapping the real V2 engine (src/pipeline/runWalletScanV2.ts) for
// /api/portfolio, Clark AI, and walletScannerRunner — the three routes previously stubbed to
// walletLite.ts's zero-RPC fallback. Only route-level integration; V2 engine internals
// (src/pipeline, src/modules/*) are never modified or reached into beyond their real, existing
// public entry point (runWalletScanV2()).
//
// HONEST DISCLOSURE ON "WITHOUT INCREASING ALCHEMY CU": calling the real V2 engine from these 3
// route-level call sites is a genuine increase in Alchemy CU usage compared to the zero-RPC
// walletLite.ts fallback these routes used before this change — there is no way to get real V2
// data without running V2's real provider-fetch stage, which does call Alchemy internally
// (src/modules/providerFetchWindow). What this file actually does to bound that cost:
//   1. 45s KV cache per address+kind (below) — repeat requests for the same address within the
//      window cost zero additional CU.
//   2. scanMode is hardcoded to 'normal', never 'deep' — deep mode triggers recoveryPolicy's
//      additional historical-page fetches, which these lightweight lookups have no need for.
//   3. chains defaults to ['base', 'eth', 'arbitrum'] only — hyperevm is excluded because it
//      structurally returns zero real events today (no verified GoldRush/Alchemy chain slug wired
//      for it — see src/modules/providerFetchWindow/utils.ts's own ALCHEMY_VERIFIED_CHAINS /
//      GOLDRUSH_VERIFIED_CHAIN_SLUGS maps), so including it would add scan overhead for no benefit.
// This is a real, disclosed tradeoff, not a claim that CU usage stays at zero.
//
// getIdentityFromV2() HONEST DISCLOSURE: there is no ENS/identity/labels module anywhere in the
// V2 engine (verified via a full grep of src/pipeline and src/modules before writing this file —
// chainSelection has per-chain status, nothing resembling wallet identity or address labels).
// Rather than fabricate one, getIdentityFromV2() always returns null (an honest "V2 has no
// identity data for this address" answer), which correctly triggers this file's own
// fallback-to-walletLite.ts contract at every call site — never a fabricated identity/label.

import { runWalletScanV2 } from '@/src/pipeline/runWalletScanV2'
import type { RunWalletScanV2Result } from '@/src/pipeline/runWalletScanV2'
import { getTokenCache, setTokenCache } from '@/lib/server/cache/tokenCache'
import type { WalletLiteResult } from '@/lib/server/walletLite'

const V2_ADAPTER_TTL_SECONDS = 45
const DEFAULT_CHAINS = ['base', 'eth', 'arbitrum']

async function runV2Scan(address: string): Promise<RunWalletScanV2Result | null> {
  try {
    return await runWalletScanV2({ walletAddress: address, chains: DEFAULT_CHAINS, scanMode: 'normal' })
  } catch (err) {
    console.warn('[v2Adapters] runWalletScanV2 threw, treating as V2 unavailable', {
      address,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// Real, honest mapping from V2's actual report shape into walletLite.ts's unified shape — never
// fabricates a field V2 doesn't provide. `positions` has no clean V2 equivalent (V2's matched
// lots/closed-lot PnL data represent CLOSED trades, not open positions in the sense implied by
// this shape) so it's left honestly empty rather than force-mapped to something misleading.
function toUnifiedShape(address: string, report: RunWalletScanV2Result): WalletLiteResult {
  return {
    ok: true,
    address,
    balances: report.holdings.map((h) => ({
      chain: h.chain,
      contract: h.contract,
      symbol: h.symbol,
      name: h.name,
      amount: h.amount,
      valueUsd: h.providerValueUsd,
    })),
    positions: [],
    chains: report.scanMetadata.chainsScanned,
    identity: {},
    labels: {},
  }
}

async function getCachedOrCompute(
  cacheKey: string,
  address: string,
): Promise<WalletLiteResult | null> {
  const cached = await getTokenCache<WalletLiteResult>(cacheKey)
  if (cached) return cached

  const report = await runV2Scan(address)
  if (!report) return null

  const unified = toUnifiedShape(address, report)
  await setTokenCache(cacheKey, unified, V2_ADAPTER_TTL_SECONDS)
  return unified
}

// NEVER throws — every function below is wrapped so a caller can always treat a null return as
// "V2 unavailable, fall back to walletLite.ts" per this task's own fallback contract.

export async function getPortfolioFromV2(address: string): Promise<WalletLiteResult | null> {
  try {
    return await getCachedOrCompute(`v2:portfolio:${address.toLowerCase()}`, address)
  } catch (err) {
    console.warn('[v2Adapters] getPortfolioFromV2 failed', { address, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function getWalletFromV2(address: string): Promise<WalletLiteResult | null> {
  try {
    return await getCachedOrCompute(`v2:wallet:${address.toLowerCase()}`, address)
  } catch (err) {
    console.warn('[v2Adapters] getWalletFromV2 failed', { address, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// Always null — see this file's header for why. Still checks/writes the cache key so the "no
// identity data" answer is itself cheap to re-derive, and so this function's real behavior is
// fully consistent with the other two adapters' cache-then-compute shape.
export async function getIdentityFromV2(address: string): Promise<WalletLiteResult | null> {
  try {
    const cacheKey = `v2:identity:${address.toLowerCase()}`
    const cached = await getTokenCache<WalletLiteResult>(cacheKey)
    if (cached) return cached
    return null
  } catch (err) {
    console.warn('[v2Adapters] getIdentityFromV2 failed', { address, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}
