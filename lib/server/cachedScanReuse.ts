// When a cached Token Scanner result may be served again (Token Scanner cache hits, shared-scan waits and
// the Base Radar drawer's cache-only preview all use this one rule).
//   - Same response schema version, and the entry's own chain id + address match the request exactly.
//   - A degraded entry (GeckoTerminal rate-limited, labelled primaryMarketProvider.degraded) is served only
//     while it is under DEGRADED_SCAN_REUSE_MS old or GeckoTerminal is still cooling down — a fresh scan
//     would be degraded the same way then. Entries expire at the same 45s as every cached scan, so this
//     never keeps evidence fresher than a healthy scan would be.

import { isCacheHitValid } from '../tokenScannerChainStrictness'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from './tokenPublicResponse'
import { TOKEN_RISK_METHODOLOGY_VERSION } from './riskScore'

export const DEGRADED_SCAN_REUSE_MS = 15_000

export type CachedScanExpectation = { chainSlug: string; chainId: number; contract: string }

export async function isCachedScanServable(
  entry: Record<string, unknown> | null | undefined,
  expected: CachedScanExpectation,
  now: number,
  cooldownActive: () => Promise<boolean>,
): Promise<boolean> {
  if (!entry || entry.scanResponseSchemaVersion !== TOKEN_SCAN_RESPONSE_SCHEMA_VERSION) return false
  if (entry.riskMethodologyVersion !== TOKEN_RISK_METHODOLOGY_VERSION) return false
  const cachedChain = String(entry.chain ?? '')
  if (!isCacheHitValid(
    { chainSlug: cachedChain, chainId: cachedChain === expected.chainSlug ? expected.chainId : -1, tokenAddress: String(entry.contract ?? '') },
    { chainSlug: expected.chainSlug, chainId: expected.chainId, tokenAddress: expected.contract },
  )) return false
  if ((entry.primaryMarketProvider as { degraded?: unknown } | undefined)?.degraded === true) {
    const startedAt = typeof entry.scanRequestStartedAt === 'number' ? entry.scanRequestStartedAt : 0
    if (now - startedAt >= DEGRADED_SCAN_REUSE_MS && !(await cooldownActive())) return false
  }
  return true
}

/** Seconds since the cached scan started; null when unknown. */
export function cachedScanAgeSec(entry: Record<string, unknown>, now: number): number | null {
  return typeof entry.scanRequestStartedAt === 'number' ? Math.max(0, Math.round((now - entry.scanRequestStartedAt) / 1000)) : null
}
