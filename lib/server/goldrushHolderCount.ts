// lib/server/goldrushHolderCount.ts — shared, chain-aware GoldRush/Covalent holder-COUNT fetch.
//
// EXTRACTED-FOR-REUSE, DISCLOSED (reported: the Base Radar drawer's "Holders" section shows real
// data for some tokens but not others — traced to that section relying entirely on Token Scanner's
// internal resolveTokenHolders (app/api/token/route.ts), a much heavier full-holder-list resolver
// with its own, separate reliability characteristics, and — an explicit hard limit reiterated
// throughout this whole session — that engine is off-limits to modify, since it's shared by Token
// Scanner's own page for every user, not just this drawer. Rather than touch that file, this module
// extracts the ALREADY-PROVEN-RELIABLE holder-COUNT-only fetch app/api/radar/route.ts's own main
// feed has used successfully all session (a single lightweight token_holders_v2 call reading only
// pagination.total_count, not the full holder list) into one shared place, so app/api/radar/route.ts
// and app/api/base-radar/enrichment/route.ts both call the exact same logic instead of it drifting
// into two copies. This only ever provides a COUNT — never concentration/top-holder breakdown, which
// still requires the heavier full-list pull only Token Scanner's resolver does.
//
// CHAIN-UNSUPPORTED, DISCLOSED: hardcoded to GoldRush's 'base-mainnet' path — no verified Robinhood-
// chain GoldRush/Covalent network id exists, so a Robinhood contract short-circuits to the same
// honest 'unavailable' shape a genuine provider failure already produces, never a guessed endpoint
// that could silently return the wrong chain's data.

const GOLDRUSH_HOST = 'api.covalenthq.com'
const HOLDER_COUNT_CACHE_TTL_MS = 10 * 60_000

export type HolderCountReason = 'ok' | 'no_api_key' | 'rate_limited' | 'http_error' | 'timeout' | 'no_data' | 'chain_unsupported'
export interface HolderCountResult {
  count: number | null
  reason: HolderCountReason
  httpStatus?: number | null
  errorBody?: string | null
}

const holderCountCache = new Map<string, { count: number | null; reason?: HolderCountReason; expiresAt: number }>()

export async function fetchGoldRushHolderCount(contract: string, chain: 'base' | 'robinhood'): Promise<HolderCountResult> {
  if (chain !== 'base') return { count: null, reason: 'chain_unsupported' }
  const key = `${chain}:${contract.toLowerCase()}`
  const cached = holderCountCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return { count: cached.count, reason: cached.count != null ? 'ok' : (cached.reason ?? 'no_data') }
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
  if (!apiKey) return { count: null, reason: 'no_api_key' }
  const attempt = async (): Promise<HolderCountResult> => {
    try {
      // page-size=100 (not 1) — Covalent rejects page-size values outside its accepted range on the
      // low end too; this only ever reads pagination.total_count, never the returned holder rows.
      const res = await fetch(
        `https://${GOLDRUSH_HOST}/v1/base-mainnet/tokens/${contract}/token_holders_v2/?page-number=0&page-size=100`,
        { cache: 'no-store', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3500) },
      )
      if (!res.ok) {
        const body = await res.text().catch(() => '').then(t => t.slice(0, 200))
        return { count: null, reason: res.status === 429 ? 'rate_limited' : 'http_error', httpStatus: res.status, errorBody: body }
      }
      const json = await res.json().catch(() => null) as { data?: { pagination?: { total_count?: number } } } | null
      const totalCount = json?.data?.pagination?.total_count
      if (typeof totalCount === 'number' && Number.isFinite(totalCount)) return { count: totalCount, reason: 'ok' }
      return { count: null, reason: 'no_data' }
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      return { count: null, reason: timedOut ? 'timeout' : 'http_error' }
    }
  }
  let result = await attempt()
  // One retry after a short backoff — absorbs a transient blip (brief 5xx, dropped connection)
  // instead of letting one momentary failure zero out this contract's holder evidence entirely.
  if (result.count == null) {
    await new Promise(resolve => setTimeout(resolve, 300))
    result = await attempt()
  }
  // Cache negative/failed lookups too (shorter-lived) so a rate-limited burst doesn't get re-tried
  // on every request for the same contract, compounding the same rate-limit problem.
  holderCountCache.set(key, { count: result.count, reason: result.reason, expiresAt: Date.now() + (result.count != null ? HOLDER_COUNT_CACHE_TTL_MS : 60_000) })
  return result
}
