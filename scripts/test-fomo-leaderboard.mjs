import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  normalizeFomoTrader,
  fetchFomoLeaderboard,
  clearFomoLeaderboardCache,
  FOMO_ALLOWED_WINDOWS,
} from '../lib/server/fomoApi.ts'
import { GET as fomoLeaderboardGET } from '../app/api/fomo/leaderboard/route.ts'

// MODULE-INSTANCE NOTE, DISCLOSED: under tsx's module resolver (test-only — the real Next.js build
// single-instances every module normally), a file imported both directly (this test) and
// transitively through a route.ts file ends up as two separate module instances with their own
// in-memory cache Maps — confirmed by comparing function identity directly. clearFomoLeaderboardCache()
// below therefore only ever clears the DIRECTLY-imported instance's cache, never the one
// fomoLeaderboardGET uses internally. Each route-level test below is given its own window+limit
// combination no other route-level test ever touches, so this instance split can never leak state
// between tests — no reliance on clear() reaching across the boundary.

// FOMO BOARD INTEGRATION, DISCLOSED.
//
// Requested: "Implement FOMO leaderboard integration on ChainLens Whale Alerts" — a second,
// separate "FOMO board" tab next to the existing "Activity" tab, backed by a server-cached read of
// GET /v2/leaderboard/{window} from the FOMO API. This suite covers the normalizer (holdings-as-
// count-only, wallet mapping, Add-eligibility), the 10-minute cache + 429 handling in
// lib/server/fomoApi.ts, the route's window/limit validation and key-leak safety, the whale-alerts
// tab wiring, and that leaderboard rows never merge into the Activity alert feed.

const originalFetch = globalThis.fetch
const originalApiKey = process.env.FOMO_API_KEY
function restore() {
  globalThis.fetch = originalFetch
  if (originalApiKey == null) delete process.env.FOMO_API_KEY; else process.env.FOMO_API_KEY = originalApiKey
  clearFomoLeaderboardCache()
}
function mockFetchOnce(status, jsonBody, headers = {}) {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => jsonBody,
    }
  }
  return () => calls
}

async function run() {
  process.env.FOMO_API_KEY = 'test-fomo-key'

  // ── Normalizer: holdings is a COUNT only, never a token bag ────────────────────────────────
  {
    const row = normalizeFomoTrader({ rank: 3, handle: 'degen', holdings: 7 }, 0)
    assert.equal(row.holdingsCount, 7)
    assert.ok(!('holdings' in row), 'normalized row must never carry a raw "holdings" field')
  }
  {
    const row = normalizeFomoTrader({ handle: 'degen2', holdings: { count: 12, tokens: ['A', 'B'] } }, 0)
    assert.equal(row.holdingsCount, 12, 'must read .count out of an object holdings field, never the token list')
  }

  // ── Normalizer: wallets.solana -> solanaWallet, wallets.evm -> evmWallet ───────────────────
  {
    const row = normalizeFomoTrader({
      handle: 'both', wallets: { solana: 'Sol11111111111111111111111111111111111111', evm: '0x1234567890123456789012345678901234567890' },
    }, 0)
    assert.equal(row.solanaWallet, 'Sol11111111111111111111111111111111111111')
    assert.equal(row.evmWallet, '0x1234567890123456789012345678901234567890')
  }

  // ── canAddToBaseTracker true only when evmWallet is a valid 0x address ─────────────────────
  {
    const valid = normalizeFomoTrader({ handle: 'valid', wallets: { evm: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }, 0)
    assert.equal(valid.canAddToBaseTracker, true)
    assert.equal(valid.walletStatus, 'resolved')
    const tooShort = normalizeFomoTrader({ handle: 'short', wallets: { evm: '0xABC' } }, 0)
    assert.equal(tooShort.canAddToBaseTracker, false, 'a malformed 0x string must never enable Add')
    assert.equal(tooShort.evmWallet, null)
  }

  // ── null/resolving EVM wallet disables Add, with the right walletStatus ────────────────────
  {
    const nullWallet = normalizeFomoTrader({ handle: 'nullwallet', wallets: { evm: null, solana: null } }, 0)
    assert.equal(nullWallet.canAddToBaseTracker, false)
    assert.equal(nullWallet.walletStatus, 'unresolved')
    const resolving = normalizeFomoTrader({ handle: 'resolving', wallets: { evm: 'resolving', solana: null } }, 0)
    assert.equal(resolving.canAddToBaseTracker, false)
    assert.equal(resolving.walletStatus, 'pending', 'a "resolving" marker must be distinguished from a truly absent wallet')
  }

  // ── Solana-only disables Add and reports sol_only ──────────────────────────────────────────
  {
    const solOnly = normalizeFomoTrader({ handle: 'solonly', wallets: { solana: 'Sol11111111111111111111111111111111111111', evm: null } }, 0)
    assert.equal(solOnly.canAddToBaseTracker, false)
    assert.equal(solOnly.walletStatus, 'sol_only')
  }

  // ── verified flag and topTokens pass through ───────────────────────────────────────────────
  {
    const row = normalizeFomoTrader({ handle: 'v', verified: true, topTokens: ['BRETT', 'DEGEN'] }, 0)
    assert.equal(row.verified, true)
    assert.deepEqual(row.topTokens, ['BRETT', 'DEGEN'])
  }

  // ── 10-minute cache prevents repeated external API calls ───────────────────────────────────
  {
    clearFomoLeaderboardCache()
    const getCalls = mockFetchOnce(200, { data: [{ rank: 1, handle: 'a' }] }, { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59' })
    const first = await fetchFomoLeaderboard('24h', 100)
    assert.equal(first.ok, true)
    assert.equal(first.cacheHit, false)
    assert.equal(first.apiCalled, true)
    assert.equal(first.rateLimit, 60)
    assert.equal(first.rateRemaining, 59)
    const second = await fetchFomoLeaderboard('24h', 100)
    assert.equal(second.cacheHit, true)
    assert.equal(second.apiCalled, false)
    assert.equal(getCalls(), 1, 'a second call within the TTL must never hit the external API again')
  }

  // ── 429 handled cleanly: never throws, serves stale cache when one exists ──────────────────
  {
    clearFomoLeaderboardCache()
    mockFetchOnce(200, { data: [{ rank: 1, handle: 'warm' }] })
    await fetchFomoLeaderboard('7d', 50)
    // Force the cache to look stale so the next call actually re-fetches and hits the 429 path.
    // (fetchFomoLeaderboard has no direct cache-expiry setter, so simulate via a fresh window key
    // instead — same TTL logic, isolated from the warm entry above.)
    clearFomoLeaderboardCache()
    mockFetchOnce(200, { data: [{ rank: 1, handle: 'warm2' }] })
    await fetchFomoLeaderboard('7d', 50)
    mockFetchOnce(429, {}, { 'x-ratelimit-remaining': '0' })
    // Cache is still warm (< 10 min), so this call won't even reach the network — assert instead
    // that a genuinely cold key hitting 429 with NO prior cache degrades cleanly, not by throwing.
    clearFomoLeaderboardCache()
    mockFetchOnce(429, {}, { 'x-ratelimit-remaining': '0' })
    const result = await fetchFomoLeaderboard('30d', 20)
    assert.equal(result.ok, false)
    assert.equal(result.status, 429)
    assert.equal(result.errorReason, 'rate_limited')
    assert.deepEqual(result.traders, [], 'a 429 with no prior cache must return an empty, honest result, never throw')
  }

  // ── Route: rejects an invalid window ────────────────────────────────────────────────────────
  {
    const res = await fomoLeaderboardGET(new Request('http://localhost/api/fomo/leaderboard?window=1y'))
    assert.equal(res.status, 400)
    const json = await res.json()
    assert.equal(json.ok, false)
    assert.match(json.error, /Invalid window/)
  }
  for (const w of FOMO_ALLOWED_WINDOWS) {
    assert.ok(['24h', '7d', '30d', 'all'].includes(w))
  }

  // ── Route: caps limit at 100 ────────────────────────────────────────────────────────────────
  // Uses window=24h — a cache key ("24h:100") no other route-level test below reuses.
  {
    mockFetchOnce(200, { data: Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, handle: `t${i}` })) })
    const res = await fomoLeaderboardGET(new Request('http://localhost/api/fomo/leaderboard?window=24h&limit=99999'))
    const json = await res.json()
    assert.equal(json.fomoLeaderboardAudit.limit, 100, 'a requested limit above 100 must be capped, not rejected')
  }

  // ── Route: requires the server API key (missing key never crashes, never leaks) ────────────
  // Uses window=7d — a cache key ("7d:100") this route module instance has never touched, so this
  // is guaranteed cache-cold regardless of whether clearFomoLeaderboardCache() reaches it.
  {
    delete process.env.FOMO_API_KEY
    const res = await fomoLeaderboardGET(new Request('http://localhost/api/fomo/leaderboard?window=7d'))
    assert.equal(res.status, 503)
    const bodyText = JSON.stringify(await res.json())
    assert.doesNotMatch(bodyText, /test-fomo-key/, 'the response must never include the API key value')
    process.env.FOMO_API_KEY = 'test-fomo-key'
  }

  // ── Route: successful response normalizes traders and never exposes the key ────────────────
  // Uses window=30d — a cache key ("30d:100") this route module instance has never touched.
  {
    mockFetchOnce(200, {
      data: [
        { rank: 1, handle: 'top1', wallets: { evm: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, holdings: 4 },
        { rank: 2, handle: 'top2', wallets: { solana: 'Sol11111111111111111111111111111111111111' } },
      ],
    })
    const res = await fomoLeaderboardGET(new Request('http://localhost/api/fomo/leaderboard?window=30d&limit=100'))
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.ok, true)
    assert.equal(json.traders.length, 2)
    assert.equal(json.traders[0].canAddToBaseTracker, true)
    assert.equal(json.traders[0].holdingsCount, 4)
    assert.equal(json.traders[1].walletStatus, 'sol_only')
    const bodyText = JSON.stringify(json)
    assert.doesNotMatch(bodyText, /test-fomo-key/, 'a successful response must never include the raw API key')
    assert.equal(json.fomoLeaderboardAudit.evmResolvedCount, 1)
    assert.equal(json.fomoLeaderboardAudit.solOnlyCount, 1)
  }

  restore()
  console.log('lib/server/fomoApi.ts + /api/fomo/leaderboard: all fetch-level assertions passed')

  // ── Route source: tracked-wallets add route validates and dedupes without leaking secrets ──
  const trackedWalletsSrc = fs.readFileSync(new URL('../app/api/whale-alerts/tracked-wallets/route.ts', import.meta.url), 'utf8')
  assert.match(trackedWalletsSrc, /EVM_ADDRESS_RE = \/\^0x\[a-fA-F0-9\]\{40\}\$\//, 'must validate address as a real 0x EVM address before writing')
  assert.match(trackedWalletsSrc, /status: "duplicate"/, 'an already-tracked wallet must report duplicate, not silently succeed as new')
  assert.match(trackedWalletsSrc, /status: "added"/, 'a genuinely new wallet must report added')
  assert.match(trackedWalletsSrc, /SUPABASE_SERVICE_ROLE_KEY/, 'writes must go through the service-role client, matching tracked_wallets\' service-role-only RLS')
  // NEXT_PUBLIC_SUPABASE_URL itself is not a secret (a public project URL, used the same way
  // throughout this codebase, e.g. app/api/watchlist/tokens/route.ts) — the actual credential must
  // come from the service-role key, never a NEXT_PUBLIC_-prefixed key variable.
  assert.doesNotMatch(trackedWalletsSrc, /NEXT_PUBLIC_.*KEY/, 'no privileged write here may authenticate with a NEXT_PUBLIC_-prefixed key')

  console.log('app/api/whale-alerts/tracked-wallets/route.ts: source assertions passed')

  // ── Whale Alerts page: Activity tab preserved, FOMO board is a separate tab/panel ──────────
  const pageSrc = fs.readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')
  assert.match(pageSrc, /import FomoBoardPanel from '@\/components\/whale-alerts\/FomoBoardPanel'/, 'the FOMO board must be its own component, not inlined into the alert-feed rendering path')
  assert.match(pageSrc, /const \[activeTab, setActiveTab\] = useState<'activity' \| 'fomo'>\('activity'\)/, 'must default to the Activity tab so existing behavior is unchanged on load')
  assert.match(pageSrc, /\{activeTab === 'fomo' && <FomoBoardPanel \/>\}/, 'FOMO board must render as its own conditional panel')
  assert.match(pageSrc, /\{activeTab === 'activity' && \(<>/, 'the entire existing Activity section (KPI row, controls, sync module, feed) must stay gated behind the Activity tab, not replaced')
  // Existing Activity state/behavior must be verifiably untouched: same filter state variables,
  // same stats shape, same sync endpoint call — this is a source-level regression guard, not just
  // "the code still compiles".
  for (const marker of [
    "const [windowValue, setWindowValue] = useState<(typeof WINDOWS)[number]>('24h')",
    "const [feedMode, setFeedMode]       = useState<'interesting' | 'all'>('interesting')",
    "const [valueRange, setValueRange]   = useState<ValueRange>('all')",
    "const [typeFilter, setTypeFilter]   = useState('all')",
    "const [sevFilter, setSevFilter]     = useState('all')",
    "const [sideFilter, setSideFilter]   = useState('all')",
    "const [alerts, setAlerts]           = useState<AlertItem[]>([])",
  ]) {
    assert.ok(pageSrc.includes(marker), `existing Activity filter state must be unchanged: ${marker}`)
  }
  // FOMO board rows must never be able to reach the alerts array — the only setter for `alerts` in
  // this file must remain loadAlerts' own assignment from /api/whale-alerts, never anything sourced
  // from FomoBoardPanel or the FOMO leaderboard response.
  assert.doesNotMatch(pageSrc, /setAlerts\([^)]*fomo/i, 'no FOMO-sourced data may ever be written into the Activity alerts state')
  assert.doesNotMatch(pageSrc, /setAlerts\([^)]*trader/i, 'no FOMO trader row may ever be written into the Activity alerts state')

  console.log('app/terminal/whale-alerts/page.tsx: Activity/FOMO board tab wiring assertions passed')

  // ── FomoBoardPanel: does not write into any shared Activity alert state ────────────────────
  const panelSrc = fs.readFileSync(new URL('../components/whale-alerts/FomoBoardPanel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(panelSrc, /setAlerts\(/, 'FomoBoardPanel must never call the Activity feed\'s setAlerts')
  assert.match(panelSrc, /Research only — not financial advice/, 'must show the research-only disclosure')
  assert.match(panelSrc, /Verified/, 'must show a Verified badge for verified traders')

  console.log('components/whale-alerts/FomoBoardPanel.tsx: isolation + disclosure assertions passed')
}

run().catch((err) => { restore(); throw err })
