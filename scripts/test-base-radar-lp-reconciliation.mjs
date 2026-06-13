/**
 * Test for the Base Radar LP model reconciliation helper
 * (lib/server/baseRadarLpReconciliation.ts).
 *
 * Re-implements the pure reconciliation logic in plain JS (mirroring
 * lib/server/baseRadarLpReconciliation.ts) so it can run without a TS loader,
 * and exercises:
 *  - Section A: BIT COCK-style fixture — conflicting concentrated/constant_product
 *    signals and a "secondary" pool that is actually the primary pool.
 *  - Section B: VIRTUAL-style standard ERC-20 LP — remains erc20_lp_token /
 *    constant_product and still shows standard LP verification.
 *  - Section C: PLAY/MFERGPT-style concentrated primary with a real, different
 *    secondary pool — secondary exposure still shown correctly.
 *
 * Run: node scripts/test-base-radar-lp-reconciliation.mjs
 */

let passed = 0
let failed = 0

function assert(label, condition, got) {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${label} — got: ${JSON.stringify(got)}`)
    failed++
  }
}

// ─── Mirrors lib/server/baseRadarLpReconciliation.ts ───────────────────────

function normalizeModelToken(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const v = value.trim().toLowerCase()
  if (['concentrated_liquidity', 'concentrated', 'v3', 'v4', 'slipstream', 'clmm'].some((k) => v === k || v.includes(k))) {
    return 'concentrated_liquidity'
  }
  if (['erc20_lp_token', 'constant_product', 'v2', 'aerodrome_v2', 'aerodrome', 'stableswap'].some((k) => v === k || v.includes(k))) {
    return 'erc20_lp_token'
  }
  return null
}

function reconcileLpModel(sources) {
  for (const source of sources) {
    const model = normalizeModelToken(source)
    if (model) return model
  }
  return 'unknown'
}

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asAddress(value) {
  const s = asString(value)
  return s && /^0x[a-fA-F0-9]{40}$/.test(s) ? s.toLowerCase() : null
}

function extractEvidenceValue(evidence, prefix) {
  const line = evidence.find((e) => e.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : null
}

function formatDexLabelMirror(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (/^v\d+$/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ')
}

function sanitizeConcentratedCortexText(text) {
  if (!/constant[\s_-]?product/i.test(text)) return text
  return text.replace(
    /[^.!?]*constant[\s_-]?product[^.!?]*[.!?]?/gi,
    'This pool uses a concentrated-liquidity model; standard ERC-20 LP lock/burn proof does not apply, and liquidity control requires protocol-specific position checks.',
  )
}

// Mirrors extractLpControllerSharePercent in lib/baseRadarSeverity.ts
function extractLpControllerSharePercent(evidence) {
  if (!Array.isArray(evidence)) return null
  for (const key of ['owner_lp_share', 'top_share', 'locker_share', 'burn_share']) {
    const line = evidence.find((item) => item.toLowerCase().startsWith(`${key}=`))
    if (line) {
      const value = Number(line.split('=').slice(1).join('=').replace('%', ''))
      if (Number.isFinite(value)) return Math.round(value * 100) / 100
    }
  }
  return null
}

function reconcileBaseRadarLp(scan) {
  const lpControl = scan.lpControl && typeof scan.lpControl === 'object' ? scan.lpControl : {}
  const evidence = Array.isArray(lpControl.evidence) ? [...lpControl.evidence] : []
  const lpModelProofRaw = scan.lpModelProof && typeof scan.lpModelProof === 'object' ? scan.lpModelProof : null

  const displayLpModel = reconcileLpModel([
    lpControl.displayLpModel,
    scan.displayLpModel,
    scan.lpControlRead?.selectedPoolModel,
    lpControl.primaryPoolType,
    lpModelProofRaw?.model,
  ])

  let proofApplicability
  let lockBurnApplicable
  let standardLockApplies
  let lpModelProofModel

  if (displayLpModel === 'concentrated_liquidity') {
    proofApplicability = 'not_applicable'
    lockBurnApplicable = false
    standardLockApplies = false
    lpModelProofModel = 'concentrated'
  } else if (displayLpModel === 'erc20_lp_token') {
    proofApplicability = 'applicable'
    lockBurnApplicable = true
    standardLockApplies = true
    const existing = asString(lpModelProofRaw?.model)
    lpModelProofModel = existing && existing.toLowerCase() !== 'concentrated' ? existing : 'constant_product'
  } else {
    proofApplicability = typeof lpControl.proofApplicability === 'string' ? lpControl.proofApplicability : 'unknown'
    lockBurnApplicable = Boolean(lpControl.lockBurnApplicable)
    standardLockApplies = Boolean(lpModelProofRaw?.standardLockApplies)
    lpModelProofModel = asString(lpModelProofRaw?.model) ?? 'unknown'
  }

  const lpModelProof = lpModelProofRaw
    ? { model: lpModelProofModel, dexName: asString(lpModelProofRaw.dexName), standardLockApplies }
    : null

  let lpEvidenceSummary = Array.isArray(scan.lpEvidenceSummary) ? [...scan.lpEvidenceSummary] : null
  if (lpEvidenceSummary) {
    lpEvidenceSummary = lpEvidenceSummary.map((line) =>
      /^Pool model:/i.test(line) ? `Pool model: ${lpModelProofModel}` : line,
    )
  }

  let cortexLpRead = scan.cortexLpRead && typeof scan.cortexLpRead === 'object' ? { ...scan.cortexLpRead } : null
  if (cortexLpRead && displayLpModel === 'concentrated_liquidity') {
    for (const [key, value] of Object.entries(cortexLpRead)) {
      if (typeof value === 'string') cortexLpRead[key] = sanitizeConcentratedCortexText(value)
    }
  }

  const primaryAddr = asAddress(lpControl.primaryMarketPool)
  const primaryId = asString(lpControl.primaryMarketPoolId)?.toLowerCase() ?? null

  const secondaryRaw = lpControl.secondaryLpControlSignals && typeof lpControl.secondaryLpControlSignals === 'object'
    ? lpControl.secondaryLpControlSignals
    : null
  const secondaryAddrFromSignal = asAddress(secondaryRaw?.poolAddress)
  const secondaryAddrFromEvidence = (() => {
    const line = extractEvidenceValue(evidence, 'Secondary ERC-20 LP exposure pool: ')
    if (!line) return null
    const addr = line.split(' ')[0]
    return asAddress(addr)
  })()
  const secondaryAddr = secondaryAddrFromSignal ?? secondaryAddrFromEvidence

  const secondaryMatchesPrimary = Boolean(
    secondaryAddr && ((primaryAddr && secondaryAddr === primaryAddr) || (primaryId && secondaryAddr === primaryId)),
  )

  const secondaryLpControlSignals = secondaryMatchesPrimary ? null : (secondaryRaw ?? null)

  let reconciledEvidence = evidence

  if (secondaryMatchesPrimary) {
    reconciledEvidence = reconciledEvidence.filter((line) =>
      !/^Secondary ERC-20 LP exposure (pair|pool):/.test(line)
      && !/^Secondary exposure reason:/.test(line)
      && !/^Secondary pool differs from primary concentrated pool$/.test(line),
    )
  }

  const marketPairLine = extractEvidenceValue(reconciledEvidence, 'Market primary pair: ')
  if (marketPairLine && /^unknown$/i.test(marketPairLine)) {
    const fallbackPair =
      extractEvidenceValue(reconciledEvidence, 'LP verification pair: ')
      ?? extractEvidenceValue(reconciledEvidence, 'Secondary ERC-20 LP exposure pair: ')
      ?? asString(secondaryRaw?.pair)
    if (fallbackPair && !/^unknown$/i.test(fallbackPair)) {
      reconciledEvidence = reconciledEvidence.map((line) =>
        line.startsWith('Market primary pair: ') ? `Market primary pair: ${fallbackPair}` : line,
      )
    }
  }

  if (displayLpModel === 'concentrated_liquidity') {
    const resolvedPair = extractEvidenceValue(reconciledEvidence, 'Market primary pair: ') ?? 'unknown'
    const dex = asString(lpControl.primaryPoolDex) ?? 'unknown'
    const identityLines = [`Primary pool: ${resolvedPair} (concentrated)`]
    if (primaryAddr) identityLines.push(`pool=${primaryAddr}`)
    else if (primaryId) identityLines.push(`poolId=${primaryId}`)
    identityLines.push(`dex=${dex}`, 'poolType=concentrated')

    reconciledEvidence = reconciledEvidence.filter((line) =>
      !/^Primary market pool(?: ID)?:/.test(line) && line !== 'pool=unknown',
    )
    reconciledEvidence = [...reconciledEvidence, ...identityLines]
  }

  if (displayLpModel === 'unknown') {
    const dexName = asString(scan.primaryDexName) ?? asString(lpControl.primaryPoolDex)
    if (dexName) {
      reconciledEvidence = reconciledEvidence.filter((line) =>
        !/^DEX metadata:/.test(line) && !/^Market primary pair: \?\/\?$/.test(line),
      )
      reconciledEvidence = [
        ...reconciledEvidence,
        `DEX: ${formatDexLabelMirror(dexName)}`,
        'Pool model: unknown',
        'Pair identity: open check',
      ]
    }
  }

  let lpProofDisplay = null
  const lockBurnConfirmed = scan.lpLockStatus === 'locked' || scan.lpLockStatus === 'burned'
  const hasPrimaryPoolIdentity = Boolean(primaryAddr || primaryId)

  if (displayLpModel === 'erc20_lp_token' && hasPrimaryPoolIdentity && !lockBurnConfirmed) {
    const lpControllerSharePercent = extractLpControllerSharePercent(evidence)
    lpProofDisplay = {
      proofLabel: 'Checked',
      lockStatus: 'No lock detected',
      lockAmount: 'None found',
      unlockTime: 'No unlock schedule found',
      burnProof: 'Not burned',
      controller: lpControllerSharePercent != null ? `Wallet controlled · ${lpControllerSharePercent}%` : 'Wallet controlled',
      exitRisk: 'High — LP can be removed unless locked or burned',
    }
  } else if (displayLpModel === 'concentrated_liquidity') {
    lpProofDisplay = {
      proofLabel: 'Position verification required',
      lockStatus: 'Protocol-specific',
      lockAmount: null,
      unlockTime: 'Position check required',
      burnProof: null,
      controller: null,
      exitRisk: null,
    }
  }

  return {
    displayLpModel,
    proofApplicability,
    lockBurnApplicable,
    lpModelProof,
    lpEvidenceSummary,
    cortexLpRead,
    evidence: reconciledEvidence,
    secondaryLpControlSignals,
    lpProofDisplay,
  }
}

// ─── Section A: BIT COCK-style fixture ──────────────────────────────────────

console.log('Section A: BIT COCK-style fixture (conflicting concentrated/constant_product)')

const bitcockScan = {
  lpControl: {
    status: 'concentrated_liquidity',
    displayLpModel: 'concentrated_liquidity',
    proofApplicability: 'not_applicable',
    lockBurnApplicable: false,
    primaryPoolType: 'concentrated',
    primaryPoolDex: 'uniswap-v4',
    primaryMarketPool: '0xeb14f6028e0662be1dcfed40bcb6f12db692454d',
    primaryMarketPoolId: null,
    secondaryLpControlSignals: {
      status: 'team_controlled',
      confidence: 'high',
      poolAddress: '0xeb14f6028e0662be1dcfed40bcb6f12db692454d',
      poolDex: 'uniswap-v4',
      poolType: 'concentrated',
      pair: 'BIT COCK / WETH',
      reason: 'Single wallet holds dominant LP share.',
      evidence: ['top_holder=0x1111111111111111111111111111111111111111', 'owner_lp_share=100.00%'],
    },
    evidence: [
      'top_holder=0x1111111111111111111111111111111111111111',
      'owner_lp_share=100.00%',
      'Market primary pair: unknown',
      'Primary market pool: 0xeb14f6028e0662be1dcfed40bcb6f12db692454d (concentrated)',
      'Secondary ERC-20 LP exposure pair: BIT COCK / WETH',
      'Secondary ERC-20 LP exposure pool: 0xeb14f6028e0662be1dcfed40bcb6f12db692454d (concentrated)',
      'Secondary pool differs from primary concentrated pool',
      'Secondary exposure reason: Single wallet holds dominant LP share.',
      'pool=unknown',
      'lpHolderCheckAttempted=true',
    ],
  },
  lpModelProof: { model: 'constant_product', dexName: 'uniswap-v4', standardLockApplies: true },
  lpEvidenceSummary: ['Pool model: constant_product', 'LP token holders checked: yes'],
  cortexLpRead: {
    poolStructureAnalysis: 'This pool uses a constant-product (constant_product) model where LP tokens represent pooled reserves.',
    liquidityAnalysis: 'Liquidity sits in a single primary pool.',
  },
}

const bitcock = reconcileBaseRadarLp(bitcockScan)

assert('final public model is concentrated', bitcock.displayLpModel === 'concentrated_liquidity', bitcock.displayLpModel)
assert('proofApplicability is not_applicable', bitcock.proofApplicability === 'not_applicable', bitcock.proofApplicability)
assert('lockBurnApplicable is false', bitcock.lockBurnApplicable === false, bitcock.lockBurnApplicable)
assert('lpModelProof.model is concentrated', bitcock.lpModelProof?.model === 'concentrated', bitcock.lpModelProof)
assert('lpModelProof.standardLockApplies is false', bitcock.lpModelProof?.standardLockApplies === false, bitcock.lpModelProof)
assert('lpEvidenceSummary says concentrated, not constant_product', bitcock.lpEvidenceSummary?.[0] === 'Pool model: concentrated', bitcock.lpEvidenceSummary)
assert('cortex poolStructureAnalysis says concentrated, not constant-product', /concentrated/i.test(bitcock.cortexLpRead?.poolStructureAnalysis ?? '') && !/constant[\s_-]?product/i.test(bitcock.cortexLpRead?.poolStructureAnalysis ?? ''), bitcock.cortexLpRead)
assert('no secondary exposure emitted when secondary pool equals primary', bitcock.secondaryLpControlSignals === null, bitcock.secondaryLpControlSignals)
assert('no "Secondary ERC-20 LP exposure" lines in evidence', !bitcock.evidence.some((l) => /^Secondary ERC-20 LP exposure/.test(l)), bitcock.evidence)
assert('no "Secondary exposure reason" line in evidence', !bitcock.evidence.some((l) => /^Secondary exposure reason:/.test(l)), bitcock.evidence)
assert('no "pool=unknown" anywhere in evidence', !bitcock.evidence.includes('pool=unknown'), bitcock.evidence)
assert('no "Market primary pair: unknown"', !bitcock.evidence.includes('Market primary pair: unknown'), bitcock.evidence)
assert('pair label resolved from secondary/LP-verification evidence', bitcock.evidence.includes('Market primary pair: BIT COCK / WETH'), bitcock.evidence)
assert('evidence includes canonical "Primary pool: ... (concentrated)" line', bitcock.evidence.includes('Primary pool: BIT COCK / WETH (concentrated)'), bitcock.evidence)
assert('evidence includes pool=<address>', bitcock.evidence.includes('pool=0xeb14f6028e0662be1dcfed40bcb6f12db692454d'), bitcock.evidence)
assert('evidence includes dex=', bitcock.evidence.includes('dex=uniswap-v4'), bitcock.evidence)
assert('evidence includes poolType=concentrated', bitcock.evidence.includes('poolType=concentrated'), bitcock.evidence)

// ─── Section B: VIRTUAL-style standard ERC-20 LP regression ────────────────

console.log('\nSection B: VIRTUAL-style standard ERC-20 LP regression')

const virtualScan = {
  lpControl: {
    status: 'team_controlled',
    displayLpModel: 'erc20_lp_token',
    proofApplicability: 'applicable',
    lockBurnApplicable: true,
    primaryPoolType: 'aerodrome',
    primaryPoolDex: 'aerodrome-base',
    primaryMarketPool: '0x21594b992f68495dd28d605834b58889d0a727c7',
    primaryMarketPoolId: null,
    evidence: [
      'top_holder=0x2222222222222222222222222222222222222222',
      'owner_lp_share=82.45%',
      'Market primary pair: VIRTUAL / WETH',
      'Primary market pool: 0x21594b992f68495dd28d605834b58889d0a727c7 (aerodrome)',
      'LP verification pair: VIRTUAL / WETH',
      'LP verification pool: 0x21594b992f68495dd28d605834b58889d0a727c7 (aerodrome)',
      'LP verification reason: Single wallet holds dominant LP share.',
      'lpHolderCheckAttempted=true',
    ],
  },
  lpModelProof: { model: 'constant_product', dexName: 'aerodrome-base', standardLockApplies: true },
  lpEvidenceSummary: ['Pool model: constant_product', 'LP token holders checked: yes'],
  cortexLpRead: {
    poolStructureAnalysis: 'This pool uses a constant-product (constant_product) model where LP tokens represent pooled reserves.',
  },
}

const virtual = reconcileBaseRadarLp(virtualScan)

assert('VIRTUAL final model remains erc20_lp_token', virtual.displayLpModel === 'erc20_lp_token', virtual.displayLpModel)
assert('VIRTUAL proofApplicability remains applicable', virtual.proofApplicability === 'applicable', virtual.proofApplicability)
assert('VIRTUAL lockBurnApplicable remains true', virtual.lockBurnApplicable === true, virtual.lockBurnApplicable)
assert('VIRTUAL lpModelProof.model remains constant_product', virtual.lpModelProof?.model === 'constant_product', virtual.lpModelProof)
assert('VIRTUAL lpEvidenceSummary still says constant_product', virtual.lpEvidenceSummary?.[0] === 'Pool model: constant_product', virtual.lpEvidenceSummary)
assert('VIRTUAL still shows standard LP verification pair line', virtual.evidence.includes('LP verification pair: VIRTUAL / WETH'), virtual.evidence)
assert('VIRTUAL still shows standard LP verification pool line', virtual.evidence.includes('LP verification pool: 0x21594b992f68495dd28d605834b58889d0a727c7 (aerodrome)'), virtual.evidence)
assert('VIRTUAL cortex copy keeps constant-product language', /constant[\s_-]?product/i.test(virtual.cortexLpRead?.poolStructureAnalysis ?? ''), virtual.cortexLpRead)

// ─── Section C: PLAY/MFERGPT-style concentrated primary + real secondary pool ──

console.log('\nSection C: PLAY/MFERGPT-style concentrated primary with real secondary pool')

const playScan = {
  lpControl: {
    status: 'concentrated_liquidity',
    displayLpModel: 'concentrated_liquidity',
    proofApplicability: 'not_applicable',
    lockBurnApplicable: false,
    primaryPoolType: 'concentrated',
    primaryPoolDex: 'uniswap-v3',
    primaryMarketPool: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    primaryMarketPoolId: null,
    secondaryLpControlSignals: {
      status: 'team_controlled',
      confidence: 'medium',
      poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      poolDex: 'uniswap-v2',
      poolType: 'v2',
      pair: 'PLAY / WETH',
      reason: 'Single wallet holds dominant LP share on the secondary pool.',
      evidence: ['top_holder=0x3333333333333333333333333333333333333333', 'owner_lp_share=91.00%'],
    },
    evidence: [
      'Market primary pair: PLAY / WETH',
      'Primary market pool: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (concentrated)',
      'Secondary ERC-20 LP exposure pair: PLAY / WETH',
      'Secondary ERC-20 LP exposure pool: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb (v2)',
      'Secondary pool differs from primary concentrated pool',
      'Secondary exposure reason: Single wallet holds dominant LP share on the secondary pool.',
      'lpHolderCheckAttempted=true',
    ],
  },
  lpModelProof: { model: 'concentrated', dexName: 'uniswap-v3', standardLockApplies: false },
  lpEvidenceSummary: ['Pool model: concentrated', 'LP token holders checked: no (concentrated primary)'],
  cortexLpRead: {
    poolStructureAnalysis: 'This pool uses a concentrated-liquidity model; standard ERC-20 LP lock/burn proof does not apply.',
  },
}

const play = reconcileBaseRadarLp(playScan)

assert('PLAY final model remains concentrated_liquidity', play.displayLpModel === 'concentrated_liquidity', play.displayLpModel)
assert('PLAY proofApplicability remains not_applicable', play.proofApplicability === 'not_applicable', play.proofApplicability)
assert('PLAY secondary exposure is preserved (different pool)', play.secondaryLpControlSignals !== null, play.secondaryLpControlSignals)
assert('PLAY secondary exposure pool address matches the real secondary pool', play.secondaryLpControlSignals?.poolAddress === '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', play.secondaryLpControlSignals)
assert('PLAY evidence still shows Secondary ERC-20 LP exposure pair', play.evidence.includes('Secondary ERC-20 LP exposure pair: PLAY / WETH'), play.evidence)
assert('PLAY evidence still shows Secondary ERC-20 LP exposure pool', play.evidence.includes('Secondary ERC-20 LP exposure pool: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb (v2)'), play.evidence)
assert('PLAY evidence includes canonical Primary pool concentrated line', play.evidence.includes('Primary pool: PLAY / WETH (concentrated)'), play.evidence)
assert('PLAY evidence includes pool=<primary address>', play.evidence.includes('pool=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), play.evidence)

// ─── Section D: SPHINCS-style fallback fixture (unknown model, fallback pool) ──

console.log('\nSection D: SPHINCS-style fallback fixture')

function finiteNumber(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function publicAddress(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.trim()) ? value.trim() : null
}

// Mirrors observedPoolFields() in app/api/base-radar/enrichment/route.ts
function observedPoolFields(scan) {
  const rawPoolCount = finiteNumber(scan.poolCount)
  const lpControl = scan.lpControl && typeof scan.lpControl === 'object' ? scan.lpControl : {}
  const hasPoolEvidence = Boolean(
    publicAddress(lpControl.primaryMarketPool) ||
    publicAddress(lpControl.verificationPool) ||
    publicAddress(scan.lpMeta?.primaryMarketPoolAddress) ||
    publicAddress(scan.lpMeta?.lpVerificationPoolAddress) ||
    scan.lpMeta?.poolDetected === true,
  )
  let observedPoolPresent = Boolean((rawPoolCount != null && rawPoolCount > 0) || hasPoolEvidence)
  let observedPoolCount = rawPoolCount != null && rawPoolCount > 0 ? rawPoolCount : (observedPoolPresent ? null : 0)
  let poolCountStatus = rawPoolCount != null && rawPoolCount > 0
    ? 'confirmed'
    : observedPoolPresent
      ? 'inferred_from_primary_pool'
      : 'unknown'

  if (!observedPoolPresent) {
    const liquidityUsd = finiteNumber(scan.liquidityUsd)
    const volume24hUsd = finiteNumber(scan.volume24hUsd)
    const dexName = scan.primaryDexName ?? scan.dexName ?? null
    const pairCreatedAt = scan.poolActivity?.pairCreatedAt ?? null
    const fallbackConfirmed = liquidityUsd != null && liquidityUsd > 0
      && volume24hUsd != null && volume24hUsd > 0
      && Boolean(dexName)
      && Boolean(pairCreatedAt)
    if (fallbackConfirmed) {
      observedPoolPresent = true
      observedPoolCount = 1
      poolCountStatus = 'fallback_confirmed'
    }
  }

  return { observedPoolPresent, observedPoolCount, poolCountStatus }
}

const pairCreatedAt = new Date(Date.now() - 13 * 60_000).toISOString()

const sphincsScan = {
  liquidityUsd: 23_568,
  volume24hUsd: 22_139,
  fdvUsd: 28_999,
  primaryDexName: 'Uniswap',
  poolActivity: { pairCreatedAt },
  poolCount: null,
  lpControl: {
    status: null,
    displayLpModel: null,
    proofApplicability: null,
    lockBurnApplicable: false,
    primaryPoolType: null,
    primaryPoolDex: 'Uniswap',
    primaryMarketPool: null,
    primaryMarketPoolId: null,
    evidence: [
      'DEX metadata: not_indexed',
      'Market primary pair: ?/?',
      'lpHolderCheckAttempted=false',
    ],
  },
  lpModelProof: null,
  lpEvidenceSummary: ['Pool model: unknown'],
}

const sphincsLp = reconcileBaseRadarLp(sphincsScan)
const sphincsPools = observedPoolFields(sphincsScan)

assert('SPHINCS displayLpModel is unknown', sphincsLp.displayLpModel === 'unknown', sphincsLp.displayLpModel)
assert('SPHINCS evidence includes DEX: Uniswap', sphincsLp.evidence.includes('DEX: Uniswap'), sphincsLp.evidence)
assert('SPHINCS evidence includes Pool model: unknown', sphincsLp.evidence.includes('Pool model: unknown'), sphincsLp.evidence)
assert('SPHINCS evidence includes Pair identity: open check', sphincsLp.evidence.includes('Pair identity: open check'), sphincsLp.evidence)
assert('SPHINCS evidence drops "DEX metadata: not_indexed"', !sphincsLp.evidence.includes('DEX metadata: not_indexed'), sphincsLp.evidence)
assert('SPHINCS evidence drops "Market primary pair: ?/?"', !sphincsLp.evidence.includes('Market primary pair: ?/?'), sphincsLp.evidence)

assert('SPHINCS observedPoolPresent is true via fallback', sphincsPools.observedPoolPresent === true, sphincsPools)
assert('SPHINCS observedPoolCount is 1', sphincsPools.observedPoolCount === 1, sphincsPools)
assert('SPHINCS poolCountStatus is fallback_confirmed', sphincsPools.poolCountStatus === 'fallback_confirmed', sphincsPools)

// ─── Section E: Orbit-style fixture — V2 LP, wallet controls 100%, no lock/burn ──

console.log('\nSection E: Orbit-style fixture (V2 LP, 100% wallet-controlled, no lock/burn)')

const orbitScan = {
  liquidityUsd: 2.45,
  lpLockStatus: 'unverified',
  lpControl: {
    status: 'team_controlled',
    displayLpModel: 'erc20_lp_token',
    proofApplicability: 'applicable',
    lockBurnApplicable: true,
    primaryPoolType: 'v2',
    primaryPoolDex: 'uniswap-v2',
    primaryMarketPool: '0x4444444444444444444444444444444444444444',
    primaryMarketPoolId: null,
    evidence: [
      'top_holder=0x5555555555555555555555555555555555555555',
      'owner_lp_share=100.00%',
      'Market primary pair: ORBIT / WETH',
      'Primary market pool: 0x4444444444444444444444444444444444444444 (v2)',
      'lpHolderCheckAttempted=true',
    ],
  },
  lpModelProof: { model: 'constant_product', dexName: 'uniswap-v2', standardLockApplies: true },
  lpEvidenceSummary: ['Pool model: constant_product', 'LP token holders checked: yes'],
}

const orbitLp = reconcileBaseRadarLp(orbitScan)

assert('Orbit final model is erc20_lp_token', orbitLp.displayLpModel === 'erc20_lp_token', orbitLp.displayLpModel)
assert('Orbit proofApplicability is applicable', orbitLp.proofApplicability === 'applicable', orbitLp.proofApplicability)
assert('Orbit LP proof says Checked, not generic Open Check', orbitLp.lpProofDisplay?.proofLabel === 'Checked', orbitLp.lpProofDisplay)
assert('Orbit lock status says No lock detected', orbitLp.lpProofDisplay?.lockStatus === 'No lock detected', orbitLp.lpProofDisplay)
assert('Orbit lock amount says None found', orbitLp.lpProofDisplay?.lockAmount === 'None found', orbitLp.lpProofDisplay)
assert('Orbit unlock time says No unlock schedule found', orbitLp.lpProofDisplay?.unlockTime === 'No unlock schedule found', orbitLp.lpProofDisplay)
assert('Orbit burn proof says Not burned', orbitLp.lpProofDisplay?.burnProof === 'Not burned', orbitLp.lpProofDisplay)
assert('Orbit controller shows Wallet controlled · 100%', orbitLp.lpProofDisplay?.controller === 'Wallet controlled · 100%', orbitLp.lpProofDisplay)
assert('Orbit exit risk is High — LP can be removed unless locked or burned', orbitLp.lpProofDisplay?.exitRisk === 'High — LP can be removed unless locked or burned', orbitLp.lpProofDisplay)

// ─── Section F: Concentrated (V3/V4) LP proof display ──────────────────────

console.log('\nSection F: Concentrated (V3/V4) LP proof display')

const concentratedLp = reconcileBaseRadarLp(bitcockScan)
assert('Concentrated LP proof says Position verification required', concentratedLp.lpProofDisplay?.proofLabel === 'Position verification required', concentratedLp.lpProofDisplay)
assert('Concentrated lock status says Protocol-specific', concentratedLp.lpProofDisplay?.lockStatus === 'Protocol-specific', concentratedLp.lpProofDisplay)
assert('Concentrated unlock time says Position check required', concentratedLp.lpProofDisplay?.unlockTime === 'Position check required', concentratedLp.lpProofDisplay)

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
