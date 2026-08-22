import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// CROSS-CHAIN-WAVE-GATE FIX, DISCLOSED (reported: sudden GeckoTerminal 429s on a shared/free
// endpoint that "never really happens"). Base and Robinhood run fully independent discovery
// cycles (requestedChain prefixes every cache/backoff key), each self-throttled to
// DISCOVERY_CONCURRENCY_LIMIT-per-wave — but GeckoTerminal's real rate limit is one shared budget
// tied to this deployment's outbound IP/API key, not chain-scoped. Two chains' waves landing in
// the same window can burst past that shared budget even though each chain's own pacing looks
// correct in isolation. This is a static source check (route.ts exports a Next.js route handler,
// not a plain module — reading the source as text and asserting on it directly, matching this
// repo's convention for route-level regression tests) proving the fix exists and is wired in
// correctly: a Redis-backed global gate, reserved once per wave, before any chain's chunk of
// sourceSpecs fires, best-effort so a Redis outage never blocks a request.

const routeSource = readFileSync(fileURLToPath(new URL('../app/api/radar/route.ts', import.meta.url)), 'utf8')

// The gate function exists and is best-effort: no-ops immediately when Redis isn't configured,
// and never throws out of the discovery path on a Redis error.
assert.match(routeSource, /async function reserveGlobalDiscoveryWaveSlot\(gapMs: number\): Promise<void>/, 'reserveGlobalDiscoveryWaveSlot must exist')
const gateFnMatch = routeSource.match(/async function reserveGlobalDiscoveryWaveSlot[\s\S]*?\n}/)
assert.ok(gateFnMatch, 'could not isolate reserveGlobalDiscoveryWaveSlot body')
const gateFnBody = gateFnMatch[0]
assert.match(gateFnBody, /if \(!redisConfigured\(\)\) return/, 'must no-op immediately when Redis is unconfigured — never block discovery without Redis backing')
assert.match(gateFnBody, /catch \{[^}]*best-effort/i, 'must swallow Redis errors best-effort, matching getDiscoveryBackoffUntil/setDiscoveryBackoff\'s existing philosophy')

// The gate is capped so a busy global slot can't stall a single request indefinitely.
assert.match(routeSource, /RADAR_GLOBAL_WAVE_GATE_MAX_WAIT_MS\s*=\s*2_500/, 'the max wait must stay bounded (2.5s) so heavy concurrent load degrades pacing gracefully instead of hanging requests')

// The gate key is NOT chain-prefixed — it must be one single shared key so Base and Robinhood
// (or any future chain) actually coordinate through it, unlike the deliberately chain-scoped
// per-source backoff/cache keys elsewhere in this file.
assert.match(routeSource, /const RADAR_GLOBAL_WAVE_GATE_KEY = 'radar:discovery-wave:global-next-at'/, 'the global gate key must be a single literal, not built from requestedChain')

// It's actually called once per wave, before the wave's Promise.all fires — not just defined and
// unused, and not called per-individual-source (which would defeat the point of pacing waves).
const waveLoopMatch = routeSource.match(/for \(let waveStart = 0[\s\S]*?\n  \}\n/)
assert.ok(waveLoopMatch, 'could not isolate the discovery wave loop')
const waveLoopBody = waveLoopMatch[0]
assert.match(waveLoopBody, /await reserveGlobalDiscoveryWaveSlot\(DISCOVERY_WAVE_DELAY_MS\)/, 'the wave loop must reserve a global slot before firing each wave')
const gateCallIndex = waveLoopBody.indexOf('await reserveGlobalDiscoveryWaveSlot')
const promiseAllIndex = waveLoopBody.indexOf('await Promise.all(wave.map(spec => fetchOneSource(spec)))')
assert.ok(gateCallIndex > -1 && promiseAllIndex > -1 && gateCallIndex < promiseAllIndex, 'the global slot must be reserved BEFORE the wave\'s requests fire, not after')

console.log('test-base-radar-cross-chain-wave-gate.mjs: all assertions passed')
