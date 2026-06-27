import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  attemptConcentratedPositionProof,
  classifyConcentratedOwnerType,
  computeTopOwnerShare,
  computeLpExitRisk,
} from '../lib/server/lpProof.ts'
import { buildLpControllerIntel } from '../lib/server/lpControllerIntel.ts'

const VALID_STATUSES = new Set(['verified', 'partial', 'not_found', 'not_supported', 'failed', 'open_check'])

async function main() {
  // ── No pool address or pool ID at all → open_check, never fakes a pool ──────
  {
    const r = await attemptConcentratedPositionProof('eth', null, null, 'unknown', null)
    assert.equal(r.status, 'open_check')
    assert.equal(r.topPositionOwner, null, 'no fake position owner without a pool')
    assert.ok(VALID_STATUSES.has(r.status))
  }

  // ── Uniswap V4 (32-byte pool ID, no contract address), no resolver → real attempt, honest not_supported ──
  {
    const poolId = '0xdc55f2e5718fe52ebfcfde3a97d14d7d963c3c3a5000798596b7f1027ec84a9d'
    const r = await attemptConcentratedPositionProof('eth', null, poolId, 'pool_id', 'uniswap_v4')
    assert.equal(r.status, 'not_supported', 'V4 pool-id-only pool reports not_supported, not a fake result')
    assert.equal(r.poolModel, 'uniswap_v4')
    assert.equal(r.poolAddress, null, 'V4 pool IDs are not exposed as EVM pool contracts')
    assert.equal(r.poolId, poolId)
    assert.equal(r.poolIdentity, poolId)
    assert.equal(r.poolIdentityType, 'pool_id')
    assert.equal(r.topPositionOwner, null, 'never fakes a position owner when unsupported')
    assert.equal(r.lockedOrManagedPositionFound, null, 'never fakes locked/managed-position evidence')
    assert.ok(r.reason.toLowerCase().includes('could not be fully resolved'), 'reason explains ownership could not be fully resolved')
    assert.ok(Array.isArray(r.missingEvidence) && r.missingEvidence.length > 0)
    assert.notEqual(r.status, 'verified', 'never claims verified ownership for V4')
  }

  // ── Uniswap V4 dex hint inferred even without explicit "v4" in dexId, from pool-id shape ──
  {
    const poolId = '0x' + 'a'.repeat(64)
    const r = await attemptConcentratedPositionProof('base', null, poolId, 'pool_id', null)
    assert.equal(r.poolModel, 'uniswap_v4')
    assert.equal(r.status, 'not_supported')
  }

  // ── V3-style pool with a real contract address, no resolver → live RPC probe, never fakes "verified" ──
  {
    const poolAddr = '0x1234567890123456789012345678901234567890'
    const r = await attemptConcentratedPositionProof('eth', poolAddr, null, 'contract', 'uniswap_v3')
    assert.equal(r.poolModel, 'uniswap_v3')
    assert.ok(VALID_STATUSES.has(r.status))
    assert.notEqual(r.status, 'verified', 'no network/RPC available in test env — must never fabricate verified')
    assert.equal(r.topPositionOwner, null, 'no position owner fabricated without resolved RPC evidence')
    assert.equal(r.poolAddress, poolAddr)
    assert.equal(r.poolIdentity, poolAddr)
    assert.equal(r.poolIdentityType, 'contract')
  }

  // ── Aerodrome Slipstream (concentrated) dex hint classification ────────────
  {
    const r = await attemptConcentratedPositionProof('base', null, '0x' + 'b'.repeat(64), 'pool_id', 'aerodrome-slipstream')
    assert.equal(r.poolModel, 'slipstream')
    assert.equal(r.status, 'not_supported')
  }

  // ── V3 pool with a fixture resolver returning real owner records → verified ────────────────
  {
    const poolAddr = '0x2222222222222222222222222222222222222222'
    const fixtureOwners = [
      { address: '0x000000000000000000000000000000000000dead', liquidityRaw: '1000' },
      { address: '0x3333333333333333333333333333333333333333', liquidityRaw: '9000' },
    ]
    const r = await attemptConcentratedPositionProof('eth', poolAddr, null, 'contract', 'uniswap_v3', async () => fixtureOwners)
    assert.equal(r.status, 'verified', 'fixture-supplied owners produce a verified result')
    assert.equal(r.positionCount, 2)
    assert.equal(r.topPositionOwner, '0x3333333333333333333333333333333333333333')
    assert.ok(r.topPositionSharePercent > 50)
    assert.ok(Array.isArray(r.topOwners) && r.topOwners.length === 2)
    assert.equal(r.missingEvidence.length, 0)
  }

  // ── V3 pool with a fixture resolver that returns zero owners → partial, never fakes verified ──
  {
    const poolAddr = '0x4444444444444444444444444444444444444444'
    const r = await attemptConcentratedPositionProof('eth', poolAddr, null, 'contract', 'uniswap_v3', async () => [])
    assert.equal(r.status, 'partial', 'resolver queried but found nothing → partial, not verified')
    assert.equal(r.topPositionOwner, null)
  }

  // ── Uniswap V4 with a fixture resolver returning real owners → verified ────────────────────
  {
    const poolId = '0x' + 'c'.repeat(64)
    const fixtureOwners = [{ address: '0x5555555555555555555555555555555555555555', liquidityRaw: '500' }]
    const r = await attemptConcentratedPositionProof('eth', null, poolId, 'pool_id', 'uniswap_v4', async () => fixtureOwners)
    assert.equal(r.status, 'verified', 'V4 verified when a real position-owner source resolves owners')
    assert.equal(r.topPositionOwner, '0x5555555555555555555555555555555555555555')
    assert.equal(r.topPositionSharePercent, 100)
  }

  // ── Owner type classification: burn / known locker / contract via eth_getCode / unknown ───
  {
    assert.equal(await classifyConcentratedOwnerType('eth', '0x000000000000000000000000000000000000dead'), 'burn')
    assert.equal(await classifyConcentratedOwnerType('eth', '0x0000000000000000000000000000000000000000'), 'burn')
    assert.equal(await classifyConcentratedOwnerType('eth', '0x71b5759d73262fbb223956913ecf4ecc51057641'), 'locker')
    assert.equal(await classifyConcentratedOwnerType('eth', '0xc36442b4a4522e871399cd717abdd847ab11fe88'), 'protocol')
    // No RPC available in test env — falls through to "unknown" rather than fabricating wallet/contract.
    const t = await classifyConcentratedOwnerType('eth', '0x9999999999999999999999999999999999999999')
    assert.ok(['wallet', 'contract', 'unknown'].includes(t))
  }

  // ── Top owner share computation is pure and liquidity-weighted ─────────────────────────────
  {
    const result = computeTopOwnerShare([
      { address: '0xaaa', liquidityRaw: '300', ownerType: 'wallet' },
      { address: '0xbbb', liquidityRaw: '700', ownerType: 'contract' },
    ])
    assert.equal(result.topPositionOwner, '0xbbb')
    assert.equal(result.topPositionOwnerType, 'contract')
    assert.equal(result.topPositionSharePercent, 70)
    assert.equal(result.topOwners.length, 2)
  }

  // ── computeTopOwnerShare caps returned owners to 5 (public-API sanitization) ───────────────
  {
    const many = Array.from({ length: 9 }, (_, i) => ({ address: `0x${i}`, liquidityRaw: String(100 - i), ownerType: 'wallet' }))
    const result = computeTopOwnerShare(many)
    assert.ok(result.topOwners.length <= 5, 'topOwners is capped to 5')
  }

  // ── Controller intel labels reflect attempted concentrated proof results ──
  {
    const intel = buildLpControllerIntel({
      lpControl: { status: 'concentrated_liquidity', proofApplicability: 'not_applicable' },
      selectedPool: { model: 'concentrated', dex: 'Uniswap V4' },
      concentratedPositionProof: {
        status: 'not_supported',
        topPositionOwner: null,
        topPositionOwnerType: null,
        controllerRisk: 'unknown',
        reason: 'Uniswap V4 position ownership source not configured',
        poolModel: 'uniswap_v4',
        poolId: '0xdc55f2e5718fe52ebfcfde3a97d14d7d963c3c3a5000798596b7f1027ec84a9d',
        poolIdentity: '0xdc55f2e5718fe52ebfcfde3a97d14d7d963c3c3a5000798596b7f1027ec84a9d',
        poolIdentityType: 'pool_id',
      },
    })
    assert.equal(intel.controllerLabel, 'The largest liquidity owner could not be verified.')
    assert.equal(intel.controlProofLabel, 'The largest liquidity owner could not be verified for this Uniswap V4 pool.')
    assert.notEqual(intel.controllerLabel, 'Position verification required')
    assert.ok(intel.evidenceGaps.includes('the largest liquidity owner is not yet verified'))
    assert.ok(intel.evidenceGaps.includes('the number of active liquidity positions is not yet verified'))
    assert.equal(intel.controller, null, 'no fake verified position owner/controller')
    // V4 pool ID must never be exposed as poolAddress — only poolId/poolIdentity.
    assert.equal(intel.poolAddress, null, 'V4 pool ID is not a contract address')
    assert.equal(intel.poolIdentityType, 'pool_id')
    assert.notEqual(intel.controlProofLabel.includes('Uniswap V3'), true, 'V4 proof never mislabels as V3')
    assert.equal(intel.positionProofStatus, 'not_supported')
    assert.equal(intel.topPositionOwner, null)
  }

  // ── Controller intel evidenceGaps dedupe: when route.ts already supplied the structured
  // concentrated-position labels, the old generic duplicate wording must not also appear ──
  {
    const intel = buildLpControllerIntel({
      lpControl: { status: 'concentrated_liquidity', proofApplicability: 'not_applicable' },
      selectedPool: { model: 'concentrated', dex: 'Uniswap V4' },
      concentratedPositionProof: {
        status: 'not_supported',
        topPositionOwner: null,
        topPositionOwnerType: null,
        controllerRisk: 'unknown',
        reason: 'Uniswap V4 position ownership source not configured',
        poolModel: 'uniswap_v4',
        poolId: '0xdc55f2e5718fe52ebfcfde3a97d14d7d963c3c3a5000798596b7f1027ec84a9d',
        poolIdentity: '0xdc55f2e5718fe52ebfcfde3a97d14d7d963c3c3a5000798596b7f1027ec84a9d',
        poolIdentityType: 'pool_id',
      },
      lpEvidenceGaps: [
        { id: 'POSITION_MANAGER_UNSUPPORTED', label: 'Uniswap V4 concentrated position manager not supported yet' },
        { id: 'TOP_LIQUIDITY_OWNER_NOT_VERIFIED', label: 'Top liquidity owner not verified' },
        { id: 'ACTIVE_POSITIONS_NOT_INDEXED', label: 'Active liquidity positions not indexed' },
      ],
    })
    assert.deepEqual(intel.evidenceGaps, [
      'Uniswap V4 concentrated position manager not supported yet',
      'Top liquidity owner not verified',
      'Active liquidity positions not indexed',
    ], 'evidenceGaps contains only the new structured labels, no duplicate generic wording')
    assert.ok(!intel.evidenceGaps.includes('the largest liquidity owner is not yet verified'))
    assert.ok(!intel.evidenceGaps.includes('the number of active liquidity positions is not yet verified'))
    assert.ok(!intel.evidenceGaps.includes('protocol-specific liquidity position verification required'))
  }

  // ── VIRTUAL-like standard ERC20 LP (Aerodrome constant_product, not concentrated): structured
  // LOCK_STATUS_UNVERIFIED/BURN_PROOF_UNCONFIRMED/CONTROLLER_UNKNOWN gaps are humanized (no
  // all-caps public labels) and dedupe against the hardcoded open_check strings ──
  {
    const { buildEvidenceGaps } = await import('../lib/server/lpProof.ts')
    const gaps = buildEvidenceGaps({ lpLockStatus: 'unverified', lpController: 'unknown', proofApplicability: 'applicable' })
    const lpLockBurnControllerGaps = gaps.filter((g) => ['LOCK_STATUS_UNVERIFIED', 'BURN_PROOF_UNCONFIRMED', 'CONTROLLER_UNKNOWN'].includes(g.id))
    for (const gap of gaps) assert.ok(gap.label !== gap.label.toUpperCase() || !/[A-Z]/.test(gap.label), `public label "${gap.label}" is not all-caps`)
    assert.ok(gaps.some((g) => g.id === 'LOCK_STATUS_UNVERIFIED' && g.label === 'LP lock not confirmed'))
    assert.ok(gaps.some((g) => g.id === 'BURN_PROOF_UNCONFIRMED' && g.label === 'LP burn proof not confirmed'))
    assert.ok(gaps.some((g) => g.id === 'CONTROLLER_UNKNOWN' && g.label === 'LP controller not verified'))

    const intel = buildLpControllerIntel({
      lpControl: { status: 'open_check', proofApplicability: 'applicable' },
      selectedPool: { model: 'constant_product', dex: 'Aerodrome' },
      concentratedPositionProof: null,
      lpEvidenceGaps: lpLockBurnControllerGaps,
    })
    assert.deepEqual(intel.evidenceGaps, [
      'LP lock not confirmed',
      'LP burn proof not confirmed',
      'LP controller not verified',
    ], 'standard ERC20 LP evidenceGaps is deduped and humanized, no duplicate generic strings')
  }

  // ── Controller intel "verified" wording names the real top owner and share percent ─────────
  {
    const intel = buildLpControllerIntel({
      lpControl: { status: 'concentrated_liquidity', proofApplicability: 'not_applicable' },
      selectedPool: { model: 'concentrated', dex: 'Uniswap V3' },
      concentratedPositionProof: {
        status: 'verified',
        topPositionOwner: '0x3333333333333333333333333333333333333333',
        topPositionOwnerType: 'wallet',
        topPositionSharePercent: 82.5,
        controllerRisk: 'high',
        reason: 'Position ownership resolved.',
        poolModel: 'uniswap_v3',
        poolIdentity: '0x2222222222222222222222222222222222222222',
        poolIdentityType: 'contract',
      },
    })
    assert.equal(intel.controllerLabel, 'Liquidity ownership verified')
    assert.ok(intel.controlProofLabel.includes('Verified'))
    assert.ok(intel.controlProofLabel.includes('82.5'))
    assert.equal(intel.topPositionOwner, '0x3333333333333333333333333333333333333333')
    assert.equal(intel.topPositionSharePercent, 82.5)
    assert.equal(intel.controllerRisk, 'high')
  }

  // ── lpExitRiskReason names the real concentrated-pool protocol, never a generic V3/Slipstream guess ──
  {
    const result = computeLpExitRisk({
      proofApplicability: 'not_applicable',
      lpLockStatus: 'unknown',
      lpController: 'unknown',
      liquidityUsd: 138929,
      poolModel: 'concentrated',
      hasPool: true,
      concentratedPoolModel: 'uniswap_v4',
      positionOwnershipUnresolved: true,
    })
    assert.ok(result.lpExitRiskReason.includes('Uniswap V4 concentrated-liquidity pool'), 'names Uniswap V4, not generic V3/Slipstream')
    assert.ok(!result.lpExitRiskReason.includes('V3/Slipstream'), 'never uses the generic V3/Slipstream guess when the model is known')
    assert.ok(result.lpExitRiskReason.includes('unresolved position ownership'), 'flags unresolved position ownership')
  }

  // ── Exit risk reflects a real verified dominant-wallet controller finding (high) ───────────
  {
    const result = computeLpExitRisk({
      proofApplicability: 'not_applicable',
      lpLockStatus: 'unknown',
      lpController: 'unknown',
      liquidityUsd: 138929,
      poolModel: 'concentrated',
      hasPool: true,
      concentratedPoolModel: 'uniswap_v3',
      positionOwnershipUnresolved: false,
      concentratedControllerRisk: 'high',
    })
    assert.equal(result.lpExitRisk, 'high')
    assert.ok(result.lpExitRiskReason.includes('single normal wallet controls'))
  }

  // ── Public API + UI: no raw field names, no V4/V2 contradictions, exact status labels ──────
  {
    const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
    const ui = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
    assert.ok(route.includes('On Ethereum: this token’s primary pool is concentrated liquidity'))
    assert.ok(!route.includes('On Ethereum: standard v2 LP patterns apply. Renounce events') || route.includes('_selectedPoolIsConcentratedForCtx'))
    assert.ok(ui.includes('Uniswap V4 Concentrated'))
    assert.ok(!ui.includes("/uniswap/i.test(dex)) return 'V3 Concentrated Liquidity'"))
    for (const raw of ['positionManager', 'topPositionOwner', 'positionCount']) {
      assert.ok(route.includes('humanizeConcentratedMissingEvidence'), `route humanizes ${raw}`)
    }
    assert.ok(!ui.includes("Position verification required' : cleanStatusLabel(ci?.status)"), 'UI no longer renders only required for protocol controller')
    assert.ok(route.includes('Uniswap V4 Concentrated Liquidity'), 'riskEngine labels V4 concentrated pools correctly')
    assert.ok(!route.includes('return "v3"  // treat V4 as concentrated'), 'detectPoolType no longer mislabels V4 as v3')
    assert.ok(ui.includes('position ownership is not supported yet'), 'UI control-proof wording matches the poolModel-aware not_supported text')
    assert.ok(!ui.includes('current provider path'), 'UI never leaks backend "current provider path" wording')
    assert.ok(!route.includes('current provider path'), 'route.ts never leaks backend "current provider path" wording')
    assert.ok(ui.includes('Attempted — verified'), 'UI uses exact verified status label, not raw snake_case')
    assert.ok(ui.includes('Attempted — partial'), 'UI uses exact partial status label')
    assert.ok(ui.includes('Attempted — unsupported'), 'UI uses exact unsupported status label')
    assert.ok(!ui.includes('Not attempted — no concentrated pool detected'), 'UI never claims no concentrated pool was detected when a concentrated pool WAS detected')
    assert.ok(ui.includes('Open Check — concentrated pool detected, position ownership proof pending'), 'UI uses correct pending copy for concentrated pools without a resolved proof yet')
    assert.ok(route.includes('positionProofStatus'), 'public lpControl exposes positionProofStatus')
    assert.ok(route.includes('positionProofReason'), 'public lpControl exposes positionProofReason')
  }

  // ── Canonical concentratedPositionProofRead never claims fake ownership and always carries
  // the required summary/evidenceGaps/nextActions shape when V1 proof is still an open check ──
  {
    const { buildConcentratedPositionProofRead } = await import('../lib/server/lpProof.ts')
    const proof = await attemptConcentratedPositionProof('eth', null, '0x' + 'd'.repeat(64), 'pool_id', 'uniswap_v4')
    const read = buildConcentratedPositionProofRead(proof, { protocol: 'uniswap_v4', poolPair: 'TOKEN/WETH' })
    assert.equal(read.proofType, 'concentrated_position')
    assert.equal(read.positionOwnershipStatus, 'open_check')
    assert.equal(read.summary, 'Concentrated pool detected; position ownership proof is not yet verified.')
    assert.ok(Array.isArray(read.evidenceGaps) && read.evidenceGaps.length > 0)
    assert.ok(Array.isArray(read.nextActions) && read.nextActions.length > 0)
    assert.equal(read.protocol, 'uniswap_v4')
    assert.equal(read.poolPair, 'TOKEN/WETH')
  }

  // ── Canonical read reflects a real verified proof rather than re-flattening to open_check ──
  {
    const poolAddr = '0x6666666666666666666666666666666666666666'
    const fixtureOwners = [{ address: '0x7777777777777777777777777777777777777777', liquidityRaw: '1000' }]
    const proof = await attemptConcentratedPositionProof('eth', poolAddr, null, 'contract', 'uniswap_v3', async () => fixtureOwners)
    const { buildConcentratedPositionProofRead } = await import('../lib/server/lpProof.ts')
    const read = buildConcentratedPositionProofRead(proof)
    assert.equal(read.positionOwnershipStatus, 'verified')
    assert.equal(read.summary, proof.reason)
  }

  // ── concentratedPositionProofRead.evidenceGaps never leaks raw backend keys; uses humanized,
  // protocol-aware wording instead (Task 14 Patch 2) ──
  {
    const { buildConcentratedPositionProofRead } = await import('../lib/server/lpProof.ts')
    const v4Proof = await attemptConcentratedPositionProof('eth', null, '0x' + 'd'.repeat(64), 'pool_id', 'uniswap_v4')
    const v4Read = buildConcentratedPositionProofRead(v4Proof, { protocol: 'uniswap_v4', poolPair: 'TOKEN/WETH' })
    for (const rawKey of ['positionManager', 'topPositionOwner', 'positionCount', 'topPositionSharePercent', 'positionLiquidityShare']) {
      assert.ok(!v4Read.evidenceGaps.includes(rawKey), `evidenceGaps never exposes raw key "${rawKey}"`)
    }
    assert.ok(v4Read.evidenceGaps.some((g) => g.includes('Uniswap V4 concentrated position manager not supported yet')), 'V4 evidenceGaps uses protocol-specific position manager wording')
    assert.ok(v4Read.evidenceGaps.some((g) => g === 'Top liquidity owner not verified'), 'evidenceGaps uses humanized top-owner wording')
    assert.ok(v4Read.evidenceGaps.some((g) => g === 'Active liquidity positions not indexed'), 'evidenceGaps uses humanized position-count wording')

    const slipProof = await attemptConcentratedPositionProof('base', '0x' + '2'.repeat(40), null, 'contract', 'slipstream')
    const slipRead = buildConcentratedPositionProofRead(slipProof)
    assert.ok(!slipRead.evidenceGaps.some((g) => g.includes('Uniswap V4')), 'non-V4 protocol never gets V4-specific wording')
    assert.ok(!slipRead.evidenceGaps.some((g) => /positionManager|topPositionOwner|positionCount|topPositionSharePercent|positionLiquidityShare/.test(g)), 'non-V4 evidenceGaps never leaks raw backend keys either')
  }

  // ── route.ts never leaves concentratedPositionProof null when the primary pool is eligible ──
  {
    const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
    assert.ok(route.includes('_primaryConcentrated && !concentratedPositionProof'), 'safety-net fallback attempts the proof whenever the primary pool is concentrated but no earlier branch ran it')
    assert.ok(route.includes('concentratedPositionProofRead'), 'route exposes the canonical concentratedPositionProofRead')
  }

  // ── BRETT-like Uniswap V3 on Base, positionManager resolved, no owner attributable yet:
  // missingEvidence must NOT include "positionManager" once it's resolved (Task 15 Patch 1) ──
  {
    const poolAddr = '0x8888888888888888888888888888888888888888'
    const r = await attemptConcentratedPositionProof('base', poolAddr, null, 'contract', 'uniswap_v3', async () => [])
    assert.equal(r.status, 'partial')
    assert.ok(r.positionManager != null, 'Base Uniswap V3 position manager resolves from the verified registry')
    assert.ok(!r.missingEvidence.includes('positionManager'), 'missingEvidence excludes positionManager once it resolves')
    assert.ok(r.missingEvidence.includes('topPositionOwner') && r.missingEvidence.includes('positionCount'), 'remaining ownership gaps are still reported')
    assert.equal(r.topPositionOwner, null, 'never fakes a top owner')
    assert.equal(r.positionCount, null, 'never fakes a position count')

    const { buildConcentratedPositionProofRead } = await import('../lib/server/lpProof.ts')
    const read = buildConcentratedPositionProofRead(r, { protocol: 'uniswap_v3', poolPair: 'BRETT/WETH' })
    assert.ok(!read.evidenceGaps.some((g) => /position manager not supported yet/i.test(g)), 'concentratedPositionProofRead never claims the resolved manager is unsupported')
    assert.ok(read.evidenceGaps.some((g) => g === 'Top liquidity owner not verified'))
    assert.ok(read.evidenceGaps.some((g) => g === 'Active liquidity positions not indexed'))
  }

  // ── DUAL-like Uniswap V4 with null positionManager: still reports V4 unsupported manager
  // wording unchanged (Task 15 Patch 6 regression guard) ──
  {
    const poolId = '0x' + 'e'.repeat(64)
    const r = await attemptConcentratedPositionProof('eth', null, poolId, 'pool_id', 'uniswap_v4')
    assert.equal(r.positionManager, null, 'V4 has no verified position-manager registry entry')
    assert.ok(r.missingEvidence.includes('positionManager'), 'V4 missingEvidence still includes positionManager when unresolved')

    const { buildConcentratedPositionProofRead } = await import('../lib/server/lpProof.ts')
    const read = buildConcentratedPositionProofRead(r, { protocol: 'uniswap_v4', poolPair: 'DUAL/WETH' })
    assert.ok(read.evidenceGaps.some((g) => g.includes('Uniswap V4 concentrated position manager not supported yet')), 'V4 unsupported-manager wording is unchanged')
  }

  // ── lpControllerIntel: BRETT-like resolved-manager evidenceGaps are deduped and never mention
  // an unsupported manager (Task 15 Patch 5) ──
  {
    const poolAddr = '0x9999999999999999999999999999999999999999'
    const proof = await attemptConcentratedPositionProof('base', poolAddr, null, 'contract', 'uniswap_v3', async () => [])
    const intel = buildLpControllerIntel({
      lpControl: { status: 'concentrated_liquidity', proofApplicability: 'not_applicable' },
      selectedPool: { model: 'concentrated', dex: 'Uniswap V3' },
      concentratedPositionProof: {
        status: proof.status,
        topPositionOwner: proof.topPositionOwner,
        topPositionOwnerType: proof.topPositionOwnerType,
        controllerRisk: proof.controllerRisk,
        reason: proof.reason,
        poolModel: proof.poolModel,
        poolAddress: proof.poolAddress,
        poolIdentity: proof.poolIdentity,
        poolIdentityType: proof.poolIdentityType,
      },
      lpEvidenceGaps: [
        { id: 'TOP_LIQUIDITY_OWNER_NOT_VERIFIED', label: 'Top liquidity owner not verified' },
        { id: 'ACTIVE_POSITIONS_NOT_INDEXED', label: 'Active liquidity positions not indexed' },
        { id: 'POSITION_LIQUIDITY_SHARE_NOT_AVAILABLE', label: 'Position liquidity share not available' },
      ],
    })
    assert.ok(!intel.evidenceGaps.some((g) => /not supported yet/i.test(g)), 'lpControllerIntel evidenceGaps never mention an unsupported manager once resolved')
    const dedupedCount = intel.evidenceGaps.filter((g) => g === 'Top liquidity owner not verified').length
    assert.ok(dedupedCount <= 1, 'evidenceGaps are deduped, not repeated')
  }

  // ── secondaryLpControlSignals must never report status="concentrated_liquidity" for a V2/
  // Aerodrome secondary pool, even when the primary lpControl was already overwritten to
  // concentrated_liquidity before reconciliation runs (Task 15 Patch 7 — BRETT regression).
  // lib/server/lpIntelligence.ts can't be live-imported from a plain .mjs test (Node's native
  // TS type-stripping requires explicit file extensions on its relative imports, e.g. `./lpProof`
  // resolves under tsc/Next.js but not under `node`), so this is a static source-pattern check
  // mirroring the same convention used by scripts/test-lp-intelligence.mjs ──
  {
    const intel = readFileSync(new URL('../lib/server/lpIntelligence.ts', import.meta.url), 'utf8')
    assert.ok(intel.includes('secondarySource?:'), 'reconcileSecondaryLpSignal accepts a pre-overwrite secondarySource snapshot')
    assert.ok(intel.includes("const _source = secondarySource ?? lpControl"), 'secondary signal prefers the pre-overwrite snapshot over the (possibly already-overwritten) live lpControl')
    assert.ok(/_source\.status === 'concentrated_liquidity' \|\| _source\.status === 'protocol'\) \? 'open_check'/.test(intel), 'secondary status can never be concentrated_liquidity/protocol — falls back to open_check')
    assert.ok(/_source\.status === 'team_controlled' \? 'wallet_controlled'/.test(intel), "secondary 'team_controlled' is reported as wallet_controlled — secondary holder checks can't verify a team/contract entity")
    assert.ok(!/status: lpControl\.status,/.test(intel), 'the old blind lpControl.status copy into the secondary signal is gone')

    const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
    assert.ok(route.includes('_preOverwriteLpControlSnapshot'), 'route.ts snapshots lpControl before the concentrated-liquidity safety net can overwrite it')
    assert.ok(route.includes('secondarySource: _preOverwriteLpControlSnapshot'), 'route.ts passes the pre-overwrite snapshot into reconcileSecondaryLpSignal')
    assert.ok(route.includes('"wallet_controlled"') || route.includes("'wallet_controlled'"), 'wallet_controlled is a valid LpControlResult/secondaryLpControlSignals status')
    assert.ok(!/'team_controlled' : 'partial',\s*\n\s*confidence: \(topHolder\.pct \?\? 0\) >= 80 \? 'high' : 'low',\s*\n\s*reason: "Secondary pool LP-holder evidence/.test(route), '_classifySecondaryLpHolders no longer returns team_controlled for secondary dominant-holder evidence')
    assert.ok(/status: \(topHolder\.pct \?\? 0\) >= 80 \? 'wallet_controlled' : 'partial',\s*\n\s*confidence: \(topHolder\.pct \?\? 0\) >= 80 \? 'high' : 'low',\s*\n\s*reason: "Secondary pool LP-holder evidence/.test(route), '_classifySecondaryLpHolders dominant-holder branch reports wallet_controlled')
  }

  // ── V2/Aerodrome standard LP (non-concentrated) pools never get a positionManager-resolved
  // path applied to them — positionManager stays null since only uniswap_v3 resolves one ──
  {
    const r = await attemptConcentratedPositionProof('base', null, null, 'unknown', 'aerodrome')
    assert.equal(r.positionManager, null, 'non-Uniswap-V3 protocols never get a guessed position manager')
  }

  console.log('test-concentrated-position-proof.mjs: all assertions passed')
}

main()
