import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  parseClarkCommandName,
  intendedFormatForCommand,
  formatDeployerTimeoutPartial,
  formatHoldersTimeoutPartial,
  formatLpTimeoutPartial,
  formatCommandTimeoutPartial,
  commandForbidsTokenReadFallback,
  responseModeFromText,
} from '../lib/clark/commandFormats.ts'
import { createClarkRequestGate } from '../lib/client/clarkRequestLifecycle.ts'
import {
  resolveClarkCommandIdentity,
  clarkSingleflightKey,
  runClarkSingleflight,
  resetClarkSingleflightForTests,
  resolveClarkTimeoutFallback,
  assertCommandStayedOnFormat,
  buildClarkRequestLifecycleAudit,
  buildClarkCommandFallbackAudit,
} from '../lib/server/clarkRequestLifecycle.ts'
import { classifyClarkPrompt } from '../lib/server/clarkRouting.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'clark', 'route.ts'), 'utf8')
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'terminal', 'clark-ai', 'page.tsx'), 'utf8')
const radarSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'ClarkRadar.tsx'), 'utf8')

// ── Command identity stays deterministic ─────────────────────────────────────
for (let i = 0; i < 5; i++) {
  assert.equal(parseClarkCommandName(`/deployer ${BASE}`), 'deployer')
  assert.equal(classifyClarkPrompt(`/deployer ${BASE}`).intent, 'deployer_check')
  assert.equal(resolveClarkCommandIdentity(`/deployer ${BASE}`).routeSelected, 'deployer_check')
  assert.equal(intendedFormatForCommand('deployer'), 'DEPLOYER READ')
}
for (let i = 0; i < 5; i++) {
  assert.equal(parseClarkCommandName(`/holders ${BASE}`), 'holders')
  assert.equal(classifyClarkPrompt(`/holders ${BASE}`).intent, 'holders_check')
  assert.equal(resolveClarkCommandIdentity(`/holders ${BASE}`).routeSelected, 'holders_check')
}
for (let i = 0; i < 5; i++) {
  assert.equal(parseClarkCommandName(`/lp ${BASE}`), 'lp')
  assert.equal(classifyClarkPrompt(`/lp ${BASE}`).intent, 'liquidity_scan')
  assert.equal(resolveClarkCommandIdentity(`/lp ${BASE}`).routeSelected, 'liquidity_scan')
}
assert.equal(classifyClarkPrompt(`/token ${BASE}`).intent, 'token_scan')
assert.equal(classifyClarkPrompt(`/wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`).intent, 'wallet_scan')
assert.equal(classifyClarkPrompt(`/explain lp ${BASE}`).intent, 'liquidity_scan')

// ── Timeout copy stays on the command format ─────────────────────────────────
{
  const deployer = formatDeployerTimeoutPartial({ address: BASE, chain: 'base' })
  assert.ok(deployer.startsWith('DEPLOYER READ — partial'))
  assert.match(deployer, /Deployer resolver timed out/)
  assert.doesNotMatch(deployer, /TOKEN READ/)
  assert.equal(responseModeFromText(deployer), 'DEPLOYER READ')
  assert.equal(assertCommandStayedOnFormat('deployer', deployer), true)

  const holders = formatHoldersTimeoutPartial({ address: BASE, chain: 'base' })
  assert.ok(holders.startsWith('HOLDERS READ — partial'))
  assert.match(holders, /Holder source timed out/)
  assert.doesNotMatch(holders, /TOKEN READ/)
  assert.equal(assertCommandStayedOnFormat('holders', holders), true)

  const lp = formatLpTimeoutPartial({ address: BASE, symbol: 'USDC' })
  assert.ok(lp.startsWith('LIQUIDITY CHECK — partial'))
  assert.doesNotMatch(lp, /TOKEN READ/)
  assert.equal(assertCommandStayedOnFormat('lp', lp), true)
}

for (let i = 0; i < 5; i++) {
  const d = resolveClarkTimeoutFallback(`/deployer ${BASE}`, { isTimeout: true, routeHint: 'token', classifiedIntent: 'token_scan' })
  assert.equal(d.kind, 'deployer')
  assert.ok(d.reply.startsWith('DEPLOYER READ'))
  assert.doesNotMatch(d.reply, /TOKEN READ/)
  const h = resolveClarkTimeoutFallback(`/holders ${BASE}`, { isTimeout: true, routeHint: 'token', classifiedIntent: 'token_scan' })
  assert.equal(h.kind, 'holders')
  assert.ok(h.reply.startsWith('HOLDERS READ'))
  assert.doesNotMatch(h.reply, /TOKEN READ/)
  const l = resolveClarkTimeoutFallback(`/lp ${BASE}`, { isTimeout: true, routeHint: 'token', classifiedIntent: 'token_scan' })
  assert.equal(l.kind, 'liquidity')
  assert.ok(l.reply.startsWith('LIQUIDITY CHECK'))
  assert.doesNotMatch(l.reply, /TOKEN READ/)
}

assert.equal(commandForbidsTokenReadFallback('deployer'), true)
assert.equal(commandForbidsTokenReadFallback('holders'), true)
assert.equal(commandForbidsTokenReadFallback('lp'), true)
assert.equal(commandForbidsTokenReadFallback('token'), false)

{
  const tokenFb = resolveClarkTimeoutFallback(`/token ${BASE}`, { isTimeout: true, routeHint: 'token', classifiedIntent: 'token_scan' })
  assert.equal(tokenFb.kind, 'token')
  assert.match(tokenFb.reply, /TOKEN READ — timed out/)
}

// ── Client gate: ignore stale, latest wins, double-send blocked ──────────────
{
  const gate = createClarkRequestGate({ duplicateWindowMs: 2_500 })
  const first = gate.begin(`/deployer ${BASE}`)
  assert.equal(first.proceed, true)
  const dup = gate.begin(`/deployer ${BASE}`)
  assert.equal(dup.proceed, false)
  assert.equal(dup.duplicatePrevented, true)
  assert.equal(gate.stats().duplicatesBlocked, 1)
}

{
  const gate = createClarkRequestGate()
  const older = gate.begin(`/deployer ${BASE}`)
  assert.equal(older.proceed, true)
  const newer = gate.begin(`/holders ${BASE}`)
  assert.equal(newer.proceed, true)
  assert.equal(gate.shouldApply(older.requestId), false)
  assert.equal(gate.shouldApply(newer.requestId), true)
  assert.ok(gate.stats().ignoredStale >= 1)
  assert.equal(gate.complete(older.requestId), false)
  assert.equal(gate.complete(newer.requestId), true)
}

{
  const gate = createClarkRequestGate()
  const a = gate.begin('/token 0x1')
  const b = gate.begin('/lp 0x2')
  const c = gate.begin('/deployer 0x3')
  assert.equal(gate.shouldApply(a.requestId), false)
  assert.equal(gate.shouldApply(b.requestId), false)
  assert.equal(gate.shouldApply(c.requestId), true)
}

// ── Singleflight: same command+address+chain runs once ───────────────────────
{
  resetClarkSingleflightForTests()
  let runs = 0
  const key = clarkSingleflightKey('deployer', BASE, 'base')
  assert.equal(key, `deployer|${BASE.toLowerCase()}|base`)
  const fn = async () => {
    runs += 1
    await new Promise((r) => setTimeout(r, 30))
    return { analysis: 'DEPLOYER READ\nOrigin wallet: 0xabc' }
  }
  const [a, b, c] = await Promise.all([
    runClarkSingleflight(key, fn),
    runClarkSingleflight(key, fn),
    runClarkSingleflight(key, fn),
  ])
  assert.equal(runs, 1, 'overlapping same command+address+chain must singleflight')
  assert.equal(a.duplicatePrevented, false)
  assert.equal(b.duplicatePrevented, true)
  assert.equal(c.duplicatePrevented, true)
  assert.equal(a.value.analysis, b.value.analysis)
  const d = await runClarkSingleflight(key, fn)
  assert.equal(d.cacheHit, true)
  assert.equal(runs, 1, 'brief cache must reuse the in-window result')
}

{
  resetClarkSingleflightForTests()
  let deployerRuns = 0
  let holdersRuns = 0
  await Promise.all([
    runClarkSingleflight(clarkSingleflightKey('deployer', BASE, 'base'), async () => { deployerRuns += 1; return 'd' }),
    runClarkSingleflight(clarkSingleflightKey('holders', BASE, 'base'), async () => { holdersRuns += 1; return 'h' }),
  ])
  assert.equal(deployerRuns, 1)
  assert.equal(holdersRuns, 1)
}

// ── Audits include required fields ───────────────────────────────────────────
{
  const identity = resolveClarkCommandIdentity(`/deployer ${BASE}`, 'base')
  const text = formatCommandTimeoutPartial('deployer', { address: BASE, chain: 'base' })
  const life = buildClarkRequestLifecycleAudit({
    requestId: 'req-1',
    prompt: `/deployer ${BASE}`,
    identity,
    startedAt: Date.now() - 12,
    finalText: text,
    timedOut: true,
  })
  for (const field of [
    'requestId', 'messageId', 'prompt', 'command', 'address', 'chain', 'routeSelected',
    'startedAt', 'firstUiFeedbackMs', 'sourcesStarted', 'sourcesCompleted', 'sourcesTimedOut',
    'finalResponseMode', 'staleResponseIgnored', 'duplicateClickBlocked', 'durationMs',
  ]) {
    assert.ok(field in life, `lifecycle audit missing ${field}`)
  }
  assert.equal(life.command, 'deployer')
  assert.equal(life.finalResponseMode, 'DEPLOYER READ')
  const fb = buildClarkCommandFallbackAudit({ identity, finalText: text, timedOut: true })
  for (const field of ['command', 'primaryRoute', 'fallbackRoutesAttempted', 'fallbackAllowed', 'finalResponseMode', 'fallbackReason']) {
    assert.ok(field in fb, `fallback audit missing ${field}`)
  }
  assert.equal(fb.fallbackAllowed, false)
  assert.equal(fb.finalResponseMode, 'DEPLOYER READ')
}

// ── Route wiring: command-specific catch runs before TOKEN READ ──────────────
{
  const deployerIdx = routeSrc.indexOf('isDeployerFallback')
  const holdersIdx = routeSrc.indexOf('isHoldersFallback')
  const tokenFbIdx = routeSrc.indexOf('isTokenFallback')
  assert.ok(deployerIdx > -1, 'catch block must detect deployer fallback')
  assert.ok(holdersIdx > -1, 'catch block must detect holders fallback')
  assert.ok(tokenFbIdx > -1, 'token fallback still exists for real token scans')
  const deployerBranch = routeSrc.indexOf('if (isDeployerFallback)')
  const tokenBranch = routeSrc.indexOf('} else if (isTokenFallback)')
  assert.ok(deployerBranch > -1 && deployerBranch < tokenBranch, '/deployer timeout must be handled before TOKEN READ')
  assert.match(routeSrc, /callInternalApiCaught/)
  assert.match(routeSrc, /CLARK_DEPLOYER_SOURCE_TIMEOUT_MS/)
  assert.match(routeSrc, /CLARK_HOLDERS_SOURCE_TIMEOUT_MS/)
  assert.match(routeSrc, /runClarkSingleflight/)
  assert.match(routeSrc, /clarkRequestLifecycleAudit/)
  assert.match(routeSrc, /clarkCommandFallbackAudit/)
  assert.match(routeSrc, /requestId/)
}

{
  assert.match(pageSrc, /createClarkRequestGate/)
  assert.match(pageSrc, /requestId/)
  assert.match(pageSrc, /shouldApply/)
  assert.match(radarSrc, /createClarkRequestGate/)
  assert.match(radarSrc, /shouldApply/)
}

console.log('test-clark-request-lifecycle.mjs: all assertions passed')
