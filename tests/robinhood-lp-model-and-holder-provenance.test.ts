// Regression coverage for two Robinhood Token Scanner findings (swappy report):
//   LP: a bare "uniswap" dex id was defaulted to V2 by detectPoolType() and the on-chain
//       V2-vs-concentrated probe never ran, so a possibly-concentrated pool was sent into
//       ERC-20 LP-holder lock/burn proof.
//   Holders: an exact provider holder total carried no source/as-of time, so a gap against
//       another indexer's figure (DexScreener) could not be attributed to freshness.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isUnversionedDexLabel, shouldProbePoolModelByRpc, detectKnownLpProtocol } from '../lib/lpSafetyResolution.ts'
import { classifyPoolModel } from '../lib/server/lpProof.ts'
import { resolveRobinhoodLpProof } from '../lib/server/robinhoodLpProof.ts'
import { formatHolderCountDisplay, holderCountBasisFor, holderCountProvenance, PROVIDER_TOTAL_NOTE } from '../lib/tokenScannerHolderCount.ts'

const POOL = '0x' + 'ab'.repeat(20)
const TOKEN = '0x' + '29'.repeat(20)
const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')

// ── LP: pool-model dispatch ─────────────────────────────────────────────────────────────

test('unversioned DEX labels are protocol families, not pool-model evidence', () => {
  assert.equal(isUnversionedDexLabel('uniswap'), true)
  assert.equal(isUnversionedDexLabel('pancakeswap'), true)
  assert.equal(isUnversionedDexLabel('uniswap', 'Uniswap'), true)
  for (const versioned of ['uniswap-v2', 'uniswap_v3', 'uniswap-v4-robinhood', 'pancakeswap-v3']) {
    assert.equal(isUnversionedDexLabel(versioned), false, versioned)
  }
  assert.equal(isUnversionedDexLabel(null), false)
  assert.equal(isUnversionedDexLabel('curve'), false)
})

test('Robinhood: a v2 type backed only by a bare "uniswap" label is RPC-probed before ERC-20 LP proof', () => {
  assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'v2', address: POOL, dexId: 'uniswap' }), true)
  assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'v2', address: POOL, dexId: 'uniswap', dexName: 'Uniswap' }), true)
})

test('probe gate does not widen for versioned labels, other chains, or non-contract pool ids (provider budget unchanged)', () => {
  assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'v2', address: POOL, dexId: 'uniswap-v2' }), false)
  assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'concentrated', address: POOL, dexId: 'uniswap' }), false)
  assert.equal(shouldProbePoolModelByRpc({ chain: 'base', poolType: 'v2', address: POOL, dexId: 'uniswap' }), false)
  assert.equal(shouldProbePoolModelByRpc({ chain: 'eth', poolType: 'v2', address: POOL, dexId: 'uniswap' }), false)
  assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'v2', address: '0x' + 'ab'.repeat(32), dexId: 'uniswap' }), false)
  assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'v2', address: null, dexId: 'uniswap' }), false)
})

test('unknown pool models are still probed on every supported chain (existing behavior)', () => {
  for (const chain of ['eth', 'base', 'bnb', 'robinhood']) {
    assert.equal(shouldProbePoolModelByRpc({ chain, poolType: 'unknown', address: POOL, dexId: null }), true, chain)
  }
})

test('route wires the probe gate and keeps the v2 default when the probe cannot resolve', () => {
  assert.match(route, /shouldProbePoolModelByRpc\(\{ chain, poolType: _rpcProbePool\.poolType, address: _rpcProbePool\.address, dexId: _rpcProbePool\.dexId, dexName: _rpcProbePool\.dexName \}\)/)
  // Only a resolved probe overrides the pool type; an unresolved probe leaves the prior type.
  assert.match(route, /if \(_rpcCls\.poolType !== 'unknown'\) \{\s*_rpcProbePool\.poolType = _rpcCls\.poolType/)
})

test('an RPC-confirmed concentrated pool with a bare label is modelled concentrated, never constant-product', () => {
  assert.equal(classifyPoolModel('uniswap').poolModel, 'constant_product', 'bare label alone is unchanged')
  const confirmed = classifyPoolModel('uniswap-concentrated')
  assert.equal(confirmed.poolModel, 'concentrated')
  assert.equal(confirmed.standardLockApplies, false)
  assert.equal(confirmed.proofAddressType, 'nft_position')
  assert.match(route, /_lpModelRpcConcentrated = lpPoolType === "concentrated" && _fallbackRpcModel === "concentrated" && isUnversionedDexLabel\(lpDexId, lpDexName\)/)
  // The displayed DEX name stays the provider label.
  assert.match(route, /_deriveLpModelProof\(`\$\{lpDexId\}-concentrated`\), dexName: lpDexId \}/)
})

test('versioned Uniswap labels still classify directly without a probe', () => {
  assert.equal(detectKnownLpProtocol({ dex: 'uniswap-v3' }).poolType, 'v3')
  assert.equal(detectKnownLpProtocol({ dex: 'uniswap-v4' }).poolType, 'concentrated')
  assert.equal(detectKnownLpProtocol({ dex: 'uniswap-v2' }).poolType, 'v2')
  assert.equal(detectKnownLpProtocol({ dex: 'uniswap' }).detector, 'unversioned_dex_metadata')
})

test('concentrated Robinhood pools never go through ERC-20 LP-holder proof or claim verified control', async () => {
  for (const input of [
    { concentrated: true, poolType: 'concentrated' },
    { concentrated: false, poolType: 'v4' },
    { concentrated: false, poolType: 'v3' },
  ]) {
    const result = await resolveRobinhoodLpProof({
      tokenAddress: TOKEN, poolAddress: POOL, pairAddress: POOL, lpTokenAddress: POOL,
      dex: 'uniswap', poolType: input.poolType, liquidityUsd: 147_430, createdAt: null,
      poolChainHint: 'robinhood', concentrated: input.concentrated, skipNetwork: true,
      // Rows that WOULD read as a 100% burn if (wrongly) treated as ERC-20 LP holders.
      existingHolderRows: [{ address: '0x000000000000000000000000000000000000dead', balanceRaw: '100', pct: 100, isContract: false }],
    })
    assert.equal(result.lpHolderRows.length, 0, input.poolType)
    assert.equal(result.lpControlOverlay, null, input.poolType)
    assert.notEqual(result.classification, 'verified_burned', input.poolType)
    assert.equal(result.copy.lockLabel, 'Lock/burn proof not applicable to ERC-20 LP tokens')
    assert.equal(result.copy.positionOwnerProof, 'unavailable', 'a resolved pool is not position-ownership proof')
    assert.equal(result.blockscoutFallbackDecisionAudit.blockscoutAttempted, false)
  }
})

test('unchanged evidence gives unchanged V2 LP classification (no downstream risk drift)', async () => {
  const run = () => resolveRobinhoodLpProof({
    tokenAddress: TOKEN, poolAddress: POOL, pairAddress: POOL, lpTokenAddress: POOL,
    dex: 'uniswap-v2', poolType: 'v2', liquidityUsd: 147_430, createdAt: null,
    poolChainHint: 'robinhood', concentrated: false, skipNetwork: true,
    existingHolderRows: [{ address: '0x000000000000000000000000000000000000dead', balanceRaw: '995', pct: 99.5, isContract: false }],
    existingTotalSupplyRaw: '1000',
  })
  const [a, b] = [await run(), await run()]
  assert.equal(a.classification, 'verified_burned')
  assert.deepEqual(
    { c: b.classification, r: b.reason, o: b.lpControlOverlay?.status },
    { c: a.classification, r: a.reason, o: a.lpControlOverlay?.status },
  )
})

test('missing LP evidence stays unavailable/partial with a concrete reason, never verified', async () => {
  const result = await resolveRobinhoodLpProof({
    tokenAddress: TOKEN, poolAddress: POOL, pairAddress: POOL, lpTokenAddress: POOL,
    dex: 'uniswap', poolType: 'v2', liquidityUsd: 147_430, createdAt: null,
    poolChainHint: 'robinhood', concentrated: false, skipNetwork: true, existingHolderRows: [],
  })
  assert.ok(['unavailable_with_reason', 'partial_evidence'].includes(result.classification))
  assert.ok(result.reason.length > 0)
  assert.notEqual(result.lpControlOverlay?.status, 'burned')
  assert.notEqual(result.lpControlOverlay?.status, 'locked')
})

// ── Holders: count provenance and count-vs-concentration independence ──────────────────

test('holder count provenance mirrors the route selection order and records provider response time + basis', () => {
  const goldrush = { data: { updated_at: '2026-09-22T10:15:00Z', pagination: { total_count: 2061 } }, __chainUsed: '4663' }
  assert.deepEqual(holderCountProvenance(goldrush, { total: 9999 }), {
    provider: 'goldrush', chainIdentifier: '4663', exactMeaning: 'exact_provider_reported_total',
    holderCountBasis: 'provider_total_unsupported_chain',
    providerResponseAt: '2026-09-22T10:15:00Z', providerUpdatedAt: '2026-09-22T10:15:00Z', providerTotal: 2061,
  })
  assert.deepEqual(holderCountProvenance({ pagination: { total_count: 12 }, __chainUsed: 'robinhood-mainnet' }, null), {
    provider: 'goldrush', chainIdentifier: 'robinhood-mainnet', exactMeaning: 'exact_provider_reported_total',
    holderCountBasis: 'provider_total_unsupported_chain',
    providerResponseAt: null, providerUpdatedAt: null, providerTotal: 12,
  })
  assert.deepEqual(holderCountProvenance({ data: { items: [] } }, { total: 40 }), {
    provider: 'moralis', chainIdentifier: null, exactMeaning: 'exact_provider_reported_total',
    holderCountBasis: 'provider_total_support_unverified',
    providerResponseAt: null, providerUpdatedAt: null, providerTotal: 40,
  })
  assert.deepEqual(holderCountProvenance(null, null), {
    provider: null, chainIdentifier: null, exactMeaning: null, holderCountBasis: null,
    providerResponseAt: null, providerUpdatedAt: null, providerTotal: null,
  })
  // Same selection expression the route uses for holderCount itself.
  assert.match(route, /holdersRaw\?\.data\?\.pagination\?\.total_count \?\? holdersRaw\?\.pagination\?\.total_count \?\? moralisHoldersRaw\?\.total \?\? null/)
})

test('ICE TEA Robinhood fixture: provider total basis is unsupported-chain; count unchanged; UI says Provider total', () => {
  const raw = { data: { updated_at: '2026-09-25T03:29:22.994293461Z', pagination: { total_count: 374 }, items: [] }, __chainUsed: 'robinhood-mainnet' }
  const prov = holderCountProvenance(raw, null)
  assert.equal(prov.holderCountBasis, 'provider_total_unsupported_chain')
  assert.equal(prov.providerTotal, 374)
  assert.equal(prov.providerResponseAt, '2026-09-25T03:29:22.994293461Z')
  assert.equal(prov.providerUpdatedAt, prov.providerResponseAt, 'deprecated alias kept for API compatibility')
  const shown = formatHolderCountDisplay({ holderCount: 374, holderCountReason: 'holder_count_from_provider_total', holderRowsReturned: 99, holderCountBasis: prov.holderCountBasis })
  assert.equal(shown.holderCount, 374)
  assert.equal(shown.exact, true, 'exact = exact provider-reported total')
  assert.equal(shown.display, '374 · Provider total')
  assert.equal(shown.note, PROVIDER_TOTAL_NOTE)
  assert.equal(shown.usableForConcentration, false)
  assert.equal(shown.concentrationStatus, 'not_checked')
  assert.doesNotMatch(shown.display, /exact/i)
})

test('ETH ASTEROID fixture: documented snapshot chain keeps strong wording and the same count', () => {
  const raw = { data: { updated_at: '2026-09-25T03:13:15Z', pagination: { total_count: 3545 } }, __chainUsed: 'eth-mainnet' }
  const prov = holderCountProvenance(raw, null)
  assert.equal(prov.holderCountBasis, 'provider_total_supported_chain')
  for (const id of ['base-mainnet', 'bsc-mainnet']) assert.equal(holderCountBasisFor('goldrush', id), 'provider_total_supported_chain')
  const shown = formatHolderCountDisplay({ holderCount: 3545, holderCountReason: 'holder_count_from_provider_total', holderRowsReturned: 99, holderCountBasis: prov.holderCountBasis })
  assert.equal(shown.display, '3,545')
  assert.equal(shown.note, null)
  assert.equal(shown.holderCount, 3545)
})

test('wording-only change: basis never alters counts, routing expressions, or legacy (no-basis) display', () => {
  for (const basis of [undefined, null, 'provider_total_supported_chain', 'provider_total_unsupported_chain', 'provider_total_support_unverified'] as const) {
    const d = formatHolderCountDisplay({ holderCount: 2061, holderCountReason: 'holder_count_from_provider_total', holderRowsReturned: 100, holderCountBasis: basis })
    assert.equal(d.holderCount, 2061)
    assert.equal(d.exact, true)
    assert.equal(d.usableForConcentration, false)
    const rows = formatHolderCountDisplay({ holderCount: 50, holderCountReason: 'holder_count_from_normalized_rows', holderRowsReturned: 50, holderCountBasis: basis })
    assert.equal(rows.display, '50+')
  }
  assert.equal(formatHolderCountDisplay({ holderCount: 2061, holderCountReason: 'holder_count_from_provider_total' }).display, '2,061')
  // Exactness now comes from resolveHolderCountSemantics (exact only for a provider total).
  assert.match(route, /const holderCountExact = _holderCountSemantics\.holderCountExact/)
  assert.match(route, /robinhood: \['robinhood-mainnet', '4663'\]/)
  assert.match(route, /eth: \['eth-mainnet'\]/)
})

test('provenance is attached only to an exact provider total and survives the reconstruction reassignment', () => {
  assert.match(route, /holderCountProvenanceValue = holderCountExact \? holderCountProvenance\(holdersRaw, moralisHoldersRaw\) : null/)
  const occurrences = route.match(/holderCountProvenance: holderCountProvenanceValue/g) ?? []
  assert.equal(occurrences.length, 3)
})

test('an exact holder count is never concentration evidence; top-N rows are never a holder total', () => {
  const exact = formatHolderCountDisplay({ holderCount: 2061, holderCountReason: 'holder_count_from_provider_total', holderRowsReturned: 100 })
  assert.equal(exact.display, '2,061')
  assert.equal(exact.exact, true)
  assert.equal(exact.usableForConcentration, false)
  // Route fallback: holderCount = normalizedTop.length with a rows reason.
  const rows = formatHolderCountDisplay({ holderCount: 50, holderCountReason: 'holder_count_from_normalized_rows', holderRowsReturned: 50 })
  assert.equal(rows.exact, false)
  assert.match(rows.display, /\+$/, 'row count is shown as a lower bound, not a total')
})

test('Top1/5/10/20 are summed from ranked holder rows, independent of the holder total', () => {
  assert.match(route, /const sum = \(n: number\) => topHolders\.slice\(0, n\)\.reduce/)
  assert.match(route, /let top1 = hasPct \? sum\(1\) : null\s*let top5 = hasPct \? sum\(5\) : null\s*let top10 = hasPct \? sum\(10\) : null\s*let top20 = hasPct \? sum\(20\) : null/)
})
