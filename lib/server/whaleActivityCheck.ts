// INCREMENTAL WALLET SYNC: before the heavy GoldRush page (transactions_v3 with logs), ask Alchemy
// whether the wallet moved anything at all since its cursor. Measured live on 16 tracked wallets:
// GoldRush pages took 5–15s each, returned up to 97 MB, and hit 429s / timeouts; the same 16 activity
// checks took 0.55s in total (under 120 KB) and showed only 6 of 16 had moved anything in 24h.
// A wallet with no transfer since its cursor needs no GoldRush call. Any error or unknown answer is
// treated as ACTIVE (fetched as before): this check can only skip work, never lose an alert.

import { baseBlockAtTimestamp } from '@/src/modules/nativePriceResolver/chainlinkEthUsd'
import { alchemyRpcUrlFor } from '@/src/modules/providerFetchWindow/utils'

/** Rescan this much before the last successful scan, so a provider's indexing lag never drops a tx. */
export const ACTIVITY_CURSOR_OVERLAP_MS = 10 * 60_000
const CATEGORIES = ['external', 'erc20', 'internal']

/** Alchemy Base endpoint (getAssetTransfers is Alchemy-only). Server-side only. */
export function whaleAlchemyBaseRpcUrl(): string | null {
  const configured = alchemyRpcUrlFor('base')
  if (configured) return configured
  const fallback = process.env.BASE_RPC_URL?.trim()
  return fallback && /^https:\/\/base-mainnet\.g\.alchemy\.com\//.test(fallback) ? fallback : null
}

/**
 * Where a wallet's scan starts: the window start, or — for the standard 24h sync of a wallet already
 * scanned successfully inside it — its last scan minus the overlap. Wider windows always start at the
 * window start (a 24h scan never covered the rest of a 7-day window).
 */
export function activityCursorMs(params: { windowStartMs: number; lastScannedAt: string | null | undefined; useLastScan: boolean }): number {
  const last = params.lastScannedAt ? Date.parse(params.lastScannedAt) : Number.NaN
  if (!params.useLastScan || !Number.isFinite(last)) return params.windowStartMs
  return Math.max(params.windowStartMs, last - ACTIVITY_CURSOR_OVERLAP_MS)
}

export type ActivityCheckResult = {
  active: Set<string>
  inactive: Set<string>
  unknown: Set<string>
  calls: number
  ms: number
}

export async function checkWalletActivity(
  wallets: ReadonlyArray<{ address: string; sinceMs: number }>,
  opts: { rpcUrl: string | null; fetchImpl?: typeof fetch; concurrency?: number; timeoutMs?: number },
): Promise<ActivityCheckResult> {
  const started = Date.now()
  const result: ActivityCheckResult = { active: new Set(), inactive: new Set(), unknown: new Set(), calls: 0, ms: 0 }
  if (!opts.rpcUrl) {
    for (const w of wallets) result.unknown.add(w.address.toLowerCase())
    return result
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const query = async (filter: Record<string, string>, fromBlock: number): Promise<boolean | null> => {
    result.calls += 1
    try {
      const res = await fetchImpl(opts.rpcUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [{ fromBlock: `0x${fromBlock.toString(16)}`, toBlock: 'latest', category: CATEGORIES, maxCount: '0x1', excludeZeroValue: true, ...filter }] }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 4_000),
      })
      if (!res.ok) return null
      const json = await res.json().catch(() => null) as { result?: { transfers?: unknown[] }; error?: unknown } | null
      if (!json || json.error || !Array.isArray(json.result?.transfers)) return null
      return json.result.transfers.length > 0
    } catch {
      return null
    }
  }
  let cursor = 0
  const worker = async () => {
    while (cursor < wallets.length) {
      const { address, sinceMs } = wallets[cursor++]
      const key = address.toLowerCase()
      const block = baseBlockAtTimestamp(Math.floor(sinceMs / 1000))
      if (block == null) { result.unknown.add(key); continue }
      const [out, inn] = await Promise.all([query({ fromAddress: key }, block), query({ toAddress: key }, block)])
      if (out === true || inn === true) result.active.add(key)
      else if (out === false && inn === false) result.inactive.add(key)
      else result.unknown.add(key)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, wallets.length) }, worker))
  result.ms = Date.now() - started
  return result
}
