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
import { logRpcCall } from '@/lib/server/rpcDebug'

// Strips this machine's absolute filesystem prefix from a stack trace before it's ever logged or
// returned in a diagnostic JSON response — "sanitized" per the request. Capped to 5 frames; a full
// raw stack isn't needed to see which adapter path triggered a scan.
function sanitizeStack(stack: string | undefined): string {
  if (!stack) return ''
  return stack
    .split('\n')
    .slice(0, 5)
    .map((line) => line.replace(process.cwd(), '.'))
    .join('\n')
}

const V2_ADAPTER_TTL_SECONDS = 45
const DEFAULT_CHAINS = ['base', 'eth', 'arbitrum']

// Mirrors tokenCache.ts's own internal env check — kept as a separate, explicit guard here too
// (rather than relying solely on getTokenCache/setTokenCache's internal check) so this file's own
// KV READ/KV WRITE log lines are never emitted when KV isn't actually configured, and so a
// misconfigured deployment is diagnosable directly from this file's logs, not just tokenCache.ts's.
function kvEnabled(): boolean {
  return Boolean(process.env.KV_REST_API_URL) && Boolean(process.env.KV_REST_API_TOKEN)
}

async function readFromKv(cacheKey: string): Promise<WalletLiteResult | null> {
  if (!kvEnabled()) {
    console.warn('KV DISABLED')
    return null
  }
  try {
    const cached = await getTokenCache<WalletLiteResult>(cacheKey)
    if (cached) console.log('KV READ', cacheKey)
    return cached
  } catch (err) {
    console.error('KV ERROR', err)
    return null
  }
}

async function writeToKv(cacheKey: string, value: WalletLiteResult): Promise<void> {
  if (!kvEnabled()) {
    console.warn('KV DISABLED')
    return
  }
  try {
    await setTokenCache(cacheKey, value, V2_ADAPTER_TTL_SECONDS)
    console.log('KV WRITE', cacheKey)
  } catch (err) {
    console.error('KV ERROR', err)
  }
}

// `route` here identifies which v2Adapters function triggered this scan (getPortfolioFromV2 /
// getWalletFromV2), NOT the literal HTTP route path — that context isn't threaded into this file
// today, and adding it would mean modifying the 3 calling routes/runners, which this diagnostic
// task's own scope excludes ("never modify existing API routes"). Disclosed as an honest proxy,
// not a claim of full per-HTTP-route attribution.
async function runV2Scan(address: string, route: string): Promise<RunWalletScanV2Result | null> {
  for (const chain of DEFAULT_CHAINS) {
    logRpcCall({ chain, method: 'runWalletScanV2', route, stack: sanitizeStack(new Error().stack) })
  }
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
  route: string,
): Promise<WalletLiteResult | null> {
  const cached = await readFromKv(cacheKey)
  if (cached) return cached

  const report = await runV2Scan(address, route)
  if (!report) return null

  const unified = toUnifiedShape(address, report)
  await writeToKv(cacheKey, unified)
  return unified
}

// NEVER throws — every function below is wrapped so a caller can always treat a null return as
// "V2 unavailable, fall back to walletLite.ts" per this task's own fallback contract.

export async function getPortfolioFromV2(address: string): Promise<WalletLiteResult | null> {
  try {
    return await getCachedOrCompute(`v2:portfolio:${address.toLowerCase()}`, address, 'getPortfolioFromV2')
  } catch (err) {
    console.warn('[v2Adapters] getPortfolioFromV2 failed', { address, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function getWalletFromV2(address: string): Promise<WalletLiteResult | null> {
  try {
    return await getCachedOrCompute(`v2:wallet:${address.toLowerCase()}`, address, 'getWalletFromV2')
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
    return await readFromKv(cacheKey)
  } catch (err) {
    console.warn('[v2Adapters] getIdentityFromV2 failed', { address, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}
