// Track "Scan vs Now": current Risk Score / Top 10 / Dev Wallet come from a real Token Scanner recheck (EVM and
// Solana) when the stored scanner evidence is stale — never only from a 45s cache hit — and the recheck never
// debits the user's token-scan quota unless it is unsigned.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { snapshotFromScan } from '../lib/server/tokenOutcomeReceipt'
import { buildOutcomeRefreshUpdate, trackScannerEvidenceStale, TRACK_SCANNER_RECHECKS_PER_REFRESH } from '../lib/server/tokenOutcomeService'
import {
  signTrackRecheck, verifyTrackRecheck, trackScannerRecheck, solanaScanForTrack, TRACK_RECHECK_HEADER,
  SOLANA_HOLDER_BASIS, SOLANA_RISK_METHODOLOGY_VERSION,
} from '../lib/server/trackScannerRecheck'
import { compareTrackReceipt, currentTrackSnapshot, originalTrackSnapshot } from '../lib/trackIntelligence'
import { TOKEN_RISK_METHODOLOGY_VERSION } from '../lib/server/riskScore'
import { OUTCOME_POLICY, type TrackedOutcome } from '../lib/tokenOutcomes'
import type { ClarkMarketQuote } from '../lib/server/clarkMarketData'

process.env.TOKEN_OUTCOME_SIGNING_SECRET = 'track-recheck-unit-test-secret-only'
const user = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const address = `0x${'b'.repeat(40)}`
const MINT = 'So11111111111111111111111111111111111111112'
const scannedAt = 1_789_345_000_000

function baselineScan(extra: Record<string, unknown> = {}) {
  return {
    chain: 'base', contract: address, name: 'Test', symbol: 'TEST', riskScore: 62,
    riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier', riskLabel: 'High Risk',
    priceUsd: 1, liquidityUsd: 161_300, marketCapUsd: null, scanRequestId: 'scan-1', scanRequestStartedAt: scannedAt,
    holderDistribution: { top10: 63.7, denominator: 'total_supply:rpc_total_supply' },
    riskMethodologyVersion: TOKEN_RISK_METHODOLOGY_VERSION, ...extra,
  }
}
function row(extra: Record<string, unknown> = {}): TrackedOutcome {
  const snapshot = snapshotFromScan(baselineScan(extra), user)!
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: user, chain: 'base', token_address: address,
    scan_id: snapshot.scanId, tracked_at: snapshot.scannedAt, baseline_price_usd: 1, baseline_liquidity_usd: 161_300,
    baseline_market_cap_usd: null, baseline_risk_score: 62, baseline_verdict: 'High Risk', baseline_snapshot_json: snapshot,
    current_price_usd: null, current_liquidity_usd: null, price_change_pct: null, liquidity_change_pct: null,
    outcome_status: 'watching', outcome_confidence: 'low', outcome_reasons_json: [], last_checked_at: null, market_source: null,
  } as TrackedOutcome
}
const quote = (priceUsd: number, now: number): ClarkMarketQuote => ({
  provider: 'dexscreener', name: 'Test', symbol: 'TEST', chain: 'base', chainId: 8453, address, priceUsd, liquidityUsd: 59_900,
  marketCapUsd: null, fdvUsd: null, volume24hUsd: null, change24hPct: null, fetchedAt: now,
  marketIdentity: { selectedPoolAddress: 'pool', baseTokenAddress: address, quoteTokenAddress: null },
})

// ── signature ───────────────────────────────────────────────────────────────────────────────────────
test('recheck signature binds user + chain + token + minute', () => {
  const now = 1_790_000_000_000
  const sig = signTrackRecheck(user, 'base', address, now)!
  assert.equal(verifyTrackRecheck(sig, user, 'base', address.toUpperCase().replace('0X', '0x'), now), true, 'EVM address case-insensitive')
  assert.equal(verifyTrackRecheck(sig, user, 'base', address, now + 60_000), true, 'previous minute still valid')
  assert.equal(verifyTrackRecheck(sig, user, 'base', address, now + 180_000), false, 'expires')
  assert.equal(verifyTrackRecheck(sig, other, 'base', address, now), false, 'other user')
  assert.equal(verifyTrackRecheck(sig, user, 'eth', address, now), false, 'other chain')
  assert.equal(verifyTrackRecheck(sig, user, 'base', `0x${'c'.repeat(40)}`, now), false, 'other token')
  assert.equal(verifyTrackRecheck('forged', user, 'base', address, now), false)
  assert.equal(signTrackRecheck(user, 'base', address, now, ''), null, 'no secret → no recheck')
})

test('/api/token skips ONLY the quota debit for a valid recheck signature, after auth', () => {
  const src = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  const auth = src.indexOf('const outcomeUser = await requireAuthenticatedUser(req)')
  const verify = src.indexOf('verifyTrackRecheck(_recheckSig, outcomeUser.userId')
  const quota = src.indexOf('_isTrackRecheck ? { allowed: true as const, limit: null } : await consumeTokenScan(')
  assert.ok(auth > 0 && verify > auth && quota > verify)
  assert.ok(src.indexOf('if (!(await checkRate(req)))') < verify, 'rate limiter still applies')
  assert.match(src, /riskMethodologyVersion = TOKEN_RISK_METHODOLOGY_VERSION/)
  assert.match(src, /denominator: _holderPctTotalSupplySource \? `total_supply:\$\{_holderPctTotalSupplySource\}`/)
})

// ── recheck client ──────────────────────────────────────────────────────────────────────────────────
function fakeFetch(body: unknown, seen: Array<{ url: string; headers: Record<string, string>; body: string }>, status = 200) {
  return (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url, headers: init.headers, body: init.body })
    return { ok: status === 200, status, json: async () => body }
  }) as unknown as typeof fetch
}

test('EVM recheck calls the real /api/token as the user with a signed header and returns the scan', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const r = await trackScannerRecheck({ origin: 'https://x.test', authorization: 'Bearer user-token', userId: user, now: () => 1_790_000_000_000,
    fetchImpl: fakeFetch({ chain: 'base', contract: address, riskScore: 71, riskScoreType: 'risk_score' }, seen) })({ chain: 'base', token_address: address })
  assert.equal(seen[0].url, 'https://x.test/api/token')
  assert.equal(seen[0].headers.Authorization, 'Bearer user-token')
  assert.equal(verifyTrackRecheck(seen[0].headers[TRACK_RECHECK_HEADER], user, 'base', address, 1_790_000_000_000), true)
  assert.deepEqual(JSON.parse(seen[0].body), { contract: address, chain: 'base' })
  assert.deepEqual([r?.riskScore, r?.scanRequestStartedAt], [71, 1_790_000_000_000])
})

test('recheck refuses a mismatched scan, an error, or a missing session', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const mk = (body: unknown, auth: string | null = 'Bearer t', status = 200) =>
    trackScannerRecheck({ origin: 'https://x.test', authorization: auth, userId: user, fetchImpl: fakeFetch(body, seen, status) })({ chain: 'base', token_address: address })
  assert.equal(await mk({ chain: 'eth', contract: address }), null, 'wrong chain')
  assert.equal(await mk({ chain: 'base', contract: `0x${'c'.repeat(40)}` }), null, 'wrong token')
  assert.equal(await mk({ error: 'limit' }, 'Bearer t', 429), null)
  assert.equal(await mk({ chain: 'base', contract: address }, null), null, 'no session → no recheck')
})

test('Solana recheck maps the scanner result: canonical risk, top-10 token accounts + basis, methodology', async () => {
  // Same realistic shape the Solana risk-direction tests use.
  const sol = {
    mintAddress: MINT, authorityReadSucceeded: true, mintAuthority: null, freezeAuthority: null, tokenProgram: 'spl-token',
    topAccountConcentration: { top1Percent: 9, top10Percent: 48.2, top20Percent: 60, accountsSampled: 50, accounts: [] },
    marketDataAvailable: true,
    marketData: { liquidityUsd: 250_000, priceUsd: 1, volume24hUsd: 80_000, fdvUsd: null, marketCapUsd: null, primaryPoolAddress: 'POOL1', primaryDexLabel: 'raydium', tokenName: null, tokenSymbol: null, pairAgeLabel: '120d', pairAgeDays: 120, txns24h: { buys: 300, sells: 120 }, socials: { website: null, twitter: null, telegram: null, discord: null, reddit: null } },
    poolProgram: { resolved: true, poolAddress: 'POOL1', owner: 'X', label: 'Raydium AMM V4', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: null },
    heliusHolders: { called: true, success: true, holderCount: 5000, isLowerBound: false, pagesFetched: 1, errorReason: null },
    jupiter: { called: true, success: true, resolved: { name: 'X', symbol: 'X', logo: null, verified: true, price: 1 }, errorReason: null },
    deepCreator: null, resolvedTokenName: 'X', unsupportedChecks: [],
    supplyControl: { currentSupply: 1_000_000, maxSupply: 1_000_000, inflationPossible: false, inflationReason: 'Mint authority revoked.', supplyPermanentlyFixed: true, supplyFixedReason: 'Supply fixed.', mintAuthority: null, freezeAuthority: null, tokenProgram: 'spl-token', extensions: [], extensionsResolved: false, extensionExplanations: [] },
    creatorConfidence: { tier: 'UNKNOWN', confidencePercent: 0, wallet: null, reason: 'not run' },
    clusterMap: null,
  }
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const r = await trackScannerRecheck({ origin: 'https://x.test', authorization: 'Bearer t', userId: user, fetchImpl: fakeFetch(sol, seen) })({ chain: 'solana', token_address: MINT })
  assert.equal(r?.chain, 'solana')
  assert.equal(r?.contract, MINT)
  assert.deepEqual(r?.holderDistribution, { top10: 48.2, denominator: SOLANA_HOLDER_BASIS })
  assert.equal(r?.riskMethodologyVersion, SOLANA_RISK_METHODOLOGY_VERSION)
  assert.equal(typeof r?.riskScore, 'number')
  assert.equal(r?.riskScoreType, 'risk_score')
})

test('Solana: a result whose risk cannot be computed still yields Top 10; a different mint is refused', async () => {
  const minimal = solanaScanForTrack({ mintAddress: MINT, topAccountConcentration: { top10Percent: 33, accounts: [] } } as never, 5)
  assert.deepEqual([minimal.riskScore, minimal.holderDistribution], [null, { top10: 33, denominator: SOLANA_HOLDER_BASIS }])
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const wrong = await trackScannerRecheck({ origin: 'https://x.test', authorization: 'Bearer t', userId: user, fetchImpl: fakeFetch({ mintAddress: 'Other1111111111111111111111111111111111111' }, seen) })({ chain: 'solana', token_address: MINT })
  assert.equal(wrong, null)
})

// ── refresh integration ─────────────────────────────────────────────────────────────────────────────
test('a recheck result fills Scan vs Now risk + top 10 with real deltas when methodology and basis match', () => {
  const now = scannedAt + 21 * 86_400_000
  const r = row()
  const recheck = {
    chain: 'base', contract: address, scanRequestStartedAt: now, riskScore: 74, riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier',
    riskMethodologyVersion: TOKEN_RISK_METHODOLOGY_VERSION, holderDistribution: { top10: 70.2, denominator: 'total_supply:rpc_total_supply' },
    devIntel: { deployerStatus: 'confirmed', creationTxHash: '0xc', deployerAddress: '0xdev', linkedWallets: [] },
  }
  const update = buildOutcomeRefreshUpdate(r, quote(0.36, now), null, new Date(now).toISOString(), now, recheck)
  const next = { ...r, ...update, current_market_cap_usd: null } as unknown as TrackedOutcome
  const cmp = compareTrackReceipt(originalTrackSnapshot(next), currentTrackSnapshot(next))
  const by = Object.fromEntries(cmp.comparisons.map((c) => [c.key, c]))
  assert.deepEqual([by.riskScore.original, by.riskScore.current, by.riskScore.delta], [62, 74, 12])
  assert.equal(by.top10Pct.current, 70.2)
  assert.ok(Math.abs((by.top10Pct.delta ?? 0) - 6.5) < 1e-9)
  assert.equal(by.deployerActivity.current, 0, 'confirmed deployer, no transfers = checked and none (not unknown)')
})

test('a baseline without recorded methodology still shows the current value (no fabricated delta)', () => {
  const now = scannedAt + 86_400_000
  const r = row({ riskMethodologyVersion: undefined, holderDistribution: { top10: 63.7 } })
  const recheck = { chain: 'base', contract: address, scanRequestStartedAt: now, riskScore: 74, riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier', holderDistribution: { top10: 70.2 } }
  const update = buildOutcomeRefreshUpdate(r, quote(0.5, now), null, new Date(now).toISOString(), now, recheck)
  const next = { ...r, ...update } as unknown as TrackedOutcome
  const by = Object.fromEntries(compareTrackReceipt(originalTrackSnapshot(next), currentTrackSnapshot(next)).comparisons.map((c) => [c.key, c]))
  assert.deepEqual([by.riskScore.current, by.riskScore.delta], [74, null])
  assert.deepEqual([by.top10Pct.current, by.top10Pct.delta], [70.2, null])
})

test('Solana baseline top 10 (recorded as top10Percent) is read as the original value', () => {
  const r = row()
  r.baseline_snapshot_json = { ...r.baseline_snapshot_json, baselineHolderSignals: { top10Percent: 41.5 } }
  assert.equal(originalTrackSnapshot(r).top10Pct, 41.5)
})

test('scanner evidence staleness drives the recheck; rechecks are bounded per refresh and wired in the route', () => {
  const now = 2_000_000_000_000
  const r = row()
  assert.equal(trackScannerEvidenceStale(r, now), true, 'never rechecked')
  r.market_observation_json = { trackIntelligence: { version: 1, events: [], snapshot: { observedAt: '', scannerObservedAt: new Date(now - 60_000).toISOString() } } } as never
  assert.equal(trackScannerEvidenceStale(r, now), false)
  assert.equal(trackScannerEvidenceStale(r, now + OUTCOME_POLICY.staleMs + 60_000), true)
  assert.ok(TRACK_SCANNER_RECHECKS_PER_REFRESH > 0 && TRACK_SCANNER_RECHECKS_PER_REFRESH <= 5)
  const svc = readFileSync(new URL('../lib/server/tokenOutcomeService.ts', import.meta.url), 'utf8')
  assert.match(svc, /opts\.scannerRecheck && trackScannerEvidenceStale\(row, now\) && rechecksLeft > 0/)
  const route = readFileSync(new URL('../app/api/token-outcomes/route.ts', import.meta.url), 'utf8')
  assert.match(route, /scannerRecheck: trackScannerRecheck\(\{ origin: new URL\(req\.url\)\.origin, authorization: req\.headers\.get\('authorization'\), userId: user\.userId \}\)/)
})
