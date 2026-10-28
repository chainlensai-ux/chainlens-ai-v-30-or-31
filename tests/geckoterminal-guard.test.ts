// GeckoTerminal guard: no 429 retries, Retry-After, shared cooldown across instances, bounded
// 5xx/network retries, KV failure, per-request counters and safe logs.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGeckoTerminalGuard, GT_COOLDOWN_BASE_MS, GT_COOLDOWN_KEY, GT_RETRY_AFTER_CAP_MS, isGeckoTerminalCooldownResponse,
  logGtRequestSummary, newGtRequestStats, runWithGtStats, type GtDeps,
} from '../lib/server/providers/geckoTerminalGuard'

const URL_POOLS = 'https://api.geckoterminal.com/api/v2/networks/base/tokens/0x4200000000000000000000000000000000000006/pools?page=1'
const SECRET_BASE = 'https://gt-proxy.example.com/key-SECRET123'

function harness(opts: { kvDown?: boolean; kvConfigured?: boolean; store?: Map<string, unknown> } = {}) {
  let t = 1_000_000
  const store = opts.store ?? new Map<string, unknown>()
  const logs: string[] = []
  const responses: Array<() => Response> = []
  let upstream = 0
  const deps: GtDeps = {
    now: () => t,
    sleep: async (ms) => { t += ms },
    random: () => 0.5,
    log: (line) => logs.push(line),
    kv: {
      configured: () => opts.kvConfigured !== false,
      get: async <T>(k: string) => { if (opts.kvDown) throw new Error('kv down'); return (store.get(k) as T) ?? null },
      set: async (k, v) => { if (opts.kvDown) throw new Error('kv down'); store.set(k, structuredClone(v)) },
    },
    fetch: (async () => { upstream++; const next = responses.shift(); if (!next) return new Response('{}', { status: 200 }); return next() }) as typeof fetch,
  }
  return { deps, guard: createGeckoTerminalGuard(deps), logs, store, push: (...r: Array<() => Response>) => responses.push(...r), upstream: () => upstream, advance: (ms: number) => { t += ms }, now: () => t }
}
const r429 = (retryAfter?: string) => () => new Response('{}', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} })
const r200 = () => new Response('{"data":[]}', { status: 200 })
const r503 = () => new Response('{}', { status: 503 })

test('a 429 is never retried and opens a cooldown; the next call sends nothing', async () => {
  const h = harness()
  h.push(r429())
  const first = await h.guard.fetch(URL_POOLS, {}, { route: 'token' })
  assert.equal(first.status, 429)
  assert.equal(h.upstream(), 1, 'no immediate retry')
  const second = await h.guard.fetch(URL_POOLS, {}, { route: 'token' })
  assert.equal(second.status, 429)
  assert.equal(isGeckoTerminalCooldownResponse(second), true)
  assert.equal(h.upstream(), 1, 'cooldown: no upstream request')
  assert.equal(Number(second.headers.get('retry-after')), GT_COOLDOWN_BASE_MS / 1000)
})

test('Retry-After is respected (seconds and HTTP date) and capped; without it the cooldown escalates', async () => {
  const a = harness(); a.push(r429('42'))
  assert.equal((await a.guard.fetch(URL_POOLS, {}, { route: 'token' })).status, 429)
  assert.equal((await a.guard.cooldown()).remainingMs, 42_000)
  a.advance(42_001)
  a.push(r200)
  assert.equal((await a.guard.fetch(URL_POOLS, {}, { route: 'token' })).status, 200, 'requests resume when the cooldown ends')

  const d = harness(); d.push(() => new Response('{}', { status: 429, headers: { 'retry-after': new Date(d.now() + 90_000).toUTCString() } }))
  await d.guard.fetch(URL_POOLS, {}, { route: 'token' })
  const rem = (await d.guard.cooldown()).remainingMs
  assert.ok(rem > 88_000 && rem <= 90_000, String(rem))

  const c = harness(); c.push(r429('86400'))
  await c.guard.fetch(URL_POOLS, {}, { route: 'token' })
  assert.equal((await c.guard.cooldown()).remainingMs, GT_RETRY_AFTER_CAP_MS)

  const e = harness()
  const seen: number[] = []
  for (let i = 0; i < 4; i++) {
    e.push(r429())
    await e.guard.fetch(URL_POOLS, {}, { route: 'token' })
    seen.push((await e.guard.cooldown()).remainingMs)
    e.advance(seen[i] + 1)
  }
  assert.deepEqual(seen, [10_000, 20_000, 30_000, 30_000], 'escalation is capped')
})

test('the cooldown is shared across instances through KV', async () => {
  const store = new Map<string, unknown>()
  const a = harness({ store }), b = harness({ store })
  b.advance(0)
  a.push(r429('30'))
  await a.guard.fetch(URL_POOLS, {}, { route: 'radar' })
  assert.ok(store.has(GT_COOLDOWN_KEY))
  const res = await b.guard.fetch(URL_POOLS, {}, { route: 'token' })
  assert.equal(isGeckoTerminalCooldownResponse(res), true, 'instance B never saw a 429 but still pauses')
  assert.equal(b.upstream(), 0)
  assert.match(b.logs.join('\n'), /"evt":"gt_call_avoided".*"coordination":"distributed"/)
})

test('KV unavailable: the cooldown is kept per instance and logs say coordination is local only', async () => {
  const h = harness({ kvDown: true })
  h.push(r429())
  await h.guard.fetch(URL_POOLS, {}, { route: 'token' })
  const res = await h.guard.fetch(URL_POOLS, {}, { route: 'token' })
  assert.equal(isGeckoTerminalCooldownResponse(res), true)
  assert.equal(h.upstream(), 1)
  assert.match(h.logs.join('\n'), /"evt":"gt_cooldown_opened".*"coordination":"local_only"/)
  assert.match(h.logs.join('\n'), /"evt":"gt_call_avoided".*"coordination":"local_only"/)
  const unconfigured = harness({ kvConfigured: false })
  assert.equal((await unconfigured.guard.cooldown()).coordination, 'local_only')
})

test('5xx and network errors get one bounded retry; retry:false gets none; a 4xx is never retried', async () => {
  const h = harness()
  const start = h.now()
  h.push(r503, r200)
  assert.equal((await h.guard.fetch(URL_POOLS, {}, { route: 'token' })).status, 200)
  assert.equal(h.upstream(), 2)
  const waited = h.now() - start
  assert.ok(waited >= 300 && waited < 800, `bounded delay, got ${waited}ms`)

  const twice = harness(); twice.push(r503, r503)
  assert.equal((await twice.guard.fetch(URL_POOLS, {}, { route: 'token' })).status, 503)
  assert.equal(twice.upstream(), 2, 'at most one retry')

  const net = harness(); net.push(() => { throw new TypeError('fetch failed') }, () => { throw new TypeError('fetch failed') })
  await assert.rejects(net.guard.fetch(URL_POOLS, {}, { route: 'token' }), TypeError)
  assert.equal(net.upstream(), 2)

  const none = harness(); none.push(r503)
  assert.equal((await none.guard.fetch(URL_POOLS, {}, { route: 'radar', retry: false })).status, 503)
  assert.equal(none.upstream(), 1)

  const notFound = harness(); notFound.push(() => new Response('{}', { status: 404 }))
  assert.equal((await notFound.guard.fetch(URL_POOLS, {}, { route: 'token' })).status, 404)
  assert.equal(notFound.upstream(), 1)
})

test('a retry is not sent if another request opened the cooldown meanwhile', async () => {
  const store = new Map<string, unknown>()
  const h = harness({ store })
  h.push(r503)
  const other = harness({ store })
  h.deps.sleep = async (ms) => { h.advance(ms + 1_000); other.push(r429('20')); await other.guard.fetch(URL_POOLS, {}, { route: 'radar' }) }
  const guard = createGeckoTerminalGuard(h.deps)
  const res = await guard.fetch(URL_POOLS, {}, { route: 'token' })
  assert.equal(isGeckoTerminalCooldownResponse(res), true)
  assert.equal(h.upstream(), 1)
})

test('per-request counters and the summary line', async () => {
  const h = harness()
  h.push(r200, r429())
  const s = newGtRequestStats()
  await runWithGtStats(async () => {
    await h.guard.fetch(URL_POOLS, {}, { route: 'token' })
    await h.guard.fetch(URL_POOLS, {}, { route: 'token' })
    await h.guard.fetch(URL_POOLS, {}, { route: 'token' })
  }, s)
  assert.deepEqual({ ...s }, { upstreamCalls: 2, rateLimited: 1, avoided: 1, retries: 0, upstreamErrors: 0, coordination: 'distributed' })
  const lines: string[] = []
  logGtRequestSummary('token', { ...s, cache: 'miss' }, (l) => lines.push(l))
  assert.deepEqual(JSON.parse(lines[0]), { provider: 'geckoterminal', evt: 'gt_request_summary', route: 'token', cache: 'miss', upstreamCalls: 2, rateLimited: 1, avoided: 1, retries: 0, upstreamErrors: 0, coordination: 'distributed' })
  logGtRequestSummary('token', newGtRequestStats(), (l) => lines.push(l))
  assert.equal(lines.length, 1, 'requests that never touched GeckoTerminal log nothing')
})

test('logs carry no URLs, keys, addresses or headers', async () => {
  const h = harness()
  h.push(r429('5'))
  await h.guard.fetch(`${SECRET_BASE}/api/v2/networks/base/tokens/0x4200000000000000000000000000000000000006/pools`, { headers: { authorization: 'Bearer user-session-token' } }, { route: 'token' })
  await h.guard.fetch(`${SECRET_BASE}/api/v2/networks/base/tokens/0x4200000000000000000000000000000000000006/pools`, {}, { route: 'token' })
  const all = h.logs.join('\n')
  for (const secret of ['SECRET123', 'gt-proxy', '0x4200000000000000000000000000000000000006', 'user-session-token', 'Bearer']) assert.equal(all.includes(secret), false, secret)
  assert.match(all, /"endpoint":"token_pools"/)
})

test('a failing logger or KV write never breaks a request', async () => {
  const h = harness()
  h.deps.log = () => { throw new Error('stdout closed') }
  h.deps.kv.set = async () => { throw new Error('kv write failed') }
  const guard = createGeckoTerminalGuard(h.deps)
  h.push(r429())
  assert.equal((await guard.fetch(URL_POOLS, {}, { route: 'token' })).status, 429)
  assert.equal(isGeckoTerminalCooldownResponse(await guard.fetch(URL_POOLS, {}, { route: 'token' })), true)
})
