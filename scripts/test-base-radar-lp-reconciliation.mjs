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

// Mirrors V2_DEX_PATTERNS / CONCENTRATED_DEX_PATTERNS / classifyDexModelHint in
// lib/server/baseRadarLpReconciliation.ts
const V2_DEX_PATTERNS = ['uniswap_v2', 'uniswapv2', 'baseswap', 'aerodrome', 'alienbase', 'swapbased', 'sushiswap', 'pancakeswap_v2', 'pancakeswapv2']
const CONCENTRATED_DEX_PATTERNS = ['uniswap_v3', 'uniswapv3', 'uniswap_v4', 'uniswapv4', 'slipstream', 'pancakeswap_v3', 'pancakeswapv3', 'pancakeswap-v3']

function classifyDexModelHint(dexId) {
  if (!dexId) return 'unknown'
  const normalized = dexId.toLowerCase().trim().replace(/[\s-]+/g, '_')
  if (normalized === 'uniswap') return 'unknown'
  if (CONCENTRATED_DEX_PATTERNS.some((p) => normalized.includes(p.replace(/[\s-]+/g, '_')))) return 'concentrated_liquidity'
  if (V2_DEX_PATTERNS.some((p) => normalized.includes(p.replace(/[\s-]+/g, '_')))) return 'erc20_lp_token'
  if (normalized.includes('v3') || normalized.includes('v4')) return 'concentrated_liquidity'
  if (normalized.includes('v2')) return 'erc20_lp_token'
  return 'unknown'
}

// Mirrors normalizeBaseRadarFallbackPoolIdentity in lib/server/baseRadarLpReconciliation.ts
function normalizeBaseRadarFallbackPoolIdentity(scan) {
  const selectedPool = scan?.selectedPool && typeof scan.selectedPool === 'object' ? scan.selectedPool : {}
  const marketFallback = scan?._diagnostics?.marketFallback && typeof scan._diagnostics.marketFallback === 'object' ? scan._diagnostics.marketFallback : {}
  const dexPair = scan?.dexPair && typeof scan.dexPair === 'object' ? scan.dexPair : {}
  const baseTokenObj = dexPair.baseToken ?? scan?.baseToken
  const quoteTokenObj = dexPair.quoteToken ?? scan?.quoteToken

  const pairAddress = asAddress(
    scan?.pairAddress ?? scan?.pair_address ?? scan?.poolAddress ?? scan?.pool_address ?? scan?.address
    ?? dexPair.pairAddress ?? dexPair.pair_address
    ?? selectedPool.address
    ?? marketFallback.pairAddress,
  )

  const dexId = asString(
    scan?.dexId ?? dexPair.dexId ?? marketFallback.dexId ?? selectedPool.dex ?? scan?.dexName ?? scan?.primaryDexName,
  )

  const dexName = asString(scan?.dexName ?? scan?.primaryDexName ?? (typeof selectedPool.dex === 'string' ? selectedPool.dex : null) ?? dexId)

  const symbolPair = [baseTokenObj?.symbol, quoteTokenObj?.symbol].filter((v) => typeof v === 'string' && v).join('/')
  const pairLabel = asString(selectedPool.pair) ?? (symbolPair ? symbolPair : null)

  return {
    pairAddress,
    dexName,
    dexId,
    pairLabel,
    modelHint: pairAddress ? classifyDexModelHint(dexId) : 'unknown',
  }
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

  const fallbackPoolIdentity = normalizeBaseRadarFallbackPoolIdentity(scan)

  const displayLpModel = reconcileLpModel([
    lpControl.displayLpModel,
    scan.displayLpModel,
    scan.lpControlRead?.selectedPoolModel,
    lpControl.primaryPoolType,
    lpModelProofRaw?.model,
    fallbackPoolIdentity.pairAddress ? fallbackPoolIdentity.modelHint : null,
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

  let primaryAddr = asAddress(lpControl.primaryMarketPool)
  let primaryId = asString(lpControl.primaryMarketPoolId)?.toLowerCase() ?? null
  let usedFallbackPoolIdentity = false
  if (!primaryAddr && !primaryId && fallbackPoolIdentity.pairAddress) {
    primaryAddr = fallbackPoolIdentity.pairAddress
    usedFallbackPoolIdentity = true
  }

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

  const hasRealSecondaryPool = Boolean(secondaryAddr) && !secondaryMatchesPrimary

  const secondaryLpControlSignals = hasRealSecondaryPool ? (secondaryRaw ?? null) : null

  let reconciledEvidence = evidence

  if (!hasRealSecondaryPool) {
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
    const resolvedPair = extractEvidenceValue(reconciledEvidence, 'Market primary pair: ') ?? fallbackPoolIdentity.pairLabel ?? 'unknown'
    const dex = asString(lpControl.primaryPoolDex) ?? fallbackPoolIdentity.dexId ?? 'unknown'
    const identityLines = [`Primary pool: ${resolvedPair} (concentrated)`]
    if (primaryAddr) identityLines.push(`pool=${primaryAddr}`)
    else if (primaryId) identityLines.push(`poolId=${primaryId}`)
    identityLines.push(`dex=${dex}`, 'poolType=concentrated')

    reconciledEvidence = reconciledEvidence.filter((line) =>
      !/^Primary market pool(?: ID)?:/.test(line) && line !== 'pool=unknown',
    )
    reconciledEvidence = [...reconciledEvidence, ...identityLines]
  }

  if (displayLpModel === 'erc20_lp_token' && usedFallbackPoolIdentity) {
    if (!extractEvidenceValue(reconciledEvidence, 'Market primary pair: ')) {
      reconciledEvidence = [...reconciledEvidence, `Market primary pair: ${fallbackPoolIdentity.pairLabel ?? 'unknown'}`]
    }
    if (!reconciledEvidence.some((line) => /^Primary market pool:/.test(line))) {
      reconciledEvidence = [...reconciledEvidence, `Primary market pool: ${primaryAddr} (${fallbackPoolIdentity.dexId ?? 'v2'})`]
    }
  }

  if (displayLpModel === 'unknown') {
    const dexName = asString(scan.primaryDexName) ?? asString(lpControl.primaryPoolDex) ?? fallbackPoolIdentity.dexName
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

  const pairIdentityOpenCheck = !hasPrimaryPoolIdentity && reconciledEvidence.includes('Pair identity: open check')

  if (!lpProofDisplay && pairIdentityOpenCheck) {
    lpProofDisplay = {
      proofLabel: 'Pair identity open check',
      lockStatus: 'Pair identity open check',
      lockAmount: null,
      unlockTime: 'Pair identity open check',
      burnProof: null,
      controller: null,
      exitRisk: null,
    }
  }

  let rugRiskDisplay = null
  if (displayLpModel === 'erc20_lp_token' && hasPrimaryPoolIdentity && !lockBurnConfirmed) {
    rugRiskDisplay = {
      status: 'checked_dangerous',
      reason: 'No lock or burn proof found for the LP token; exit risk is high if the wallet/team controls the LP.',
    }
  } else if (displayLpModel === 'concentrated_liquidity') {
    rugRiskDisplay = {
      status: 'position_control_open_check',
      reason: 'Concentrated-liquidity position control requires protocol-specific verification.',
    }
  } else if (pairIdentityOpenCheck) {
    rugRiskDisplay = {
      status: 'pool_identity_open_check',
      reason: 'Missing pair address — pool identity could not be confirmed.',
    }
  }

  const poolAddressPresent = Boolean(primaryAddr)
  const simulationPairAddress = primaryAddr
    ? primaryAddr
    : pairIdentityOpenCheck
      ? null
      : undefined

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
    primaryMarketPool: primaryAddr,
    poolAddressPresent,
    fallbackPoolIdentity,
    simulationPairAddress,
    rugRiskDisplay,
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

// MASCOPS-style fallback pool with no resolvable pair address (task fixture A):
// fallback market evidence exists (liquidity/volume/dex/age) but no real pool
// address — pool identity stays open check, never a fake pool address.
assert('SPHINCS poolAddressPresent is false (no fake pool address)', sphincsLp.poolAddressPresent === false, sphincsLp.poolAddressPresent)
assert('SPHINCS primaryMarketPool is null', sphincsLp.primaryMarketPool === null, sphincsLp.primaryMarketPool)
assert('SPHINCS simulationPairAddress is null (missing pair address)', sphincsLp.simulationPairAddress === null, sphincsLp.simulationPairAddress)
assert('SPHINCS LP proof says Pair identity open check', sphincsLp.lpProofDisplay?.proofLabel === 'Pair identity open check', sphincsLp.lpProofDisplay)
assert('SPHINCS rug/LP risk explains missing pair address, not generic Open Check', sphincsLp.rugRiskDisplay?.status === 'pool_identity_open_check', sphincsLp.rugRiskDisplay)

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

// ─── Section G: fallback pairAddress + dexId uniswap_v2 (task fixture B) ───

console.log('\nSection G: fallback pairAddress + dexId uniswap_v2')

const fallbackV2Scan = {
  liquidityUsd: 12_400,
  volume24hUsd: 9_800,
  primaryDexName: 'Uniswap V2',
  poolActivity: { pairCreatedAt: new Date(Date.now() - 40 * 60_000).toISOString() },
  poolCount: 1,
  selectedPool: {
    pair: 'FOO/WETH',
    address: '0x6666666666666666666666666666666666666666',
    dex: 'uniswap_v2',
    model: 'unknown',
    liquidityUsd: 12_400,
    createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  },
  lpControl: {
    status: null,
    displayLpModel: null,
    proofApplicability: null,
    lockBurnApplicable: false,
    primaryPoolType: null,
    primaryPoolDex: null,
    primaryMarketPool: null,
    primaryMarketPoolId: null,
    evidence: [],
  },
  lpModelProof: null,
  lpEvidenceSummary: null,
}

const fallbackV2 = reconcileBaseRadarLp(fallbackV2Scan)

assert('fallback V2: fallbackPoolIdentity.pairAddress resolved', fallbackV2.fallbackPoolIdentity.pairAddress === '0x6666666666666666666666666666666666666666', fallbackV2.fallbackPoolIdentity)
assert('fallback V2: fallbackPoolIdentity.modelHint is erc20_lp_token', fallbackV2.fallbackPoolIdentity.modelHint === 'erc20_lp_token', fallbackV2.fallbackPoolIdentity)
assert('fallback V2: primaryMarketPool populated from fallback', fallbackV2.primaryMarketPool === '0x6666666666666666666666666666666666666666', fallbackV2.primaryMarketPool)
assert('fallback V2: poolAddressPresent is true', fallbackV2.poolAddressPresent === true, fallbackV2.poolAddressPresent)
assert('fallback V2: displayLpModel is erc20_lp_token', fallbackV2.displayLpModel === 'erc20_lp_token', fallbackV2.displayLpModel)
assert('fallback V2: evidence includes Market primary pair: FOO/WETH', fallbackV2.evidence.includes('Market primary pair: FOO/WETH'), fallbackV2.evidence)
assert('fallback V2: evidence includes Primary market pool with real address', fallbackV2.evidence.some((l) => l.startsWith('Primary market pool: 0x6666666666666666666666666666666666666666')), fallbackV2.evidence)
assert('fallback V2: LP proof says Checked (no lock/burn found)', fallbackV2.lpProofDisplay?.proofLabel === 'Checked', fallbackV2.lpProofDisplay)
assert('fallback V2: lock status says No lock detected', fallbackV2.lpProofDisplay?.lockStatus === 'No lock detected', fallbackV2.lpProofDisplay)
assert('fallback V2: burn proof says Not burned', fallbackV2.lpProofDisplay?.burnProof === 'Not burned', fallbackV2.lpProofDisplay)
assert('fallback V2: rug/LP risk is checked_dangerous, not generic Open Check', fallbackV2.rugRiskDisplay?.status === 'checked_dangerous', fallbackV2.rugRiskDisplay)
assert('fallback V2: simulationPairAddress equals resolved pair address', fallbackV2.simulationPairAddress === '0x6666666666666666666666666666666666666666', fallbackV2.simulationPairAddress)

// ─── Section H: concentrated Uniswap V4 with no real secondary (task fixture C) ──

console.log('\nSection H: concentrated Uniswap V4 with no real secondary')

const concentratedV4Scan = {
  liquidityUsd: 88_000,
  lpControl: {
    status: 'concentrated_liquidity',
    displayLpModel: 'concentrated_liquidity',
    proofApplicability: 'not_applicable',
    lockBurnApplicable: false,
    primaryPoolType: 'concentrated',
    primaryPoolDex: 'uniswap-v4',
    primaryMarketPool: '0x8888888888888888888888888888888888888888',
    primaryMarketPoolId: null,
    evidence: [
      'Market primary pair: BAZ / WETH',
      'Primary market pool: 0x8888888888888888888888888888888888888888 (concentrated)',
      'Secondary ERC-20 LP exposure pool: none (v3)',
      'lpHolderCheckAttempted=false',
    ],
  },
  lpModelProof: { model: 'concentrated', dexName: 'uniswap-v4', standardLockApplies: false },
  lpEvidenceSummary: ['Pool model: concentrated', 'LP token holders checked: no (concentrated primary)'],
}

const concentratedV4 = reconcileBaseRadarLp(concentratedV4Scan)

assert('concentrated V4: no fake "Secondary ERC-20 LP exposure pool: none" line', !concentratedV4.evidence.some((l) => /^Secondary ERC-20 LP exposure pool: none/.test(l)), concentratedV4.evidence)
assert('concentrated V4: secondaryLpControlSignals is null', concentratedV4.secondaryLpControlSignals === null, concentratedV4.secondaryLpControlSignals)
assert('concentrated V4: displayLpModel remains concentrated_liquidity', concentratedV4.displayLpModel === 'concentrated_liquidity', concentratedV4.displayLpModel)
assert('concentrated V4: LP proof says Position verification required', concentratedV4.lpProofDisplay?.proofLabel === 'Position verification required', concentratedV4.lpProofDisplay)
assert('concentrated V4: lock status says Protocol-specific', concentratedV4.lpProofDisplay?.lockStatus === 'Protocol-specific', concentratedV4.lpProofDisplay)
assert('concentrated V4: rug/LP risk is position-control open check, not fake ERC20 lock proof', concentratedV4.rugRiskDisplay?.status === 'position_control_open_check', concentratedV4.rugRiskDisplay)
assert('concentrated V4: poolAddressPresent is true', concentratedV4.poolAddressPresent === true, concentratedV4.poolAddressPresent)

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
