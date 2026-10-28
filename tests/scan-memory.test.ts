import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RISK_INPUT_KEYS, SCAN_MEMORY_METHODOLOGY_VERSION, SCAN_MEMORY_SCANNER_VERSION, hashScanMemory, holderPoints, liquidityBandFromCents, usdToCents } from '../lib/server/scanMemory/canonical'
import { extractScanMemory } from '../lib/server/scanMemory/extract'
import { scheduleScanMemory, scanMemoryEnabled } from '../lib/server/scanMemory/persist'
import { TOKEN_RISK_METHODOLOGY_VERSION } from '../lib/server/riskScore'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION } from '../lib/server/tokenPublicResponse'

const TOKEN = `0x${'ab'.repeat(20)}`
const WALLET = `0x${'11'.repeat(20)}`

function scan(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'base',
    contract: TOKEN,
    scanResponseSchemaVersion: TOKEN_SCAN_RESPONSE_SCHEMA_VERSION,
    riskMethodologyVersion: TOKEN_RISK_METHODOLOGY_VERSION,
    riskScore: 70,
    riskLabel: 'High Risk',
    scanRequestStartedAt: Date.now() - 1_000,
    priceUsd: 1.25,
    liquidityUsd: 10_000,
    marketCapUsd: 50_000,
    holderDistribution: {
      top10: 10.4,
      denominator: 'total_supply:rpc_total_supply',
      topHolders: [{ address: WALLET, percent: 10.4 }],
    },
    contractFlags: {
      mint: { status: 'not_detected' },
      blacklist: { status: 'not_detected' },
      pause: { status: 'not_detected' },
    },
    lpControl: { status: 'locked', lpController: WALLET },
    devIntel: { deployerAddress: WALLET, deployerStatus: 'confirmed', linkedWallets: [{ address: WALLET }] },
    honeypot: { isHoneypot: false, honeypotReason: `wallet ${WALLET} sold` },
    riskInputStatuses: Object.fromEntries(RISK_INPUT_KEYS.map((key) => [key, 'verified'])),
    tokenScannerPipelineAudit: { firstFailureStage: null, tokenAddress: TOKEN },
    ...overrides,
  }
}

function evidenceOf(payload: ReturnType<typeof extractScanMemory> & { ok: true }) {
  return {
    chain: payload.payload.chain,
    tokenAddress: payload.payload.token_address,
    scannerVersion: payload.payload.scanner_version,
    riskMethodologyVersion: payload.payload.risk_methodology_version,
    coverage: payload.payload.coverage,
    coverageReason: payload.payload.coverage_reason,
    riskScore: payload.payload.risk_score,
    holderPoints: payload.payload.holder_points,
    holderBasis: payload.payload.holder_basis,
    liquidityBand: payload.payload.liquidity_usd == null ? null : liquidityBandFromCents(usdToCents(Number(payload.payload.liquidity_usd))!),
    honeypot: payload.payload.honeypot,
    mint: payload.payload.mint,
    blacklist: payload.payload.blacklist,
    pause: payload.payload.pause,
    lpStatus: payload.payload.lp_status,
    devStatus: payload.payload.dev_status,
    riskInputs: payload.payload.risk_inputs,
  }
}

test('versions come from the live engine constants', () => {
  assert.equal(SCAN_MEMORY_SCANNER_VERSION, `token_scanner_response:${TOKEN_SCAN_RESPONSE_SCHEMA_VERSION}`)
  assert.equal(TOKEN_SCAN_RESPONSE_SCHEMA_VERSION, 8)
  assert.equal(SCAN_MEMORY_METHODOLOGY_VERSION, 'evm_token_risk_score:v1')
  assert.equal(SCAN_MEMORY_METHODOLOGY_VERSION, TOKEN_RISK_METHODOLOGY_VERSION)
})

test('holder points and liquidity bands are deterministic without a previous row', () => {
  assert.equal(holderPoints(10), 10)
  assert.equal(holderPoints(10.9), 10)
  assert.equal(holderPoints(10.999999), 10)
  assert.equal(holderPoints(11), 11)
  const low = BigInt(10)
  const band = liquidityBandFromCents(low)!
  let cents = low
  while (liquidityBandFromCents(cents) === band) cents += BigInt(1)
  assert.equal(liquidityBandFromCents(cents - BigInt(1)), band)
  assert.equal(liquidityBandFromCents(cents), band + 1)
  assert.equal(liquidityBandFromCents(BigInt(0)), null)
})

test('extractor keeps allowlisted evidence and drops wallet identities', () => {
  const extracted = extractScanMemory(scan())
  assert.equal(extracted.ok, true)
  if (!extracted.ok) return
  const encoded = JSON.stringify(extracted.payload)
  assert.equal(encoded.includes(WALLET), false)
  assert.equal(encoded.includes('topHolders'), false)
  assert.equal(encoded.includes('linkedWallets'), false)
  assert.equal(extracted.payload.coverage, 'complete')
  assert.equal(extracted.payload.holder_points, 10)
  assert.equal(extracted.payload.risk_score, 70)
  assert.equal(extracted.payload.scanner_version, SCAN_MEMORY_SCANNER_VERSION)
})

test('price noise does not change the hash; genuine evidence changes do', () => {
  const base = extractScanMemory(scan())
  const priced = extractScanMemory(scan({ priceUsd: 99 }))
  const risk = extractScanMemory(scan({ riskScore: 71 }))
  const dev = extractScanMemory(scan({ devIntel: { deployerAddress: WALLET, deployerStatus: 'possible_match' } }))
  const security = extractScanMemory(scan({ contractFlags: { mint: { status: 'verified' }, blacklist: { status: 'not_detected' }, pause: { status: 'not_detected' } } }))
  const holders = extractScanMemory(scan({ holderDistribution: { top10: 11, denominator: 'provider_reported_percent' } }))
  assert.equal(base.ok && priced.ok && risk.ok && dev.ok && security.ok && holders.ok, true)
  if (!base.ok || !priced.ok || !risk.ok || !dev.ok || !security.ok || !holders.ok) return
  assert.equal(priced.payload.evidence_hash, base.payload.evidence_hash)
  assert.notEqual(priced.payload.price_usd, base.payload.price_usd)
  assert.notEqual(risk.payload.evidence_hash, base.payload.evidence_hash)
  assert.notEqual(dev.payload.evidence_hash, base.payload.evidence_hash)
  assert.notEqual(security.payload.evidence_hash, base.payload.evidence_hash)
  assert.notEqual(holders.payload.evidence_hash, base.payload.evidence_hash)
  assert.equal(base.payload.evidence_hash, hashScanMemory(evidenceOf(base)))
})

test('missing market numbers stay null and unavailable simulation is not a clear honeypot', () => {
  const missing = extractScanMemory(scan({ priceUsd: 0, liquidityUsd: null, marketCapUsd: undefined }))
  assert.equal(missing.ok, true)
  if (!missing.ok) return
  assert.equal(missing.payload.price_usd, null)
  assert.equal(missing.payload.liquidity_usd, null)
  assert.equal(missing.payload.market_cap_usd, null)
  const partial = extractScanMemory(scan({
    riskInputStatuses: { ...scan().riskInputStatuses, holders: 'partial' },
    honeypot: { isHoneypot: null },
  }))
  assert.equal(partial.ok, true)
  if (!partial.ok) return
  assert.equal(partial.payload.coverage, 'partial')
  assert.equal(partial.payload.honeypot, '-')
  const down = extractScanMemory(scan({
    tokenScannerPipelineAudit: { firstFailureStage: 'simulation' },
    honeypot: { isHoneypot: null },
    riskInputStatuses: { ...scan().riskInputStatuses, simulation: 'unavailable' },
  }))
  assert.equal(down.ok, true)
  if (!down.ok) return
  assert.equal(down.payload.coverage, 'provider_unavailable')
  assert.equal(down.payload.coverage_reason, 'simulation')
  assert.equal(down.payload.honeypot, '-')
})

test('a wrong methodology or a wallet-bearing status is skipped', () => {
  assert.equal(extractScanMemory(scan({ riskMethodologyVersion: 'other' })).ok, false)
  assert.equal(extractScanMemory(scan({ chain: 'solana', contract: 'So11111111111111111111111111111111111111112' })).ok, false)
  const poisoned = extractScanMemory(scan({ devIntel: { deployerStatus: WALLET } }))
  assert.equal(poisoned.ok, false)
})

test('scheduling never throws, does not wait, and a dropped callback performs no write', async () => {
  const flag = 'CORTEX_SCAN_MEMORY_ENABLED'
  const previous = process.env[flag]
  process.env[flag] = 'true'
  const body = { status: 200, token: TOKEN }
  let writes = 0
  try {
    assert.equal(scanMemoryEnabled(), true)
    scheduleScanMemory(scan(), {
      after: () => undefined,
      rpc: async () => { writes += 1; return { outcome: 'accepted' } },
    })
    scheduleScanMemory(scan(), {
      after: () => { throw new Error('no request scope') },
      rpc: async () => { writes += 1; return { outcome: 'accepted' } },
    })
    scheduleScanMemory(scan(), {
      after: (work) => { void work() },
      rpc: async () => { throw new Error('database down') },
    })
    scheduleScanMemory(scan(), {
      after: (work) => { void work() },
      rpc: async () => { writes += 1; return { outcome: 'accepted' } },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(writes, 1)
    assert.deepEqual(body, { status: 200, token: TOKEN })
  } finally {
    if (previous === undefined) delete process.env[flag]
    else process.env[flag] = previous
  }
})

test('the after() callback returns a promise that settles only after the write finishes, and never rejects', async () => {
  const flag = 'CORTEX_SCAN_MEMORY_ENABLED'
  const previous = process.env[flag]
  process.env[flag] = 'true'
  const error = console.error
  console.error = () => undefined
  try {
    // A write the test controls: it finishes only when release() is called.
    let release: (r: { outcome: string }) => void = () => undefined
    let writeDone = false
    let work: (() => unknown) | null = null
    scheduleScanMemory(scan(), {
      after: (w) => { work = w },
      rpc: () => new Promise((resolve) => { release = (r) => { writeDone = true; resolve(r) } }),
    })
    assert.ok(work, 'work was handed to after()')
    const tracked = (work as () => unknown)()
    assert.ok(tracked instanceof Promise, 'after() receives the write promise, so waitUntil can keep the invocation alive')
    let settled = false
    void (tracked as Promise<unknown>).then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false, 'still pending while the write is in flight')
    release({ outcome: 'accepted' })
    await tracked
    assert.equal(writeDone, true)
    assert.equal(settled, true, 'settles only after the writer finishes')

    // A failing database still yields a promise that resolves (fail open; nothing can reach the response).
    let failingWork: (() => unknown) | null = null
    scheduleScanMemory(scan(), { after: (w) => { failingWork = w }, rpc: async () => { throw new Error('database down') } })
    await assert.doesNotReject((failingWork as unknown as () => Promise<unknown>)())
  } finally {
    console.error = error
    if (previous === undefined) delete process.env[flag]
    else process.env[flag] = previous
  }
})

test('memory does not extract, schedule or write unless the server flag is exactly true', async () => {
  const flag = 'CORTEX_SCAN_MEMORY_ENABLED'
  const previous = process.env[flag]
  const impostors = [undefined, '', 'false', 'FALSE', 'True', 'TRUE', '1', 'yes', ' true', 'true ']
  try {
    for (const value of impostors) {
      if (value === undefined) delete process.env[flag]
      else process.env[flag] = value
      assert.equal(scanMemoryEnabled(), false)
      let reads = 0
      let scheduled = 0
      let writes = 0
      const untouched = new Proxy({}, { get() { reads += 1; return undefined } })
      scheduleScanMemory(untouched, {
        after: () => { scheduled += 1 },
        rpc: async () => { writes += 1; return { outcome: 'accepted' } },
      })
      assert.equal(reads, 0)
      assert.equal(scheduled, 0)
      assert.equal(writes, 0)
    }
    process.env[flag] = 'true'
    let scheduled = 0
    let writes = 0
    const body = { status: 200 }
    scheduleScanMemory(scan(), {
      after: (work) => { scheduled += 1; void work() },
      rpc: async () => { writes += 1; return null },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(scheduled, 1)
    assert.equal(writes, 1)
    assert.deepEqual(body, { status: 200 })
  } finally {
    if (previous === undefined) delete process.env[flag]
    else process.env[flag] = previous
  }
})

test('the live token route schedules memory once and does not await it or record cache hits', () => {
  const src = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.equal(src.match(/scheduleScanMemory\(/g)?.length, 1)
  assert.equal(src.includes('await scheduleScanMemory'), false)
  assert.equal(src.includes('CORTEX_SCAN_MEMORY_ENABLED'), false)
  assert.equal(src.includes("'use client'"), false)
  const cacheReturn = src.indexOf('return NextResponse.json(withOutcomeReceipt(_gated, outcomeUser.userId))')
  const memoryCall = src.indexOf('scheduleScanMemory(')
  assert.ok(cacheReturn > 0 && memoryCall > cacheReturn)
  assert.equal(readFileSync(new URL('../lib/server/riskScore.ts', import.meta.url), 'utf8').includes('scanMemory'), false)
  const memorySrc = ['canonical.ts', 'extract.ts', 'persist.ts'].map((file) => readFileSync(new URL(`../lib/server/scanMemory/${file}`, import.meta.url), 'utf8')).join('\n')
  assert.equal(/fetch\(|alchemy|dexscreener|geckoterminal/i.test(memorySrc), false)
  assert.equal(memorySrc.includes('NEXT_PUBLIC_CORTEX_SCAN_MEMORY'), false)
  const scheduleAt = memorySrc.indexOf('export function scheduleScanMemory')
  const scheduleBody = memorySrc.slice(scheduleAt)
  assert.ok(scheduleBody.indexOf('if (!scanMemoryEnabled()) return') < scheduleBody.indexOf('extractScanMemory('))
  assert.ok(scheduleBody.indexOf('if (!scanMemoryEnabled()) return') < scheduleBody.indexOf('hook('))
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  assert.equal(pkg.includes('20261028_scan_memory'), false)
  assert.equal(pkg.includes('supabase db'), false)
  assert.throws(() => readFileSync(new URL('../supabase/migrations/20261028_scan_memory.sql', import.meta.url), 'utf8'))
})
