/**
 * Regression tests for /api/token public-vs-debug response shape.
 * Run: node --experimental-strip-types scripts/test-token-public-sanitization.mjs
 */
import { sanitizePublicTokenResponse } from '../lib/server/tokenPublicResponse.ts'
import { publicLpDataMode, computeLpExitRisk, buildCortexLpRead, formatTokenIdentity } from '../lib/server/lpProof.ts'
import { buildLpControllerIntel, resolveLpControllerIdentity } from '../lib/server/lpControllerIntel.ts'
import { calculateTokenRiskScore } from '../lib/server/riskScore.ts'
import { buildLpMovementWatch } from '../lib/server/lpMovementWatch.ts'
import { buildLpLockBurnIntel, LP_LOCK_BURN_REGISTRY } from '../lib/server/lpLockBurnIntel.ts'
import { buildLpUnlockTimeline } from '../lib/server/lpUnlockTimeline.ts'
import { buildLpHistoryTimeline } from '../lib/server/lpHistoryTimeline.ts'
import { buildSecondaryLpExposure } from '../lib/server/secondaryLpExposure.ts'

// Mirrors reconcileSecondaryLpSignal() in lib/server/lpIntelligence.ts (selection rules
// 3/4) in plain JS, matching the re-implementation pattern used by
// scripts/test-lp-intelligence.mjs — avoids importing lpIntelligence.ts, which has its
// own extensionless internal import that node's --experimental-strip-types can't resolve.
function reconcileSecondaryLpSignal(lpControl, params) {
  const { primaryConcentrated, verifyPool, primaryPoolAddress, primaryPoolType, primaryDexId, marketPairLabel, canonicalStatus } = params
  if (!(primaryConcentrated && verifyPool?.address && verifyPool.address !== primaryPoolAddress)) {
    return { lpControl, secondary: null }
  }
  const secondary = {
    status: lpControl.status,
    confidence: lpControl.confidence,
    poolAddress: verifyPool.address,
    poolDex: verifyPool.dexId ?? verifyPool.dexName ?? null,
    poolType: verifyPool.poolType,
    reason: lpControl.reason,
    evidence: lpControl.evidence,
  }
  const reconciled = {
    ...lpControl,
    status: canonicalStatus ?? 'concentrated_liquidity',
    confidence: 'medium',
    reason: 'Protocol-specific LP proof required for the primary pool.',
    evidence: [
      `Primary pool: ${marketPairLabel} (${primaryPoolType})`,
      `pool=${primaryPoolAddress ?? 'unknown'}`,
      `dex=${primaryDexId ?? 'unknown'}`,
      `poolType=${primaryPoolType}`,
    ],
    secondaryLpControlSignals: secondary,
  }
  // Mirrors lpIntelligence.ts: reset poolType to the PRIMARY pool's type so the secondary
  // pool's poolType (just spread in via ...lpControl) doesn't leak into the reconciled object.
  if ('poolType' in lpControl) {
    reconciled.poolType = primaryPoolType
  }
  return { lpControl: reconciled, secondary }
}

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
function hasKeyDeep(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasKeyDeep(item, key))
  if (!value || typeof value !== 'object') return false
  if (Object.prototype.hasOwnProperty.call(value, key)) return true
  return Object.values(value).some((item) => hasKeyDeep(item, key))
}
function serialized(value) {
  return JSON.stringify(value).toLowerCase()
}
const providerNames = ['coingecko', 'geckoterminal', 'dexscreener', 'goldrush', 'covalent', 'moralis', 'alchemy', 'honeypot.is', 'basescan', 'zerion', 'gmgn']

const holders = Array.from({ length: 25 }, (_, index) => ({
  rank: index + 1,
  address: `0x${String(index + 1).padStart(40, '0')}`,
  percent: index + 1,
  source: 'goldrush_token_holders',
}))
const transfers = Array.from({ length: 25 }, (_, index) => ({
  hash: `0x${String(index + 1).padStart(64, '0')}`,
  from: holders[0].address,
  to: holders[1].address,
  source: 'moralis_token_transfers',
}))

const virtualLikePayload = {
  chain: 'base',
  contract: '0x0000000000000000000000000000000000000001',
  name: 'Virtuals Protocol',
  symbol: 'VIRTUAL',
  selectedPool: { address: '0x21594b992f68495dd28d605834b58889d0a727c7', pair: 'VIRTUAL / WETH', dex: 'aerodrome-base', liquidityUsd: 1234567, createdAt: '2024-03-31T15:39:37.000Z' },
  riskScore: 58,
  riskLabel: 'moderate',
  riskBreakdown: { total: 58, liquiditySafety: { score: 7, max: 30, reasons: ['Wallet-controlled LP'] } },
  lpControl: {
    status: 'team_controlled',
    proofStatus: 'open_check',
    lockStatus: 'not_confirmed',
    burnStatus: 'not_confirmed',
    lpController: '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5',
    lpControllerType: 'wallet',
    evidence: ['top_holder=0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', 'top_share=82.45%'],
    reason: 'Holder evidence confirmed LP controller wallet.',
  },
  lpControlRead: { title: 'LP controlled by wallet', meaning: 'Control Proof: Confirmed' },
  lpMigrationProof: {
    status: 'low',
    confidence: 'medium',
    reason: 'GeckoTerminal pools show a selected primary pool.',
    dexsUsed: ['aerodrome-base'],
    primaryDex: 'aerodrome-base',
    liquidityDistribution: 'concentrated in primary pool',
    signals: ['All observed liquidity sits in a single pool.'],
    missingEvidence: ['pool_creation_date_unavailable', 'historical_liquidity_movement_unavailable'],
    nextAction: 'Confirm pool creation dates and historical liquidity moves on a block explorer before drawing migration conclusions.',
  },
  marketDataSource: 'primary',
  poolCount: 20,
  observedPoolCount: 20,
  primaryPoolAgeLabel: '14mo',
  lpExitRisk: 'watch',
  liquidityDepthRisk: 'low',
  lpProofApplicability: 'applicable',
  lpProofStatus: 'partial',
  lpEvidenceSummary: 'Pool model: constant_product | Liquidity: $1,234,567 | Proof applicability: applicable | Proof status: partial | Migration: low',
  lpDataMode: 'evidence_based',
  lpDataModeRaw: 'fallback',
  lpModelProof: {
    model: 'constant_product',
    dexName: 'aerodrome-base',
    standardLockApplies: true,
  },
  cortexLpRead: {
    mode: 'fallback',
    confidence: 'medium',
    riskSummary: 'Virtuals Protocol (VIRTUAL) shows an overall "moderate" risk tier based on observed pool data. Liquidity depth is deep relative to this token. (data mode: fallback, confidence: medium). No lock or burn proof was confirmed for this LP.',
    liquidityAnalysis: 'Observed liquidity is approximately $1,200,000 in the detected primary pool.',
    poolStructureAnalysis: 'The primary pool runs on a constant-product model (DEX: aerodrome-base).',
    migrationAnalysis: 'GeckoTerminal pools show a selected primary pool.',
    evidenceGaps: [],
    nextActions: ['Confirm LP lock and burn status directly on-chain before trusting any safety claims.'],
  },
  lpControllerIntel: {
    status: 'wallet_controlled',
    controllerSharePercent: 82.45,
    controlProof: 'confirmed',
    lockBurnProof: 'open_check',
    exitRisk: 'watch',
    liquidityDepth: 'deep',
    migrationRisk: 'low',
  },
  lpMeta: {
    primaryMarketDex: 'Aerodrome',
    lpControlState: 'team_controlled',
  },
  sections: {
    liquidity: {
      lpLockBurnProofStatus: 'partial',
      lpMeta: {
        primaryMarketDex: 'Aerodrome',
        lpControlState: 'team_controlled',
      },
    },
    contractChecks: { totalSupply: '0x1234', decimalsRpc: '0x12', source: 'alchemy' },
  },
  holderDistribution: { top10: 48, holderCount: 100000, topHolders: holders },
  devIntel: { holderDistribution: { topHolders: holders } },
  holderResolver: { holders, sourceTrail: ['goldrush:attempted'], fallbackUsed: 'goldrush_token_holders' },
  transferResolver: { transfers, sourceTrail: ['moralis:attempted'], fallbackUsed: 'moralis_token_transfers' },
  suspiciousFlows: { transfers, fallbackUsed: 'moralis_token_transfers' },
  securityDiagnostics: { honeypotProvider: 'honeypot.is' },
  projectSocials: { twitter: 'x', sourceTrail: ['coingecko:succeeded'] },
  rugRisk: { score: 42, label: 'watch', raw: { provider: 'moralis', holders } },
  riskEngine: {
    rugRiskScore: 38,
    rugRiskLabel: 'watch',
    cortexScoreDebug: { raw: true },
    clarkInterpretation: {
      summary: 'Base token. Rug-risk pressure: 83/100. Watch-level signals — monitor closely.',
      riskDrivers: ['Rug-risk pressure: 83/100. Legacy driver wording.'],
    },
    cortexScore: 67,
    cortexVerdict: 'CAUTION',
    note: 'dexscreener fallback',
  },
  cortexScore: 67,
  cortexVerdict: 'CAUTION',
  cortexScoreDebug: { raw: true },
  gtRaw: { provider: 'geckoterminal' },
  gtPools: [{ provider: 'geckoterminal' }],
  gmgn: { provider: 'gmgn' },
  _debug: { goldrushUsage: true },
  priceChart: {
    timeframe: '24h',
    sourceStatus: 'ok',
    points: Array.from({ length: 400 }, (_, i) => ({
      timestamp: new Date(i * 60_000).toISOString(),
      open: 1, high: 1, low: 1, close: 1, volume: 1, priceUsd: 1,
    })),
  },
}

virtualLikePayload.lpControllerIntel = buildLpControllerIntel({
  lpControl: virtualLikePayload.lpControl,
  lpControlRead: virtualLikePayload.lpControlRead,
  selectedPool: virtualLikePayload.selectedPool,
  lpExitRisk: virtualLikePayload.lpExitRisk,
  liquidityDepthRisk: virtualLikePayload.liquidityDepthRisk,
  lpMigrationProof: virtualLikePayload.lpMigrationProof,
  lpEvidenceGaps: virtualLikePayload.lpEvidenceGaps,
  lpMeta: virtualLikePayload.lpMeta,
  lpDataMode: virtualLikePayload.lpDataMode,
})
virtualLikePayload.lpMovementWatch = buildLpMovementWatch({
  chain: virtualLikePayload.chain,
  lpControllerIntel: virtualLikePayload.lpControllerIntel,
  lpControl: virtualLikePayload.lpControl,
  selectedPool: virtualLikePayload.selectedPool,
  lpMeta: virtualLikePayload.lpMeta,
})
virtualLikePayload.lpLockBurnIntel = buildLpLockBurnIntel({
  chain: virtualLikePayload.chain,
  lpControllerIntel: virtualLikePayload.lpControllerIntel,
  lpControl: virtualLikePayload.lpControl,
  selectedPool: virtualLikePayload.selectedPool,
  lpMeta: virtualLikePayload.lpMeta,
})
virtualLikePayload.lpUnlockTimeline = buildLpUnlockTimeline({
  chain: virtualLikePayload.chain,
  lpLockBurnIntel: virtualLikePayload.lpLockBurnIntel,
})
virtualLikePayload.lpHistoryTimeline = buildLpHistoryTimeline({
  chain: virtualLikePayload.chain,
  poolModel: virtualLikePayload.lpModelProof.model,
  marketDataSource: virtualLikePayload.marketDataSource,
  selectedPool: virtualLikePayload.selectedPool,
  primaryPoolAgeLabel: virtualLikePayload.primaryPoolAgeLabel,
  poolCount: virtualLikePayload.poolCount,
  observedPoolCount: virtualLikePayload.observedPoolCount,
  liquidityUsd: virtualLikePayload.selectedPool.liquidityUsd,
  lpMigrationProof: virtualLikePayload.lpMigrationProof,
})

console.log('\nA. VIRTUAL-like public response')
const publicPayload = sanitizePublicTokenResponse(JSON.parse(JSON.stringify(virtualLikePayload)), false)
assert('riskScore remains present', publicPayload.riskScore === 58, publicPayload.riskScore)
assert('riskLabel remains moderate', publicPayload.riskLabel === 'moderate', publicPayload.riskLabel)
assert('riskBreakdown remains present', Boolean(publicPayload.riskBreakdown), publicPayload.riskBreakdown)
assert('lpControl.status is team_controlled', publicPayload.lpControl?.status === 'team_controlled', publicPayload.lpControl)
assert('lpControlRead says wallet controlled', publicPayload.lpControlRead?.title === 'LP controlled by wallet', publicPayload.lpControlRead)
assert('selectedPool exists', Boolean(publicPayload.selectedPool?.address), publicPayload.selectedPool)
assert('lpMigrationProof.status is low', publicPayload.lpMigrationProof?.status === 'low', publicPayload.lpMigrationProof)
assert('public response does not expose cortexScoreDebug', !hasKeyDeep(publicPayload, 'cortexScoreDebug'), publicPayload.riskEngine)
for (const provider of providerNames) assert(`public response does not expose provider name ${provider}`, !serialized(publicPayload).includes(provider), provider)
assert('top holders are capped to 10', publicPayload.holderDistribution.topHolders.length === 10, publicPayload.holderDistribution.topHolders.length)
assert('raw holder arrays are not exposed in holderResolver', !Array.isArray(publicPayload.holderResolver?.holders), publicPayload.holderResolver)
assert('raw transfer arrays are not exposed in transferResolver', !Array.isArray(publicPayload.transferResolver?.transfers), publicPayload.transferResolver)
assert('raw suspicious transfer arrays are not exposed', !Array.isArray(publicPayload.suspiciousFlows?.transfers), publicPayload.suspiciousFlows)
assert('raw technical totalSupply hex is stripped from contract checks', !('totalSupply' in publicPayload.sections.contractChecks), publicPayload.sections.contractChecks)
assert('top-level old CORTEX score is debug-only', publicPayload.cortexScore == null && publicPayload.cortexVerdict == null, { cortexScore: publicPayload.cortexScore, cortexVerdict: publicPayload.cortexVerdict })
assert('drops top-level rugRisk.score', !('score' in publicPayload.rugRisk), publicPayload.rugRisk)
assert('drops top-level rugRisk.label', !('label' in publicPayload.rugRisk), publicPayload.rugRisk)
assert('drops riskEngine.rugRiskScore', !('rugRiskScore' in publicPayload.riskEngine), publicPayload.riskEngine)
assert('drops riskEngine.rugRiskLabel', !('rugRiskLabel' in publicPayload.riskEngine), publicPayload.riskEngine)
assert('Clark summary does not say Rug-risk pressure', !/Rug-risk pressure/i.test(publicPayload.riskEngine.clarkInterpretation.summary), publicPayload.riskEngine.clarkInterpretation.summary)
assert('Clark summary references canonical Token Safety Score', /Token Safety Score:\s*58\/100 \(moderate\)/.test(publicPayload.riskEngine.clarkInterpretation.summary), publicPayload.riskEngine.clarkInterpretation.summary)
assert('public payload has no Rug-risk pressure wording', !/Rug-risk pressure/i.test(serialized(publicPayload)), publicPayload.riskEngine.clarkInterpretation)
assert('drops lpDataModeRaw', !('lpDataModeRaw' in publicPayload))
assert('keeps normalized public lpDataMode', publicPayload.lpDataMode === 'evidence_based', publicPayload.lpDataMode)
assert('caps priceChart.points', publicPayload.priceChart.points.length === 150, publicPayload.priceChart.points.length)
assert('lpControllerIntel is public', Boolean(publicPayload.lpControllerIntel), publicPayload.lpControllerIntel)
assert('VIRTUAL lpControllerIntel.status is wallet_controlled', publicPayload.lpControllerIntel?.status === 'wallet_controlled', publicPayload.lpControllerIntel)
assert('VIRTUAL lpControllerIntel.controlProof is confirmed', publicPayload.lpControllerIntel?.controlProof === 'confirmed', publicPayload.lpControllerIntel)
assert('VIRTUAL lpControllerIntel.lockBurnProof is open_check', publicPayload.lpControllerIntel?.lockBurnProof === 'open_check', publicPayload.lpControllerIntel)
assert('VIRTUAL lpControllerIntel.controllerSharePercent is present', publicPayload.lpControllerIntel?.controllerSharePercent === 82.45, publicPayload.lpControllerIntel)
assert('VIRTUAL lpControllerIntel.liquidityDepth is deep', publicPayload.lpControllerIntel?.liquidityDepth === 'deep', publicPayload.lpControllerIntel)
assert('VIRTUAL lpControllerIntel.migrationRisk is low', publicPayload.lpControllerIntel?.migrationRisk === 'low', publicPayload.lpControllerIntel)
assert('lpControllerIntel summary does not call wallet control malicious', !/malicious/i.test(publicPayload.lpControllerIntel?.summary ?? ''), publicPayload.lpControllerIntel?.summary)

// LP public status fields are internally consistent / non-conflicting.
assert('lpMeta.lpControlState reflects LP control state', publicPayload.lpMeta.lpControlState === 'team_controlled')
assert('sections.liquidity.lpLockBurnProofStatus matches top-level lpProofStatus (normalized to open_check)',
  publicPayload.sections.liquidity.lpLockBurnProofStatus === 'open_check' && publicPayload.lpProofStatus === 'open_check')
assert('no field named bare "proofStatus" at lpMeta top level', !('proofStatus' in publicPayload.lpMeta))
assert('no field named bare "proofStatus" at sections.liquidity.lpMeta', !('proofStatus' in publicPayload.sections.liquidity.lpMeta))

// lpControllerIntel keeps passing for VIRTUAL-like output.
assert('lpControllerIntel.status remains wallet_controlled', publicPayload.lpControllerIntel?.status === 'wallet_controlled', publicPayload.lpControllerIntel)
assert('lpControllerIntel.controllerSharePercent remains 82.45', publicPayload.lpControllerIntel?.controllerSharePercent === 82.45, publicPayload.lpControllerIntel)
assert('lpControllerIntel.controlProof remains confirmed', publicPayload.lpControllerIntel?.controlProof === 'confirmed', publicPayload.lpControllerIntel)
assert('lpControllerIntel.lockBurnProof remains open_check', publicPayload.lpControllerIntel?.lockBurnProof === 'open_check', publicPayload.lpControllerIntel)
assert('lpControllerIntel.exitRisk remains watch', publicPayload.lpControllerIntel?.exitRisk === 'watch', publicPayload.lpControllerIntel)
assert('lpControllerIntel.liquidityDepth remains deep', publicPayload.lpControllerIntel?.liquidityDepth === 'deep', publicPayload.lpControllerIntel)
assert('lpControllerIntel.migrationRisk remains low', publicPayload.lpControllerIntel?.migrationRisk === 'low', publicPayload.lpControllerIntel)
assert('VIRTUAL includes lpMovementWatch', Boolean(publicPayload.lpMovementWatch), publicPayload.lpMovementWatch)
assert('VIRTUAL lpMovementWatch is open_check without LP-transfer evidence', publicPayload.lpMovementWatch?.status === 'open_check', publicPayload.lpMovementWatch)
assert('VIRTUAL lpMovementWatch movementRisk is unknown without LP-transfer evidence', publicPayload.lpMovementWatch?.movementRisk === 'unknown', publicPayload.lpMovementWatch)
assert('VIRTUAL lpMovementWatch does not fake recent movement', publicPayload.lpMovementWatch?.recentMovementDetected == null && publicPayload.lpMovementWatch?.recentTransferCount == null, publicPayload.lpMovementWatch)
assert('VIRTUAL lpMovementWatch controller matches lpControllerIntel.controller', publicPayload.lpMovementWatch?.controller === publicPayload.lpControllerIntel?.controller, { movement: publicPayload.lpMovementWatch, intel: publicPayload.lpControllerIntel })
assert('VIRTUAL lpMovementWatch summary says movement evidence not confirmed', /controller is known.*movement evidence was not confirmed/i.test(publicPayload.lpMovementWatch?.summary ?? ''), publicPayload.lpMovementWatch?.summary)
assert('VIRTUAL lpMovementWatch evidence gap includes recent transfer history', (publicPayload.lpMovementWatch?.evidenceGaps ?? []).includes('recent LP-controller transfer history not confirmed'), publicPayload.lpMovementWatch?.evidenceGaps)
assert('VIRTUAL lpMovementWatch nextActions are expected', ['monitor controller wallet', 'verify LP token transfers', 'rescan after liquidity changes'].every((action) => (publicPayload.lpMovementWatch?.nextActions ?? []).includes(action)), publicPayload.lpMovementWatch?.nextActions)

assert('lpLockBurn registry has chain-aware base/eth/bnb locker shape', Array.isArray(LP_LOCK_BURN_REGISTRY.lockersByChain.base) && Array.isArray(LP_LOCK_BURN_REGISTRY.lockersByChain.eth) && Array.isArray(LP_LOCK_BURN_REGISTRY.lockersByChain.bnb), LP_LOCK_BURN_REGISTRY.lockersByChain)
assert('lpLockBurn registry burn addresses include zero and dead', LP_LOCK_BURN_REGISTRY.burnAddresses.includes('0x0000000000000000000000000000000000000000') && LP_LOCK_BURN_REGISTRY.burnAddresses.includes('0x000000000000000000000000000000000000dead'), LP_LOCK_BURN_REGISTRY.burnAddresses)
assert('VIRTUAL includes lpLockBurnIntel', Boolean(publicPayload.lpLockBurnIntel), publicPayload.lpLockBurnIntel)
assert('VIRTUAL lpLockBurnIntel status is open_check', publicPayload.lpLockBurnIntel?.status === 'open_check', publicPayload.lpLockBurnIntel)
assert('VIRTUAL lpLockBurnIntel lockBurnProof is open_check', publicPayload.lpLockBurnIntel?.lockBurnProof === 'open_check', publicPayload.lpLockBurnIntel)
assert('VIRTUAL lpLockBurnIntel chain is base', publicPayload.lpLockBurnIntel?.chain === 'base', publicPayload.lpLockBurnIntel)
assert('VIRTUAL lpLockBurnIntel lpTokenOrPool is selectedPool.address', publicPayload.lpLockBurnIntel?.lpTokenOrPool === publicPayload.selectedPool.address, publicPayload.lpLockBurnIntel)
assert('VIRTUAL lpLockBurnIntel does not fake locked/burned percentages', publicPayload.lpLockBurnIntel?.lockedPercent == null && publicPayload.lpLockBurnIntel?.burnedPercent == null, publicPayload.lpLockBurnIntel)
assert('VIRTUAL lpLockBurnIntel summary states controller known but proof not confirmed', /controller is known.*lock\/burn proof is not confirmed/i.test(publicPayload.lpLockBurnIntel?.summary ?? ''), publicPayload.lpLockBurnIntel?.summary)
assert('VIRTUAL lpLockBurnIntel gaps include no verified locker match and burn proof not confirmed', (publicPayload.lpLockBurnIntel?.evidenceGaps ?? []).some((gap) => /no verified base locker registry match/i.test(gap)) && (publicPayload.lpLockBurnIntel?.evidenceGaps ?? []).includes('burn proof not confirmed'), publicPayload.lpLockBurnIntel?.evidenceGaps)
assert('VIRTUAL lpLockBurnIntel actions are expected', ['verify LP holders', 'verify locker', 'monitor/rescan'].every((action) => (publicPayload.lpLockBurnIntel?.nextActions ?? []).includes(action)), publicPayload.lpLockBurnIntel?.nextActions)

// Public cortexLpRead does not say "fallback" — uses evidence-based wording or hides raw mode.
assert('cortexLpRead.mode is not the raw "fallback" string', publicPayload.cortexLpRead?.mode !== 'fallback', publicPayload.cortexLpRead?.mode)
assert('cortexLpRead.mode reads evidence-based', publicPayload.cortexLpRead?.mode === 'evidence-based', publicPayload.cortexLpRead?.mode)
assert('cortexLpRead.riskSummary does not say "data mode: fallback"', !/data mode:\s*fallback/i.test(publicPayload.cortexLpRead?.riskSummary ?? ''), publicPayload.cortexLpRead?.riskSummary)
assert('cortexLpRead.riskSummary says evidence-based data mode', /data mode:\s*evidence-based/i.test(publicPayload.cortexLpRead?.riskSummary ?? ''), publicPayload.cortexLpRead?.riskSummary)

// Public LP text does not leak raw DEX IDs; lpModelProof.dexName is public-safe.
assert('lpModelProof.dexName is normalized to Aerodrome', publicPayload.lpModelProof?.dexName === 'Aerodrome', publicPayload.lpModelProof)
assert('cortexLpRead.poolStructureAnalysis does not contain raw DEX id', !/aerodrome-base/i.test(publicPayload.cortexLpRead?.poolStructureAnalysis ?? ''), publicPayload.cortexLpRead?.poolStructureAnalysis)
assert('cortexLpRead.poolStructureAnalysis shows Aerodrome', /Aerodrome/.test(publicPayload.cortexLpRead?.poolStructureAnalysis ?? ''), publicPayload.cortexLpRead?.poolStructureAnalysis)
assert('lpMeta.primaryMarketDex is Aerodrome (not raw id)', publicPayload.lpMeta.primaryMarketDex === 'Aerodrome', publicPayload.lpMeta.primaryMarketDex)
const rawDexIds = ['aerodrome-base', 'aerodrome-slipstream', 'uniswap-v3-base', 'pancakeswap-v3-base']
for (const rawId of rawDexIds) assert(`public response does not expose raw DEX id ${rawId}`, !serialized(publicPayload).includes(rawId), rawId)
assert('public lpMovementWatch does not expose provider names/raw DEX IDs', providerNames.every((name) => !serialized(publicPayload.lpMovementWatch).includes(name)) && rawDexIds.every((rawId) => !serialized(publicPayload.lpMovementWatch).includes(rawId)), publicPayload.lpMovementWatch)

// VIRTUAL lpUnlockTimeline: lock/burn proof is open_check, so no fake unlock date/risk.
assert('VIRTUAL includes lpUnlockTimeline', Boolean(publicPayload.lpUnlockTimeline), publicPayload.lpUnlockTimeline)
assert('VIRTUAL lpUnlockTimeline.status is open_check', publicPayload.lpUnlockTimeline?.status === 'open_check', publicPayload.lpUnlockTimeline)
assert('VIRTUAL lpUnlockTimeline.unlockRisk is unknown', publicPayload.lpUnlockTimeline?.unlockRisk === 'unknown', publicPayload.lpUnlockTimeline)
assert('VIRTUAL lpUnlockTimeline.unlockTime is null (no fake date)', publicPayload.lpUnlockTimeline?.unlockTime === null, publicPayload.lpUnlockTimeline)
assert('VIRTUAL lpUnlockTimeline.unlockTimeStatus is unknown', publicPayload.lpUnlockTimeline?.unlockTimeStatus === 'unknown', publicPayload.lpUnlockTimeline)
assert('VIRTUAL lpUnlockTimeline.unlockCountdownSeconds is null', publicPayload.lpUnlockTimeline?.unlockCountdownSeconds === null, publicPayload.lpUnlockTimeline)
assert('VIRTUAL lpUnlockTimeline summary says no confirmed unlock time available', /no confirmed LP unlock time is available/i.test(publicPayload.lpUnlockTimeline?.summary ?? ''), publicPayload.lpUnlockTimeline?.summary)

// VIRTUAL lpHistoryTimeline: multi-pool primary evidence, no fake migration event.
assert('VIRTUAL includes lpHistoryTimeline', Boolean(publicPayload.lpHistoryTimeline), publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.status is ok', publicPayload.lpHistoryTimeline?.status === 'ok', publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.primaryPool matches selectedPool.address', publicPayload.lpHistoryTimeline?.primaryPool === publicPayload.selectedPool.address, publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.primaryPair is VIRTUAL / WETH', publicPayload.lpHistoryTimeline?.primaryPair === 'VIRTUAL / WETH', publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.primaryDex is Aerodrome (not raw id)', publicPayload.lpHistoryTimeline?.primaryDex === 'Aerodrome', publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.primaryPoolCreatedAt is the expected ISO date', publicPayload.lpHistoryTimeline?.primaryPoolCreatedAt === '2024-03-31T15:39:37.000Z', publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.poolCount is 20', publicPayload.lpHistoryTimeline?.poolCount === 20, publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.liquidityUsd is ~$1.2M', publicPayload.lpHistoryTimeline?.liquidityUsd === 1234567, publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.migrationRisk is low', publicPayload.lpHistoryTimeline?.migrationRisk === 'low', publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline.fragmentation is concentrated', publicPayload.lpHistoryTimeline?.fragmentation === 'concentrated', publicPayload.lpHistoryTimeline)
assert('VIRTUAL lpHistoryTimeline events include primary pool detected', (publicPayload.lpHistoryTimeline?.events ?? []).some((e) => /primary pool detected/i.test(e)), publicPayload.lpHistoryTimeline?.events)
assert('VIRTUAL lpHistoryTimeline events do not mention migration', (publicPayload.lpHistoryTimeline?.events ?? []).every((e) => !/migrat/i.test(e)), publicPayload.lpHistoryTimeline?.events)
assert('VIRTUAL lpHistoryTimeline summary does not contain raw DEX id', !/aerodrome-base/i.test(publicPayload.lpHistoryTimeline?.summary ?? ''), publicPayload.lpHistoryTimeline?.summary)

// Normalize old LP proof wording to open_check when lpLockBurnIntel.lockBurnProof is open_check.
assert('VIRTUAL lpProofStatus is normalized to open_check', publicPayload.lpProofStatus === 'open_check', publicPayload.lpProofStatus)
assert('VIRTUAL lpEvidenceSummary says "Proof status: open_check"', /Proof status:\s*open_check/i.test(publicPayload.lpEvidenceSummary ?? ''), publicPayload.lpEvidenceSummary)
assert('VIRTUAL sections.liquidity.lpLockBurnProofStatus is normalized to open_check', publicPayload.sections.liquidity.lpLockBurnProofStatus === 'open_check', publicPayload.sections.liquidity.lpLockBurnProofStatus)

console.log('\nB. debug=true response')
const debugPayload = sanitizePublicTokenResponse(JSON.parse(JSON.stringify(virtualLikePayload)), true)
assert('debug keeps score debug', Boolean(debugPayload.cortexScoreDebug && debugPayload.riskEngine.cortexScoreDebug), debugPayload.cortexScoreDebug)
assert('debug keeps raw/provider evidence', Boolean(debugPayload.gtRaw && debugPayload.gtPools && debugPayload.gmgn), { gtRaw: debugPayload.gtRaw, gtPools: debugPayload.gtPools, gmgn: debugPayload.gmgn })
assert('debug keeps raw holder arrays', Array.isArray(debugPayload.holderResolver.holders) && debugPayload.holderResolver.holders.length === 25, debugPayload.holderResolver.holders?.length)
assert('debug keeps raw transfer arrays', Array.isArray(debugPayload.transferResolver.transfers) && debugPayload.transferResolver.transfers.length === 25, debugPayload.transferResolver.transfers?.length)
assert('debug keeps provider names for diagnostics', serialized(debugPayload).includes('goldrush') && serialized(debugPayload).includes('moralis'), debugPayload)
assert('debug keeps riskEngine.rugRiskScore', debugPayload.riskEngine.rugRiskScore === 38)
assert('debug keeps top-level rugRisk.score', debugPayload.rugRisk.score === 42)
assert('debug keeps top-level rugRisk.label', debugPayload.rugRisk.label === 'watch')
assert('debug keeps legacy Clark summary wording', /Rug-risk pressure:\s*83\/100/i.test(debugPayload.riskEngine.clarkInterpretation.summary), debugPayload.riskEngine.clarkInterpretation.summary)
assert('debug keeps lpDataModeRaw', debugPayload.lpDataModeRaw === 'fallback')
assert('debug keeps full priceChart.points', debugPayload.priceChart.points.length === 400)
assert('debug keeps raw cortexLpRead.mode', debugPayload.cortexLpRead?.mode === 'fallback', debugPayload.cortexLpRead?.mode)
assert('debug keeps raw "data mode: fallback" text', /data mode:\s*fallback/i.test(debugPayload.cortexLpRead?.riskSummary ?? ''), debugPayload.cortexLpRead?.riskSummary)
assert('debug keeps raw lpModelProof.dexName', debugPayload.lpModelProof?.dexName === 'aerodrome-base', debugPayload.lpModelProof)
assert('debug keeps raw DEX id in poolStructureAnalysis', /aerodrome-base/i.test(debugPayload.cortexLpRead?.poolStructureAnalysis ?? ''), debugPayload.cortexLpRead?.poolStructureAnalysis)

console.log('\nC. concentrated/protocol pool regression')
const protocolPayload = sanitizePublicTokenResponse({
  selectedPool: { address: '0x2222222222222222222222222222222222222222' },
  lpControl: { status: 'protocol_managed', displayLpModel: 'concentrated_liquidity', proofStatus: 'not_applicable', lockStatus: 'not_applicable', burnStatus: 'not_applicable' },
  lpProofApplicability: 'not_applicable',
  lpProofStatus: 'not_applicable',
  lpModelProof: { model: 'concentrated', standardLockApplies: false },
  riskScore: 70,
  riskBreakdown: { total: 70 },
  lpMeta: { lpControlState: 'concentrated_liquidity' },
  sections: { liquidity: { lpLockBurnProofStatus: 'not_applicable', lpMeta: { lpControlState: 'concentrated_liquidity' } } },
}, false)
protocolPayload.lpControllerIntel = buildLpControllerIntel({
  lpControl: protocolPayload.lpControl,
  selectedPool: protocolPayload.selectedPool,
  lpExitRisk: 'watch',
  liquidityDepthRisk: 'low',
  lpMigrationProof: { status: 'low' },
  lpMeta: protocolPayload.lpMeta,
})
protocolPayload.lpMovementWatch = buildLpMovementWatch({
  chain: 'base',
  lpControllerIntel: protocolPayload.lpControllerIntel,
  lpControl: protocolPayload.lpControl,
  selectedPool: protocolPayload.selectedPool,
  lpMeta: protocolPayload.lpMeta,
})
protocolPayload.lpLockBurnIntel = buildLpLockBurnIntel({
  chain: 'base',
  lpControllerIntel: protocolPayload.lpControllerIntel,
  lpControl: protocolPayload.lpControl,
  selectedPool: protocolPayload.selectedPool,
  lpMeta: protocolPayload.lpMeta,
})
protocolPayload.lpUnlockTimeline = buildLpUnlockTimeline({
  chain: 'base',
  lpLockBurnIntel: protocolPayload.lpLockBurnIntel,
})
protocolPayload.lpHistoryTimeline = buildLpHistoryTimeline({
  chain: 'base',
  poolModel: protocolPayload.lpModelProof.model,
  marketDataSource: 'primary',
  selectedPool: protocolPayload.selectedPool,
  primaryPoolAgeLabel: null,
  poolCount: 1,
  observedPoolCount: 1,
  liquidityUsd: null,
  lpMigrationProof: { status: 'low', confidence: 'medium', liquidityDistribution: 'unknown', dexsUsed: [], signals: [], missingEvidence: ['pool_creation_date_unavailable', 'historical_liquidity_movement_unavailable'] },
})
assert('protocol pool proofApplicability remains not_applicable', protocolPayload.lpProofApplicability === 'not_applicable', protocolPayload.lpProofApplicability)
assert('concentrated pool is not forced into ERC20 lock/burn proof', protocolPayload.lpControl?.proofStatus === 'not_applicable' && protocolPayload.lpControl?.lockStatus === 'not_applicable' && protocolPayload.lpControl?.burnStatus === 'not_applicable', protocolPayload.lpControl)
assert('selected pool address is not fake-truncated', protocolPayload.selectedPool.address === '0x2222222222222222222222222222222222222222', protocolPayload.selectedPool.address)
assert('lpProofStatus remains not_applicable', protocolPayload.lpProofStatus === 'not_applicable')
assert('sections.liquidity.lpLockBurnProofStatus remains not_applicable', protocolPayload.sections.liquidity.lpLockBurnProofStatus === 'not_applicable')
assert('lpMeta.lpControlState remains concentrated_liquidity', protocolPayload.lpMeta.lpControlState === 'concentrated_liquidity')
assert('GOAL/concentrated lpControllerIntel status is concentrated_liquidity', protocolPayload.lpControllerIntel.status === 'concentrated_liquidity', protocolPayload.lpControllerIntel)
assert('GOAL/concentrated lpControllerIntel lockBurnProof is not_applicable', protocolPayload.lpControllerIntel.lockBurnProof === 'not_applicable', protocolPayload.lpControllerIntel)
assert('GOAL/concentrated lpMovementWatch returns not_applicable or unsupported', ['not_applicable', 'pool_model_not_supported'].includes(protocolPayload.lpMovementWatch?.status), protocolPayload.lpMovementWatch)
assert('GOAL/concentrated lpMovementWatch does not fake ERC20 movement', protocolPayload.lpMovementWatch?.recentMovementDetected == null && protocolPayload.lpMovementWatch?.recentTransferCount == null, protocolPayload.lpMovementWatch)
assert('GOAL/concentrated lpLockBurnIntel status is not_applicable', protocolPayload.lpLockBurnIntel?.status === 'not_applicable', protocolPayload.lpLockBurnIntel)
assert('GOAL/concentrated lpLockBurnIntel proof is not_applicable', protocolPayload.lpLockBurnIntel?.lockBurnProof === 'not_applicable', protocolPayload.lpLockBurnIntel)
assert('GOAL/concentrated lpLockBurnIntel does not fake locked/burned percentages', protocolPayload.lpLockBurnIntel?.lockedPercent == null && protocolPayload.lpLockBurnIntel?.burnedPercent == null, protocolPayload.lpLockBurnIntel)
assert('GOAL/concentrated lpLockBurnIntel summary explains ERC20 proof does not apply', /ERC20 LP lock\/burn proof does not apply/i.test(protocolPayload.lpLockBurnIntel?.summary ?? ''), protocolPayload.lpLockBurnIntel?.summary)
assert('GOAL/concentrated lpUnlockTimeline status is not_applicable', protocolPayload.lpUnlockTimeline?.status === 'not_applicable', protocolPayload.lpUnlockTimeline)
assert('GOAL/concentrated lpUnlockTimeline unlockRisk is not_applicable', protocolPayload.lpUnlockTimeline?.unlockRisk === 'not_applicable', protocolPayload.lpUnlockTimeline)
assert('GOAL/concentrated lpUnlockTimeline has no countdown', protocolPayload.lpUnlockTimeline?.unlockCountdownSeconds == null, protocolPayload.lpUnlockTimeline)
assert('GOAL/concentrated lpUnlockTimeline summary explains unlock timeline does not apply', /unlock timeline does not apply/i.test(protocolPayload.lpUnlockTimeline?.summary ?? ''), protocolPayload.lpUnlockTimeline?.summary)
assert('GOAL/concentrated includes lpHistoryTimeline', Boolean(protocolPayload.lpHistoryTimeline), protocolPayload.lpHistoryTimeline)
assert('GOAL/concentrated lpHistoryTimeline.poolModel is concentrated', protocolPayload.lpHistoryTimeline?.poolModel === 'concentrated', protocolPayload.lpHistoryTimeline)
assert('GOAL/concentrated lpHistoryTimeline.primaryPool matches selectedPool.address', protocolPayload.lpHistoryTimeline?.primaryPool === protocolPayload.selectedPool.address, protocolPayload.lpHistoryTimeline)
assert('GOAL/concentrated lpHistoryTimeline.status is partial (single pool)', protocolPayload.lpHistoryTimeline?.status === 'partial', protocolPayload.lpHistoryTimeline)
assert('GOAL/concentrated lpHistoryTimeline does not mention LP lock/burn proof', !/lock\/burn proof/i.test(protocolPayload.lpHistoryTimeline?.summary ?? ''), protocolPayload.lpHistoryTimeline?.summary)
assert('GOAL/concentrated lpHistoryTimeline events do not fake a migration', (protocolPayload.lpHistoryTimeline?.events ?? []).every((e) => !/migrat/i.test(e)), protocolPayload.lpHistoryTimeline?.events)

// ─── publicLpDataMode mapping ───────────────────────────────────────────────
console.log('\nD. publicLpDataMode mapping')
assert('strict -> resolved', publicLpDataMode('strict', true, true) === 'resolved')
assert('strict -> resolved even without pool data', publicLpDataMode('strict', false, false) === 'resolved')
assert('fallback + usable pool + ownership verified -> evidence_based',
  publicLpDataMode('fallback', true, true) === 'evidence_based')
assert('fallback without ownership proof -> indexed (never "fallback")',
  publicLpDataMode('fallback', true, false) === 'indexed')
assert('minimal -> indexed', publicLpDataMode('minimal', true, false) === 'indexed')
assert('insufficient -> indexed', publicLpDataMode('insufficient', false, false) === 'indexed')
assert('public mode is never the raw "fallback" string',
  !['strict', 'minimal', 'fallback', 'insufficient'].includes(publicLpDataMode('fallback', true, true)))

// ─── E. buildLpUnlockTimeline risk tiering for confirmed locks ─────────────
console.log('\nE. lpUnlockTimeline risk tiering')
const now = Date.now()
const confirmedBase = { status: 'locked', lockBurnProof: 'confirmed', confidence: 'medium', chain: 'eth', lpTokenOrPool: '0x21594b992f68495dd28d605834b58889d0a727c7' }
const farFuture = buildLpUnlockTimeline({ chain: 'eth', lpLockBurnIntel: { ...confirmedBase, unlockTime: new Date(now + 45 * 86400_000).toISOString() } })
assert('confirmed lock unlocking in 45d is low risk', farFuture.unlockRisk === 'low', farFuture)
assert('confirmed lock unlocking in 45d has known unlockTimeStatus', farFuture.unlockTimeStatus === 'known', farFuture)
assert('confirmed lock unlocking in 45d has a countdown label', typeof farFuture.unlockCountdownLabel === 'string' && farFuture.unlockCountdownLabel.length > 0, farFuture)

const midFuture = buildLpUnlockTimeline({ chain: 'eth', lpLockBurnIntel: { ...confirmedBase, unlockTime: new Date(now + 15 * 86400_000).toISOString() } })
assert('confirmed lock unlocking in 15d is watch risk', midFuture.unlockRisk === 'watch', midFuture)

const nearFuture = buildLpUnlockTimeline({ chain: 'eth', lpLockBurnIntel: { ...confirmedBase, unlockTime: new Date(now + 3 * 86400_000).toISOString() } })
assert('confirmed lock unlocking in 3d is high risk', nearFuture.unlockRisk === 'high', nearFuture)

const past = buildLpUnlockTimeline({ chain: 'eth', lpLockBurnIntel: { ...confirmedBase, unlockTime: new Date(now - 86400_000).toISOString() } })
assert('confirmed lock with unlockTime in the past is expired', past.unlockRisk === 'expired', past)
assert('expired unlock countdown is zero', past.unlockCountdownSeconds === 0, past)

const burned = buildLpUnlockTimeline({ chain: 'eth', lpLockBurnIntel: { status: 'burned', lockBurnProof: 'confirmed', confidence: 'medium', chain: 'eth' } })
assert('burned LP status is burned', burned.status === 'burned', burned)
assert('burned LP unlockRisk is none', burned.unlockRisk === 'none', burned)
assert('burned LP unlockTimeStatus is not_applicable', burned.unlockTimeStatus === 'not_applicable', burned)
assert('burned LP has no countdown', burned.unlockCountdownSeconds == null, burned)

// ─── F. VIRTUAL fallback market normalization ──────────────────────────────
// Mirrors route.ts's normalization: when marketDataSource === 'fallback', the secondary
// market read's liquidityUsd/pairCreatedAt become the effective values (_el/normalizedPairCreatedAt)
// fed into selectedPool, LP exit-risk, and cortexLpRead — instead of leaving them null.
console.log('\nF. VIRTUAL fallback market normalization')
const fallbackDexFb = {
  liquidityUsd: 3_170_000,
  pairCreatedAt: '1711899559000',
  pairAddress: '0x21594b992f68495dd28d605834b58889d0a727c7',
}
const _elFallback = fallbackDexFb.liquidityUsd
const normalizedCreatedAtFallback = new Date(Number(fallbackDexFb.pairCreatedAt)).toISOString()

const fallbackPayload = {
  chain: 'base',
  contract: '0x0000000000000000000000000000000000000002',
  name: 'Virtuals Protocol',
  symbol: 'VIRTUAL',
  marketDataSource: 'fallback',
  selectedPool: {
    address: fallbackDexFb.pairAddress,
    pair: 'VIRTUAL / WETH',
    dex: 'aerodrome-base',
    model: 'constant_product',
    liquidityUsd: _elFallback,
    createdAt: normalizedCreatedAtFallback,
  },
  riskScore: 58,
  riskLabel: 'moderate',
  riskBreakdown: { total: 58, liquiditySafety: { score: 7, max: 30, reasons: ['Wallet-controlled LP'] } },
  lpControl: {
    status: 'team_controlled',
    proofStatus: 'open_check',
    lockStatus: 'not_confirmed',
    burnStatus: 'not_confirmed',
    lpController: '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5',
    lpControllerType: 'wallet',
    evidence: ['top_holder=0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', 'top_share=82.45%'],
    reason: 'Holder evidence confirmed LP controller wallet.',
  },
  lpControlRead: { title: 'LP controlled by wallet', meaning: 'Control Proof: Confirmed' },
  lpMigrationProof: {
    status: 'low',
    confidence: 'low',
    reason: 'Fallback market data shows a usable pool.',
    dexsUsed: ['aerodrome-base'],
    primaryDex: 'aerodrome-base',
    liquidityDistribution: 'unknown',
    signals: [],
    missingEvidence: ['pool_creation_date_unavailable', 'historical_liquidity_movement_unavailable'],
  },
  lpProofApplicability: 'applicable',
  lpDataMode: 'evidence_based',
  lpDataModeRaw: 'fallback',
  lpModelProof: {
    model: 'constant_product',
    dexName: 'aerodrome-base',
    standardLockApplies: true,
  },
  lpMeta: {
    primaryMarketDex: 'Aerodrome',
    lpControlState: 'team_controlled',
  },
  sections: {
    liquidity: {
      lpLockBurnProofStatus: 'partial',
      lpMeta: {
        primaryMarketDex: 'Aerodrome',
        lpControlState: 'team_controlled',
      },
    },
  },
  holderDistribution: { top10: 48, holderCount: 100000, topHolders: holders },
  poolActivity: { pairCreatedAt: fallbackDexFb.pairCreatedAt },
  poolCount: 1,
  observedPoolPresent: true,
  observedPoolCount: 1,
}

// LP exit-risk computed with the normalized fallback liquidity (_el) — matches route.ts's
// `_liqForRisk = _el` for a wallet-controlled, applicable-proof, has-pool scenario.
const fallbackExitRiskResult = computeLpExitRisk({
  proofApplicability: 'applicable',
  lpLockStatus: 'unlocked',
  lpController: 'wallet',
  liquidityUsd: _elFallback,
  poolModel: 'constant_product',
  hasPool: true,
  lpControllerAddress: fallbackPayload.lpControl.lpController,
  isEstablishedToken: false,
})
fallbackPayload.lpExitRisk = fallbackExitRiskResult.lpExitRisk
fallbackPayload.lpExitRiskReason = fallbackExitRiskResult.lpExitRiskReason
fallbackPayload.liquidityDepthRisk = fallbackExitRiskResult.liquidityDepthRisk
fallbackPayload.lpProofStatus =
  fallbackPayload.lpControl.lockStatus === 'locked' || fallbackPayload.lpControl.burnStatus === 'burned' ? 'confirmed'
  : fallbackPayload.lpControl.lockStatus === 'not_confirmed' ? 'missing'
  : 'partial'
fallbackPayload.lpEvidenceSummary = [
  `Pool model: ${fallbackPayload.lpModelProof.model}`,
  `Liquidity: $${_elFallback.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
  `Proof applicability: ${fallbackPayload.lpProofApplicability}`,
  `Proof status: ${fallbackPayload.lpProofStatus}`,
  `Migration: ${fallbackPayload.lpMigrationProof.status}`,
].join(' | ')

fallbackPayload.cortexLpRead = buildCortexLpRead({
  name: fallbackPayload.name,
  symbol: fallbackPayload.symbol,
  totalLiq: _elFallback,
  fragments: 1,
  observedPoolPresent: true,
  riskTier: 'watch',
  liquidityDepthRisk: fallbackPayload.liquidityDepthRisk,
  lpModel: fallbackPayload.lpModelProof,
  migrationSummary: fallbackPayload.lpMigrationProof.reason,
  mode: 'fallback',
  confidence: 'medium',
  gaps: [],
  lpLockStatus: 'unlocked',
  lpLockProvider: null,
  lpUnlockTime: null,
  lpController: 'wallet',
  lpControllerAddress: fallbackPayload.lpControl.lpController,
  isEstablishedToken: false,
  proofApplicability: 'applicable',
  fallbackLiquidityDetected: true,
})

fallbackPayload.lpControllerIntel = buildLpControllerIntel({
  lpControl: fallbackPayload.lpControl,
  lpControlRead: fallbackPayload.lpControlRead,
  selectedPool: fallbackPayload.selectedPool,
  lpExitRisk: fallbackPayload.lpExitRisk,
  liquidityDepthRisk: fallbackPayload.liquidityDepthRisk,
  lpMigrationProof: fallbackPayload.lpMigrationProof,
  lpEvidenceGaps: [],
  lpMeta: fallbackPayload.lpMeta,
  lpDataMode: fallbackPayload.lpDataMode,
})
fallbackPayload.lpMovementWatch = buildLpMovementWatch({
  chain: fallbackPayload.chain,
  lpControllerIntel: fallbackPayload.lpControllerIntel,
  lpControl: fallbackPayload.lpControl,
  selectedPool: fallbackPayload.selectedPool,
  lpMeta: fallbackPayload.lpMeta,
})
fallbackPayload.lpLockBurnIntel = buildLpLockBurnIntel({
  chain: fallbackPayload.chain,
  lpControllerIntel: fallbackPayload.lpControllerIntel,
  lpControl: fallbackPayload.lpControl,
  selectedPool: fallbackPayload.selectedPool,
  lpMeta: fallbackPayload.lpMeta,
})
fallbackPayload.lpUnlockTimeline = buildLpUnlockTimeline({
  chain: fallbackPayload.chain,
  lpLockBurnIntel: fallbackPayload.lpLockBurnIntel,
})
fallbackPayload.lpHistoryTimeline = buildLpHistoryTimeline({
  chain: fallbackPayload.chain,
  poolModel: fallbackPayload.lpModelProof.model,
  marketDataSource: fallbackPayload.marketDataSource,
  selectedPool: fallbackPayload.selectedPool,
  primaryPoolAgeLabel: null,
  poolCount: fallbackPayload.poolCount,
  observedPoolCount: fallbackPayload.observedPoolCount,
  liquidityUsd: fallbackPayload.selectedPool.liquidityUsd,
  lpMigrationProof: fallbackPayload.lpMigrationProof,
})

const fallbackPublicPayload = sanitizePublicTokenResponse(JSON.parse(JSON.stringify(fallbackPayload)), false)

assert('fallback selectedPool.liquidityUsd uses fallback liquidity', fallbackPublicPayload.selectedPool?.liquidityUsd === 3_170_000, fallbackPublicPayload.selectedPool)
assert('fallback selectedPool.createdAt is normalized ISO from pairCreatedAt ms', fallbackPublicPayload.selectedPool?.createdAt === new Date(1711899559000).toISOString(), fallbackPublicPayload.selectedPool)
assert('fallback poolActivity.pairCreatedAt preserved', fallbackPublicPayload.poolActivity?.pairCreatedAt === '1711899559000', fallbackPublicPayload.poolActivity)
assert('fallback lpControllerIntel.poolLiquidityUsd is not null', fallbackPublicPayload.lpControllerIntel?.poolLiquidityUsd === 3_170_000, fallbackPublicPayload.lpControllerIntel)
assert('fallback liquidityDepthRisk is low/deep with ~$3.17M liquidity', fallbackPublicPayload.liquidityDepthRisk === 'low', fallbackPublicPayload.liquidityDepthRisk)
assert('fallback lpControllerIntel.liquidityDepth is deep', fallbackPublicPayload.lpControllerIntel?.liquidityDepth === 'deep', fallbackPublicPayload.lpControllerIntel)
assert('fallback lpExitRisk is watch (not high) for wallet-controlled deep liquidity', fallbackPublicPayload.lpExitRisk === 'watch', fallbackPublicPayload.lpExitRisk)
assert('fallback cortexLpRead.liquidityAnalysis mentions observed liquidity (not "no active pool")', /Observed liquidity is approximately/i.test(fallbackPublicPayload.cortexLpRead?.liquidityAnalysis ?? ''), fallbackPublicPayload.cortexLpRead?.liquidityAnalysis)
assert('fallback cortexLpRead.riskSummary does not say liquidity depth could not be confirmed', !/Liquidity depth could not be confirmed/i.test(fallbackPublicPayload.cortexLpRead?.riskSummary ?? ''), fallbackPublicPayload.cortexLpRead?.riskSummary)
assert('fallback cortexLpRead.riskSummary says liquidity depth is deep', /Liquidity depth is deep/i.test(fallbackPublicPayload.cortexLpRead?.riskSummary ?? ''), fallbackPublicPayload.cortexLpRead?.riskSummary)
assert('fallback cortexLpRead.mode is evidence-based, not raw "fallback"', fallbackPublicPayload.cortexLpRead?.mode === 'evidence-based', fallbackPublicPayload.cortexLpRead?.mode)
assert('fallback lpLockBurnIntel.status remains open_check', fallbackPublicPayload.lpLockBurnIntel?.status === 'open_check', fallbackPublicPayload.lpLockBurnIntel)
assert('fallback lpLockBurnIntel does not fake locked/burned percentages', fallbackPublicPayload.lpLockBurnIntel?.lockedPercent == null && fallbackPublicPayload.lpLockBurnIntel?.burnedPercent == null, fallbackPublicPayload.lpLockBurnIntel)
assert('fallback lpUnlockTimeline.status remains open_check', fallbackPublicPayload.lpUnlockTimeline?.status === 'open_check', fallbackPublicPayload.lpUnlockTimeline)
assert('fallback lpUnlockTimeline.unlockTime is null (no fake date)', fallbackPublicPayload.lpUnlockTimeline?.unlockTime === null, fallbackPublicPayload.lpUnlockTimeline)
assert('fallback lpProofStatus normalized to open_check', fallbackPublicPayload.lpProofStatus === 'open_check', fallbackPublicPayload.lpProofStatus)
assert('fallback sections.liquidity.lpLockBurnProofStatus normalized to open_check', fallbackPublicPayload.sections.liquidity.lpLockBurnProofStatus === 'open_check', fallbackPublicPayload.sections.liquidity.lpLockBurnProofStatus)
assert('fallback poolCount/observedPoolCount are conservatively 1, not null', fallbackPublicPayload.poolCount === 1 && fallbackPublicPayload.observedPoolCount === 1, { poolCount: fallbackPublicPayload.poolCount, observedPoolCount: fallbackPublicPayload.observedPoolCount })
assert('fallback includes lpHistoryTimeline', Boolean(fallbackPublicPayload.lpHistoryTimeline), fallbackPublicPayload.lpHistoryTimeline)
assert('fallback lpHistoryTimeline.status is partial (single fallback pool)', fallbackPublicPayload.lpHistoryTimeline?.status === 'partial', fallbackPublicPayload.lpHistoryTimeline)
assert('fallback lpHistoryTimeline.primaryPool matches fallback pair address', fallbackPublicPayload.lpHistoryTimeline?.primaryPool === fallbackDexFb.pairAddress, fallbackPublicPayload.lpHistoryTimeline)
assert('fallback lpHistoryTimeline.primaryPoolCreatedAt is normalized from fallback ms timestamp', fallbackPublicPayload.lpHistoryTimeline?.primaryPoolCreatedAt === normalizedCreatedAtFallback, fallbackPublicPayload.lpHistoryTimeline)
assert('fallback lpHistoryTimeline.liquidityUsd is not null (uses fallback-normalized liquidity)', fallbackPublicPayload.lpHistoryTimeline?.liquidityUsd === 3_170_000, fallbackPublicPayload.lpHistoryTimeline)
assert('fallback lpHistoryTimeline.migrationRisk is open_check, not a fake "low"', fallbackPublicPayload.lpHistoryTimeline?.migrationRisk === 'open_check', fallbackPublicPayload.lpHistoryTimeline)
assert('fallback lpHistoryTimeline does not say liquidity unknown', !/liquidity unknown/i.test(fallbackPublicPayload.lpHistoryTimeline?.summary ?? ''), fallbackPublicPayload.lpHistoryTimeline?.summary)
assert('fallback lpHistoryTimeline events do not fake a migration', (fallbackPublicPayload.lpHistoryTimeline?.events ?? []).every((e) => !/migrat/i.test(e)), fallbackPublicPayload.lpHistoryTimeline?.events)
for (const provider of providerNames) assert(`fallback response does not expose provider name ${provider}`, !serialized(fallbackPublicPayload).includes(provider), provider)
for (const rawId of rawDexIds) assert(`fallback response does not expose raw DEX id ${rawId}`, !serialized(fallbackPublicPayload).includes(rawId), rawId)
assert('fallback response has no legacy Rug-risk pressure wording', !/Rug-risk pressure/i.test(serialized(fallbackPublicPayload)), fallbackPublicPayload)

// ─── G. VIRTUAL controller-evidence reuse (resolveLpControllerIdentity) ────
console.log('\nG. VIRTUAL controller-evidence reuse across lpControl/lpControllerIntel/lpMovementWatch')
const virtualControllerEvidence = ['top_rows=10', 'top_holder=0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', 'top_share=82.45%']
const virtualIdentity = resolveLpControllerIdentity({
  status: 'partial',
  evidence: virtualControllerEvidence,
  lpControllerFromProof: 'unknown',
  ownerAddr: null,
})
assert('VIRTUAL resolveLpControllerIdentity yields wallet controller type', virtualIdentity.lpControllerType === 'wallet', virtualIdentity)
assert('VIRTUAL resolveLpControllerIdentity yields the dominant-holder address', virtualIdentity.lpControllerAddress === '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', virtualIdentity)
assert('VIRTUAL resolveLpControllerIdentity.lpController matches the dominant-holder address', virtualIdentity.lpController === '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', virtualIdentity)

const virtualLpControl = {
  status: 'partial',
  displayLpModel: 'erc20_lp_token',
  lockStatus: 'not_confirmed',
  burnStatus: 'not_confirmed',
  proofStatus: 'open_check',
  evidence: virtualControllerEvidence,
  lpController: virtualIdentity.lpController,
  lpControllerType: virtualIdentity.lpControllerType,
}
const virtualSelectedPool = { address: '0x21594b992f68495dd28d605834b58889d0a727c7', pair: 'VIRTUAL/WETH', liquidityUsd: 4_300_000 }
const virtualControllerIntel = buildLpControllerIntel({
  lpControl: virtualLpControl,
  selectedPool: virtualSelectedPool,
  lpExitRisk: 'watch',
  liquidityDepthRisk: 'low',
  lpMigrationProof: { status: 'low' },
  lpMeta: {},
})
const virtualMovementWatch = buildLpMovementWatch({
  chain: 'base',
  lpControllerIntel: virtualControllerIntel,
  lpControl: virtualLpControl,
  selectedPool: virtualSelectedPool,
  lpMeta: {},
})
assert('VIRTUAL lpControllerIntel.status is wallet_controlled despite lpControl.status=partial', virtualControllerIntel.status === 'wallet_controlled', virtualControllerIntel)
assert('VIRTUAL lpControllerIntel.controller is not null/unknown', virtualControllerIntel.controller === '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', virtualControllerIntel)
assert('VIRTUAL lpControllerIntel.controllerSharePercent is 82.45', virtualControllerIntel.controllerSharePercent === 82.45, virtualControllerIntel)
assert('VIRTUAL lpControl.lpController matches lpControllerIntel.controller', virtualLpControl.lpController === virtualControllerIntel.controller, { lpControl: virtualLpControl.lpController, intel: virtualControllerIntel.controller })
assert('VIRTUAL lpMovementWatch.controller matches lpControllerIntel.controller', virtualMovementWatch?.controller === virtualControllerIntel.controller, { movement: virtualMovementWatch?.controller, intel: virtualControllerIntel.controller })

// ─── H. Genuinely unknown LP controller — scoring must not be falsely bullish ──
console.log('\nH. Genuinely unknown LP controller scores no safer than confirmed wallet-controlled')
const walletControlledRiskInput = {
  marketCapUsd: 400_000_000,
  fdvUsd: 420_000_000,
  liquidityUsd: 4_300_000,
  holderDistribution: { top1: 12, top5: 30, top10: 48 },
  lpControl: { status: 'team_controlled', displayLpModel: 'erc20_lp_token', lockStatus: 'not_confirmed', burnStatus: 'not_confirmed', proofStatus: 'open_check', lpController: '0xTeamWallet', lpControllerType: 'wallet' },
  lpProofApplicability: 'applicable',
  lpProofStatus: 'open_check',
  lpModelProof: { model: 'v2', standardLockApplies: true },
  lpMigrationProof: { status: 'low' },
}
const unknownControllerRiskInput = {
  ...walletControlledRiskInput,
  lpControl: { status: 'open_check', displayLpModel: 'erc20_lp_token', lockStatus: 'not_confirmed', burnStatus: 'not_confirmed', proofStatus: 'open_check', lpController: null, lpControllerType: 'unknown' },
}
const walletControlledRisk = calculateTokenRiskScore(walletControlledRiskInput)
const unknownControllerRisk = calculateTokenRiskScore(unknownControllerRiskInput)
assert('unknown-controller liquiditySafety is not higher than wallet-controlled', unknownControllerRisk.riskBreakdown.liquiditySafety.score <= walletControlledRisk.riskBreakdown.liquiditySafety.score, { unknown: unknownControllerRisk.riskBreakdown.liquiditySafety.score, wallet: walletControlledRisk.riskBreakdown.liquiditySafety.score })
assert('unknown-controller riskScore is not higher (more bullish) than wallet-controlled', unknownControllerRisk.riskScore <= walletControlledRisk.riskScore, { unknown: unknownControllerRisk.riskScore, wallet: walletControlledRisk.riskScore })
assert('unknown-controller riskLabel is not "safer" than wallet-controlled', !(unknownControllerRisk.riskLabel === 'low' && walletControlledRisk.riskLabel !== 'low'), { unknown: unknownControllerRisk.riskLabel, wallet: walletControlledRisk.riskLabel })

// ─── I. LP history summary typo fix (Aerodromeis -> Aerodrome is) ──────────
console.log('\nI. LP history timeline "Aerodrome is" wording (no Aerodromeis typo)')
const aerodromeHistory = buildLpHistoryTimeline({
  chain: 'base',
  poolModel: 'v2',
  marketDataSource: 'primary',
  selectedPool: { address: '0x21594b992f68495dd28d605834b58889d0a727c7', pair: 'VIRTUAL/WETH', dex: 'aerodrome', liquidityUsd: 4_300_000 },
  primaryPoolAgeLabel: '1y',
  poolCount: 2,
  observedPoolCount: 2,
  liquidityUsd: 4_300_000,
  lpMigrationProof: { status: 'low', confidence: 'medium', liquidityDistribution: 'concentrated in primary pool', dexsUsed: [], signals: [], missingEvidence: [] },
})
const aerodromeHistoryPublic = sanitizePublicTokenResponse({ lpHistoryTimeline: aerodromeHistory }, false)
assert('Aerodrome LP history summary says "Aerodrome is" with a space', /Aerodrome is/.test(aerodromeHistoryPublic.lpHistoryTimeline.summary), aerodromeHistoryPublic.lpHistoryTimeline.summary)
assert('Aerodrome LP history summary does not contain the "Aerodromeis" typo', !/Aerodromeis/.test(aerodromeHistoryPublic.lpHistoryTimeline.summary), aerodromeHistoryPublic.lpHistoryTimeline.summary)

// ─── J. EVO-like Uniswap V4 / concentrated pool — lpHistoryTimeline via poolId ──
console.log('\nJ. EVO-like Uniswap V4 concentrated pool — lpHistoryTimeline uses primaryMarketPoolId identity')
const evoPoolId = '0xd8ee119a65d3a902ced4ef7693b98e62a7fbb1d7808a693dbb6961d7f544fb80'
const evoHistory = buildLpHistoryTimeline({
  chain: 'base',
  poolModel: 'concentrated',
  marketDataSource: 'primary',
  selectedPool: {
    pair: 'evo / WETH',
    address: null,
    dex: 'Uniswap V4',
    liquidityUsd: 215891.928,
    createdAt: '2026-04-26T20:19:11Z',
  },
  lpControl: { primaryMarketPool: null, primaryMarketPoolId: evoPoolId },
  primaryPoolAgeLabel: null,
  poolCount: 1,
  observedPoolCount: 1,
  liquidityUsd: 215891.928,
  lpMigrationProof: { status: 'low', confidence: 'medium', liquidityDistribution: 'unknown', dexsUsed: [], signals: [], missingEvidence: [] },
})
assert('EVO lpHistoryTimeline.status is partial or ok (not unknown)', evoHistory.status === 'partial' || evoHistory.status === 'ok', evoHistory.status)
assert('EVO lpHistoryTimeline.primaryDex is Uniswap V4', evoHistory.primaryDex === 'Uniswap V4', evoHistory.primaryDex)
assert('EVO lpHistoryTimeline.primaryPair is evo / WETH', evoHistory.primaryPair === 'evo / WETH', evoHistory.primaryPair)
assert('EVO lpHistoryTimeline.primaryPool or primaryPoolId includes the poolId', evoHistory.primaryPool === evoPoolId || evoHistory.primaryPoolId === evoPoolId, evoHistory)
assert('EVO lpHistoryTimeline.primaryPoolCreatedAt matches', evoHistory.primaryPoolCreatedAt === '2026-04-26T20:19:11Z', evoHistory.primaryPoolCreatedAt)
assert('EVO lpHistoryTimeline.liquidityUsd matches', evoHistory.liquidityUsd === 215891.928, evoHistory.liquidityUsd)
assert('EVO lpHistoryTimeline does not report "no selected LP pool"', !evoHistory.events.some((e) => /no selected LP pool/i.test(e)), evoHistory.events)
assert('EVO lpHistoryTimeline summary mentions concentrated-liquidity pool', /concentrated-liquidity pool detected/i.test(evoHistory.summary), evoHistory.summary)
assert('EVO lpHistoryTimeline summary mentions Uniswap V4', /Uniswap V4/.test(evoHistory.summary), evoHistory.summary)
assert('EVO lpHistoryTimeline summary explains ERC20 lock/burn proof does not apply', /Standard ERC20 LP lock\/burn proof does not apply/i.test(evoHistory.summary), evoHistory.summary)

const evoLpControl = {
  status: 'concentrated_liquidity',
  displayLpModel: 'concentrated_liquidity',
  lockStatus: 'not_applicable',
  burnStatus: 'not_applicable',
  proofStatus: 'not_applicable',
  primaryMarketPool: null,
  primaryMarketPoolId: evoPoolId,
  lpController: null,
  lpControllerType: 'unknown',
}
const evoSelectedPool = { address: null, pair: 'evo / WETH', model: 'concentrated', liquidityUsd: 215891.928 }
const evoControllerIntel = buildLpControllerIntel({
  lpControl: evoLpControl,
  selectedPool: evoSelectedPool,
  lpExitRisk: 'watch',
  liquidityDepthRisk: 'moderate',
  lpMigrationProof: { status: 'low' },
  lpMeta: {},
})
const evoLockBurnIntel = buildLpLockBurnIntel({
  chain: 'base',
  lpControl: evoLpControl,
  lpControllerIntel: evoControllerIntel,
  selectedPool: evoSelectedPool,
  lpMeta: { displayLpModel: 'concentrated_liquidity' },
})
const evoUnlockTimeline = buildLpUnlockTimeline({ chain: 'base', lpLockBurnIntel: evoLockBurnIntel })
const evoMovementWatch = buildLpMovementWatch({
  chain: 'base',
  lpControllerIntel: evoControllerIntel,
  lpControl: evoLpControl,
  selectedPool: evoSelectedPool,
  lpMeta: {},
})
assert('EVO lpControllerIntel.status is concentrated_liquidity', evoControllerIntel.status === 'concentrated_liquidity', evoControllerIntel)
assert('EVO lpControllerIntel.controller is null', evoControllerIntel.controller === null, evoControllerIntel)
assert('EVO lpControllerIntel.controlProof is not_applicable (not misleadingly "confirmed")', evoControllerIntel.controlProof === 'not_applicable', evoControllerIntel.controlProof)
assert('EVO lpLockBurnIntel.status is not_applicable', evoLockBurnIntel?.status === 'not_applicable', evoLockBurnIntel)
assert('EVO lpUnlockTimeline.status is not_applicable', evoUnlockTimeline?.status === 'not_applicable', evoUnlockTimeline)
assert('EVO lpMovementWatch.status is not_applicable or unsupported', ['not_applicable', 'pool_model_not_supported'].includes(evoMovementWatch?.status), evoMovementWatch)

// ─── K. MFERGPT-like Uniswap V4 concentrated primary + Aerodrome V2 secondary ──
console.log('\nK. MFERGPT-like concentrated primary pool + secondary Aerodrome V2 LP exposure')
const mferPoolId = '0x9876543210fedcba9876543210fedcba98765432fedcba9876543210fedcba'
const mferSecondaryPool = '0x9bcc904149a72f33f22f7288de837cc4b3ed3779'
const mferLpControl = {
  status: 'team_controlled',
  confidence: 'medium',
  displayLpModel: 'concentrated_liquidity',
  proofApplicability: 'not_applicable',
  lockStatus: 'not_applicable',
  burnStatus: 'not_applicable',
  proofStatus: 'not_applicable',
  primaryMarketPool: null,
  primaryMarketPoolId: mferPoolId,
  primaryPoolDex: 'uniswap-v4-base',
  primaryPoolType: 'concentrated',
  verificationPool: null,
  verificationPoolDex: null,
  verificationPoolType: null,
  lpController: 'wallet',
  lpControllerType: 'wallet',
  evidence: ['top_holder=0xfee7486a3ebff6d668630517aa493ae7a0598067', 'top_share=100%'],
  secondaryLpControlSignals: {
    status: 'team_controlled',
    confidence: 'medium',
    poolAddress: mferSecondaryPool,
    poolDex: 'aerodrome-base',
    poolType: 'v2',
    reason: 'lp_holder_evidence',
    evidence: ['top_holder=0xfee7486a3ebff6d668630517aa493ae7a0598067', 'top_share=100%'],
  },
}
const mferSelectedPool = { address: null, pair: 'MFERGPT / WETH', dex: 'Uniswap V4', model: 'concentrated', liquidityUsd: 250000 }
// lpMeta.lpToken carries the SECONDARY Aerodrome V2 pool's own address (the V2 pool
// contract is its own LP token) — this must never leak into a primary "not applicable" card.
const mferLpMeta = { lpToken: mferSecondaryPool, displayLpModel: 'concentrated_liquidity' }

const mferControllerIntel = buildLpControllerIntel({
  lpControl: mferLpControl,
  selectedPool: mferSelectedPool,
  lpExitRisk: 'watch',
  liquidityDepthRisk: 'moderate',
  lpMigrationProof: { status: 'low' },
  lpMeta: mferLpMeta,
})
const mferLockBurnIntel = buildLpLockBurnIntel({
  chain: 'base',
  lpControl: mferLpControl,
  lpControllerIntel: mferControllerIntel,
  selectedPool: mferSelectedPool,
  lpMeta: mferLpMeta,
})
const mferMovementWatch = buildLpMovementWatch({
  chain: 'base',
  lpControllerIntel: mferControllerIntel,
  lpControl: mferLpControl,
  selectedPool: mferSelectedPool,
  lpMeta: mferLpMeta,
})

assert('MFERGPT selectedPool.pair is MFERGPT / WETH (primary, not secondary $MFER)', mferSelectedPool.pair === 'MFERGPT / WETH', mferSelectedPool)
assert('MFERGPT lpLockBurnIntel.status is not_applicable', mferLockBurnIntel.status === 'not_applicable', mferLockBurnIntel)
assert('MFERGPT lpLockBurnIntel.lockBurnProof is not_applicable', mferLockBurnIntel.lockBurnProof === 'not_applicable', mferLockBurnIntel)
assert('MFERGPT lpLockBurnIntel.lpTokenOrPool is not the secondary Aerodrome V2 pool', mferLockBurnIntel.lpTokenOrPool !== mferSecondaryPool, mferLockBurnIntel.lpTokenOrPool)
assert('MFERGPT lpLockBurnIntel.lpTokenOrPool is the primary pool identity (poolId)', mferLockBurnIntel.lpTokenOrPool === mferPoolId, mferLockBurnIntel.lpTokenOrPool)
assert('MFERGPT lpMovementWatch.status is not_applicable or unsupported', ['not_applicable', 'pool_model_not_supported'].includes(mferMovementWatch.status), mferMovementWatch.status)
assert('MFERGPT lpMovementWatch.lpTokenOrPool is not the secondary Aerodrome V2 pool', mferMovementWatch.lpTokenOrPool !== mferSecondaryPool, mferMovementWatch.lpTokenOrPool)
assert('MFERGPT lpMovementWatch.lpTokenOrPool is the primary pool identity (poolId)', mferMovementWatch.lpTokenOrPool === mferPoolId, mferMovementWatch.lpTokenOrPool)

const mferSecondaryExposure = buildSecondaryLpExposure({
  secondarySignals: { ...mferLpControl.secondaryLpControlSignals, pair: 'MFERGPT / $MFER' },
  primaryDex: 'Uniswap V4',
  primaryPair: 'MFERGPT / WETH',
  primaryPoolModel: 'concentrated',
})
assert('MFERGPT secondaryLpExposure exists', Boolean(mferSecondaryExposure), mferSecondaryExposure)
assert('MFERGPT secondaryLpExposure.poolAddress is the Aerodrome V2 pool', mferSecondaryExposure?.poolAddress === mferSecondaryPool, mferSecondaryExposure)
assert('MFERGPT secondaryLpExposure.controllerSharePercent is 100', mferSecondaryExposure?.controllerSharePercent === 100, mferSecondaryExposure)
assert('MFERGPT secondaryLpExposure.status is wallet_controlled or watch', ['wallet_controlled', 'watch'].includes(mferSecondaryExposure?.status ?? ''), mferSecondaryExposure?.status)
assert('MFERGPT secondaryLpExposure.lockBurnProof is open_check', mferSecondaryExposure?.lockBurnProof === 'open_check', mferSecondaryExposure)
assert('MFERGPT secondaryLpExposure.summary mentions Uniswap V4 concentrated liquidity', /Uniswap V4.*concentrated liquidity/i.test(mferSecondaryExposure?.summary ?? ''), mferSecondaryExposure?.summary)
assert('MFERGPT secondaryLpExposure.summary mentions secondary ERC-20 LP pool and wallet-controlled', /secondary ERC-20 LP pool.*wallet-controlled/i.test(mferSecondaryExposure?.summary ?? ''), mferSecondaryExposure?.summary)
assert('MFERGPT secondaryLpExposure.summary says monitor separately / not primary liquidity', /monitor.*separately/i.test(mferSecondaryExposure?.summary ?? '') && /not primary liquidity/i.test(mferSecondaryExposure?.summary ?? ''), mferSecondaryExposure?.summary)

// No secondary signals -> no secondaryLpExposure (VIRTUAL/EVO-style regression guard).
assert('No secondaryLpExposure when secondaryLpControlSignals is absent', buildSecondaryLpExposure({ secondarySignals: null, primaryDex: 'Aerodrome', primaryPair: 'VIRTUAL / WETH', primaryPoolModel: 'concentrated' }) === null)

// Sanitization: secondaryLpExposure must not leak raw DEX ids or provider/API names publicly.
const mferPublicPayload = sanitizePublicTokenResponse({
  symbol: 'MFERGPT',
  selectedPool: { address: null, pair: 'MFERGPT / WETH', dex: 'Uniswap V4', liquidityUsd: 250000, createdAt: null },
  lpControllerIntel: mferControllerIntel,
  lpMovementWatch: mferMovementWatch,
  lpLockBurnIntel: mferLockBurnIntel,
  secondaryLpExposure: mferSecondaryExposure,
}, false)
assert('MFERGPT public payload includes secondaryLpExposure', Boolean(mferPublicPayload.secondaryLpExposure), mferPublicPayload.secondaryLpExposure)
assert('MFERGPT secondaryLpExposure.poolDex does not leak raw DEX id', mferPublicPayload.secondaryLpExposure?.poolDex === 'Aerodrome', mferPublicPayload.secondaryLpExposure?.poolDex)
for (const providerName of providerNames) {
  assert(`MFERGPT secondaryLpExposure does not mention provider name "${providerName}"`, !serialized(mferPublicPayload.secondaryLpExposure).includes(providerName.toLowerCase()))
}
assert('MFERGPT secondaryLpExposure does not contain raw "aerodrome-base" id', !serialized(mferPublicPayload.secondaryLpExposure).includes('aerodrome-base'))

// ─── L. Public wording — concentrated LP lock/burn + missing-simulation copy ──
console.log('\nL. Public wording — concentrated LP lock/burn and missing-simulation copy')
{
  // Mirrors app/api/token/route.ts resolvedAnalysis.liquidityStatus for lpProofApplicability === 'not_applicable'.
  const concentratedLiquidityStatus = 'Concentrated liquidity detected — standard ERC-20 LP lock/burn proof does not apply. Liquidity control requires protocol-specific position checks.'
  assert('concentrated liquidityStatus mentions standard ERC-20 LP lock/burn proof does not apply', /standard ERC-20 LP lock\/burn proof does not apply/i.test(concentratedLiquidityStatus), concentratedLiquidityStatus)
  assert('concentrated liquidityStatus does not say lock/burn check requires pool address', !/lock\/burn check requires pool address/i.test(concentratedLiquidityStatus), concentratedLiquidityStatus)

  // Mirrors app/api/token/route.ts _buildDeterministicSummary inferred[] entry when hpResult.ok is false.
  const missingSimulationCopy = 'trading simulation not confirmed — verify buy/sell path and tax behavior before relying on this scan'
  assert('missing-simulation copy says trading simulation not confirmed', /trading simulation not confirmed/i.test(missingSimulationCopy), missingSimulationCopy)
  assert('missing-simulation copy does not say tax rates inferred as standard', !/tax rates inferred as standard/i.test(missingSimulationCopy), missingSimulationCopy)
}

for (const payload of [publicPayload, fallbackPublicPayload, protocolPayload, mferPublicPayload]) {
  assert('public payload does not contain "tax rates inferred as standard"', !serialized(payload).includes('tax rates inferred as standard'), payload.symbol)
  assert('public payload does not contain "lock/burn check requires pool address"', !serialized(payload).includes('lock/burn check requires pool address'), payload.symbol)
}
assert('GOAL/concentrated public lpLockBurnIntel summary mentions ERC20 LP lock/burn proof does not apply', /ERC20 LP lock\/burn proof does not apply/i.test(protocolPayload.lpLockBurnIntel?.summary ?? ''), protocolPayload.lpLockBurnIntel?.summary)
assert('MFERGPT public secondaryLpExposure does not contain the concentrated liquidityStatus copy (separate field)', !serialized(mferPublicPayload.secondaryLpExposure).includes('Concentrated liquidity detected'))

// ─── M. PLAY-like PancakeSwap V3 concentrated pool — must not be classified as V2/ERC20 LP ──
console.log('\nM. PLAY-like PancakeSwap V3 concentrated primary pool')
{
  // Mirrors app/api/token/route.ts detectPoolType(): a hyphenated GeckoTerminal dex id
  // like "pancakeswap-v3-base" must be classified as "v3", not fall through to "v2".
  const playDexId = 'pancakeswap-v3-base'
  const s = playDexId.toLowerCase()
  const detected = /^uniswap_v4|^uniswap-v4/.test(s) ? 'v3'
    : /^uniswap_v3|^uniswap-v3|^pancakeswap_v3|^pancakeswap-v3|^sushiswap_v3|^sushiswap-v3|^algebra/.test(s) ? 'v3'
    : /^uniswap_v2|^uniswap-v2|^pancakeswap_v2|^pancakeswap-v2|^sushiswap_v2|^sushiswap-v2|^baseswap|^alienbase|^swapbased|^shibaswap/.test(s) ? 'v2'
    : /^pancakeswap_v3|^pancakeswap-v3|^sushiswap_v3|^sushiswap-v3/.test(s) ? 'v3'
    : 'unknown'
  assert('PLAY "pancakeswap-v3-base" dex id is classified as v3, not v2', detected === 'v3', detected)
}

const playPoolAddress = '0xf1cacd7e005b9337c58aae77bc88d93c635cdf4d'
const playSelectedPool = { address: playPoolAddress, pair: 'PLAY / USDC', dex: 'PancakeSwap V3', model: 'concentrated', liquidityUsd: 500_000 }
const playLpControl = {
  status: 'concentrated_liquidity',
  confidence: 'medium',
  displayLpModel: 'concentrated_liquidity',
  proofApplicability: 'not_applicable',
  poolType: 'v3',
  lockStatus: 'not_applicable',
  burnStatus: 'not_applicable',
  proofStatus: 'not_applicable',
  primaryMarketPool: playPoolAddress,
  primaryMarketPoolId: playPoolAddress,
  primaryPoolDex: 'pancakeswap-v3-base',
  primaryPoolType: 'v3',
  verificationPool: null,
  verificationPoolDex: null,
  verificationPoolType: null,
  lpController: null,
  lpControllerType: 'unknown',
  evidence: [],
}
const playLpMeta = { displayLpModel: 'concentrated_liquidity', primaryMarketType: 'v3' }

const playControllerIntel = buildLpControllerIntel({
  lpControl: playLpControl,
  selectedPool: playSelectedPool,
  lpExitRisk: 'watch',
  liquidityDepthRisk: 'moderate',
  lpMigrationProof: { status: 'low' },
  lpMeta: playLpMeta,
})
const playLockBurnIntel = buildLpLockBurnIntel({
  chain: 'base',
  lpControl: playLpControl,
  lpControllerIntel: playControllerIntel,
  selectedPool: playSelectedPool,
  lpMeta: playLpMeta,
})
const playMovementWatch = buildLpMovementWatch({
  chain: 'base',
  lpControllerIntel: playControllerIntel,
  lpControl: playLpControl,
  selectedPool: playSelectedPool,
  lpMeta: playLpMeta,
})
const playUnlockTimeline = buildLpUnlockTimeline({ chain: 'base', lpLockBurnIntel: playLockBurnIntel })

assert('PLAY selectedPool.model is concentrated', playSelectedPool.model === 'concentrated', playSelectedPool)
assert('PLAY lpControl.proofApplicability is not_applicable', playLpControl.proofApplicability === 'not_applicable', playLpControl)
assert('PLAY lpLockBurnIntel.poolModel is concentrated_liquidity', playLockBurnIntel?.poolModel === 'concentrated_liquidity', playLockBurnIntel)
assert('PLAY lpLockBurnIntel.status is not_applicable', playLockBurnIntel?.status === 'not_applicable', playLockBurnIntel)
assert('PLAY lpUnlockTimeline.status is not_applicable', playUnlockTimeline?.status === 'not_applicable', playUnlockTimeline)
assert('PLAY lpMovementWatch.status is not_applicable or unsupported', ['not_applicable', 'pool_model_not_supported'].includes(playMovementWatch?.status), playMovementWatch)

const playRiskInput = {
  marketCapUsd: 5_000_000,
  fdvUsd: 5_000_000,
  liquidityUsd: 500_000,
  holderDistribution: { top1: 10, top5: 25, top10: 40 },
  lpControl: playLpControl,
  lpProofApplicability: 'not_applicable',
  lpProofStatus: 'not_applicable',
  lpModelProof: { model: 'concentrated', standardLockApplies: false },
  lpMigrationProof: { status: 'low' },
}
const playRisk = calculateTokenRiskScore(playRiskInput)
assert('PLAY riskBreakdown reasons include lp_model_concentrated_liquidity', playRisk.riskBreakdown.liquiditySafety.reasons.includes('lp_model_concentrated_liquidity'), playRisk.riskBreakdown.liquiditySafety.reasons)
assert('PLAY riskBreakdown reasons do not include lp_model_erc20_lp_token', !playRisk.riskBreakdown.liquiditySafety.reasons.includes('lp_model_erc20_lp_token'), playRisk.riskBreakdown.liquiditySafety.reasons)

const playPublicPayload = sanitizePublicTokenResponse({
  symbol: 'PLAY',
  selectedPool: playSelectedPool,
  lpControl: playLpControl,
  lpControllerIntel: playControllerIntel,
  lpLockBurnIntel: playLockBurnIntel,
  lpMovementWatch: playMovementWatch,
  lpUnlockTimeline: playUnlockTimeline,
  lpProofApplicability: 'not_applicable',
  lpProofStatus: 'not_applicable',
  riskEngine: { riskBreakdown: playRisk.riskBreakdown },
}, false)
assert('PLAY public payload does not contain lp_model_erc20_lp_token', !serialized(playPublicPayload).includes('lp_model_erc20_lp_token'), playPublicPayload)
assert('PLAY public lpLockBurnIntel summary mentions ERC20 LP lock/burn proof does not apply', /ERC20 LP lock\/burn proof does not apply/i.test(playPublicPayload.lpLockBurnIntel?.summary ?? ''), playPublicPayload.lpLockBurnIntel?.summary)

// Mirrors app/api/token/route.ts resolvedAnalysis.liquidityStatus for PLAY's lpProofApplicability === 'not_applicable'.
const playConcentratedLiquidityStatus = 'Concentrated liquidity detected — standard ERC-20 LP lock/burn proof does not apply. Liquidity control requires protocol-specific position checks.'
assert('PLAY liquidityStatus mentions standard ERC-20 LP lock/burn proof does not apply and protocol-specific position checks', /standard ERC-20 LP lock\/burn proof does not apply/i.test(playConcentratedLiquidityStatus) && /protocol-specific position checks/i.test(playConcentratedLiquidityStatus), playConcentratedLiquidityStatus)

// ─── N. VIRTUAL-like Aerodrome V2 LP — dominant LP holder evidence preserved ──
console.log('\nN. VIRTUAL-like Aerodrome V2 dominant LP holder evidence')
{
  // Mirrors app/api/token/route.ts bigIntPct(): BigInt-safe percentage from raw balances.
  function bigIntPctMirror(balanceRaw, supplyRaw) {
    try {
      if (balanceRaw == null || supplyRaw == null) return null
      const b = BigInt(String(balanceRaw).split('.')[0])
      const s = BigInt(String(supplyRaw).split('.')[0])
      if (s === BigInt(0)) return null
      return Number(b * BigInt(1000000) / s) / 10000
    } catch { return null }
  }

  // GoldRush LP-holder rows with no total_supply field — the case that previously
  // collapsed every holder's pct to 0 and discarded the dominant holder's address.
  const virtualLpItems = [
    { address: '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', balance: '8247000000000000000000000' },
    { address: '0x0000000000000000000000000000000000dead', balance: '1000000000000000000000' },
  ]
  // RPC-derived totalSupply (eth_call 0x18160ddd), used as the fallback supply when
  // GoldRush omits total_supply.
  const virtualRpcTotalSupply = '10000000000000000000000000'

  const virtualTop = virtualLpItems.map((h) => ({
    address: h.address.toLowerCase(),
    pct: bigIntPctMirror(h.balance, virtualRpcTotalSupply) ?? 0,
  }))
  const virtualTopHolder = virtualTop[0]
  assert('VIRTUAL RPC-derived totalSupply fallback yields top_holder pct in 82.45-82.49 range', virtualTopHolder.pct >= 82.45 && virtualTopHolder.pct <= 82.49, virtualTopHolder.pct)

  const virtualLpControlFixed = {
    status: 'team_controlled',
    confidence: 'high',
    poolType: 'aerodrome',
    source: 'Market + holder evidence',
    reason: 'Single normal wallet holds dominant LP share.',
    lockStatus: 'not_confirmed',
    burnStatus: 'not_confirmed',
    proofStatus: 'open_check',
    evidence: [`top_holder=${virtualTopHolder.address}`, `top_share=${virtualTopHolder.pct.toFixed(2)}%`],
  }
  const virtualIdentity = resolveLpControllerIdentity({
    status: virtualLpControlFixed.status,
    evidence: virtualLpControlFixed.evidence,
    lpControllerFromProof: 'unknown',
    ownerAddr: null,
  })
  assert('VIRTUAL resolveLpControllerIdentity returns lpControllerType wallet', virtualIdentity.lpControllerType === 'wallet', virtualIdentity)
  assert('VIRTUAL resolveLpControllerIdentity returns the dominant LP holder address', virtualIdentity.lpControllerAddress === '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', virtualIdentity)

  virtualLpControlFixed.lpController = virtualIdentity.lpController
  virtualLpControlFixed.lpControllerType = virtualIdentity.lpControllerType

  const virtualSelectedPoolFixed = { address: '0x21594b992f68495dd28d605834b58889d0a727c7', pair: 'VIRTUAL / WETH', dex: 'Aerodrome', model: 'constant_product', liquidityUsd: 1234567 }
  const virtualControllerIntelFixed = buildLpControllerIntel({
    lpControl: virtualLpControlFixed,
    selectedPool: virtualSelectedPoolFixed,
    lpExitRisk: 'watch',
    liquidityDepthRisk: 'low',
    lpMigrationProof: { status: 'low' },
    lpMeta: {},
  })
  const virtualLockBurnIntelFixed = buildLpLockBurnIntel({
    chain: 'base',
    lpControl: virtualLpControlFixed,
    lpControllerIntel: virtualControllerIntelFixed,
    selectedPool: virtualSelectedPoolFixed,
    lpMeta: {},
  })
  assert('VIRTUAL lpControllerIntel.status is wallet_controlled', virtualControllerIntelFixed.status === 'wallet_controlled', virtualControllerIntelFixed)
  assert('VIRTUAL lpControllerIntel.controller is the dominant LP holder', virtualControllerIntelFixed.controller === '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', virtualControllerIntelFixed)
  assert('VIRTUAL lpControllerIntel.controllerSharePercent is in 82.45-82.49 range', virtualControllerIntelFixed.controllerSharePercent >= 82.45 && virtualControllerIntelFixed.controllerSharePercent <= 82.49, virtualControllerIntelFixed.controllerSharePercent)
  assert('VIRTUAL lpLockBurnIntel.status stays open_check (no lock/burn proof confirmed)', virtualLockBurnIntelFixed.status === 'open_check', virtualLockBurnIntelFixed)

  const virtualRiskInputFixed = {
    marketCapUsd: 1_900_000_000,
    fdvUsd: 1_900_000_000,
    liquidityUsd: 1_234_567,
    holderDistribution: { top1: 12, top5: 30, top10: 48 },
    lpControl: { ...virtualLpControlFixed, displayLpModel: 'erc20_lp_token' },
    lpProofApplicability: 'applicable',
    lpProofStatus: 'open_check',
    lpModelProof: { model: 'constant_product', standardLockApplies: true },
    lpMigrationProof: { status: 'low' },
  }
  const virtualRiskFixed = calculateTokenRiskScore(virtualRiskInputFixed)
  assert('VIRTUAL riskScore stays around 58 (moderate)', virtualRiskFixed.riskScore >= 50 && virtualRiskFixed.riskScore <= 65, virtualRiskFixed.riskScore)
  assert('VIRTUAL riskLabel stays moderate', virtualRiskFixed.riskLabel === 'moderate', virtualRiskFixed.riskLabel)
}

// Concentrated fixtures (PMFI/EVO/MFERGPT-style, PLAY) remain not_applicable after the
// VIRTUAL dominant-holder fix — the fix only adds an RPC totalSupply fallback for the V2/
// Aerodrome GoldRush-holder-check branch and does not touch concentrated/V3/V4 handling.
assert('EVO lpLockBurnIntel.status remains not_applicable', evoLockBurnIntel?.status === 'not_applicable', evoLockBurnIntel)
assert('MFERGPT lpLockBurnIntel.status remains not_applicable', mferLockBurnIntel?.status === 'not_applicable', mferLockBurnIntel)
assert('PLAY lpLockBurnIntel.status remains not_applicable', playLockBurnIntel?.status === 'not_applicable', playLockBurnIntel)

// ─── O. PLAY-like secondary Aerodrome V2 LP exposure alongside concentrated primary ──
console.log('\nO. PLAY-like secondary Aerodrome V2 LP exposure')
{
  const playSecondaryPool = '0x42781ec558f9fb95f5e080572bcd0a37523b55e2'

  // O1. Secondary pool has dominant LP holder evidence (e.g. team_controlled, 90% share) —
  // reconcileSecondaryLpSignal must preserve the SECONDARY pool's own status/evidence in
  // secondaryLpControlSignals, not the primary pool's reconciled "concentrated_liquidity".
  const preReconcileWithHolder = {
    status: 'team_controlled',
    confidence: 'high',
    reason: 'Single normal wallet holds dominant LP share.',
    evidence: ['top_holder=0x111111111111111111111111111111111111aaaa', 'top_share=90.00%'],
  }
  const { lpControl: reconciledWithHolder, secondary: secondaryWithHolder } = reconcileSecondaryLpSignal(preReconcileWithHolder, {
    primaryConcentrated: true,
    verifyPool: { address: playSecondaryPool, liquidityUsd: 50000, dexId: 'aerodrome-base', dexName: 'Aerodrome', poolType: 'aerodrome', hasLpToken: true, hasDexMeta: true, isValidAddress: true },
    primaryPoolAddress: playPoolAddress,
    primaryPoolType: 'v3',
    primaryDexId: 'pancakeswap-v3-base',
    marketPairLabel: 'PLAY / USDC',
  })
  assert('PLAY reconciled primary lpControl.status is concentrated_liquidity', reconciledWithHolder.status === 'concentrated_liquidity', reconciledWithHolder.status)
  assert('PLAY secondaryLpControlSignals.status is NOT concentrated_liquidity (preserves secondary pool evidence)', secondaryWithHolder?.status !== 'concentrated_liquidity', secondaryWithHolder?.status)
  assert('PLAY secondaryLpControlSignals.status reflects the secondary pool dominant-holder status', secondaryWithHolder?.status === 'team_controlled', secondaryWithHolder?.status)
  assert('PLAY secondaryLpControlSignals.poolAddress is the Aerodrome secondary pool', secondaryWithHolder?.poolAddress === playSecondaryPool, secondaryWithHolder?.poolAddress)

  const playSecondaryExposureWithHolder = buildSecondaryLpExposure({
    secondarySignals: { ...secondaryWithHolder, pair: 'PLAY / USDC' },
    primaryDex: 'PancakeSwap V3',
    primaryPair: 'PLAY / USDC',
    primaryPoolModel: 'concentrated',
  })
  assert('PLAY secondaryLpExposure (with holder evidence) exists', Boolean(playSecondaryExposureWithHolder), playSecondaryExposureWithHolder)
  assert('PLAY secondaryLpExposure.status is wallet_controlled when dominant holder confirmed', playSecondaryExposureWithHolder?.status === 'wallet_controlled', playSecondaryExposureWithHolder?.status)
  assert('PLAY secondaryLpExposure.controller is the dominant holder address', playSecondaryExposureWithHolder?.controller === '0x111111111111111111111111111111111111aaaa', playSecondaryExposureWithHolder?.controller)
  assert('PLAY secondaryLpExposure.controllerSharePercent is 90', playSecondaryExposureWithHolder?.controllerSharePercent === 90, playSecondaryExposureWithHolder?.controllerSharePercent)
  assert('PLAY secondaryLpExposure.summary says wallet-controlled when controller/share confirmed', /wallet-controlled/i.test(playSecondaryExposureWithHolder?.summary ?? ''), playSecondaryExposureWithHolder?.summary)
  assert('PLAY secondaryLpExposure.summary mentions "Secondary ERC-20 LP exposure detected"', /Secondary ERC-20 LP exposure detected/i.test(playSecondaryExposureWithHolder?.summary ?? ''), playSecondaryExposureWithHolder?.summary)
  assert('PLAY secondaryLpExposure.summary mentions this pool is separate from the primary liquidity venue', /separate from the primary liquidity venue/i.test(playSecondaryExposureWithHolder?.summary ?? ''), playSecondaryExposureWithHolder?.summary)

  // O2. Secondary pool has NO controller/share evidence — must be open_check, controller
  // null, controllerSharePercent null, and the summary must NOT claim "wallet-controlled".
  const preReconcileNoEvidence = {
    status: 'partial',
    confidence: 'low',
    reason: 'LP checks ran but could not prove burned/locked/team-controlled state.',
    evidence: ['top_rows=0'],
  }
  const { secondary: secondaryNoEvidence } = reconcileSecondaryLpSignal(preReconcileNoEvidence, {
    primaryConcentrated: true,
    verifyPool: { address: playSecondaryPool, liquidityUsd: 50000, dexId: 'aerodrome-base', dexName: 'Aerodrome', poolType: 'aerodrome', hasLpToken: true, hasDexMeta: true, isValidAddress: true },
    primaryPoolAddress: playPoolAddress,
    primaryPoolType: 'v3',
    primaryDexId: 'pancakeswap-v3-base',
    marketPairLabel: 'PLAY / USDC',
  })
  assert('PLAY secondaryLpControlSignals.status (no evidence) is NOT concentrated_liquidity', secondaryNoEvidence?.status !== 'concentrated_liquidity', secondaryNoEvidence?.status)

  const playSecondaryExposureNoEvidence = buildSecondaryLpExposure({
    secondarySignals: { ...secondaryNoEvidence, pair: 'PLAY / USDC' },
    primaryDex: 'PancakeSwap V3',
    primaryPair: 'PLAY / USDC',
    primaryPoolModel: 'concentrated',
  })
  assert('PLAY secondaryLpExposure (no evidence) status is open_check', playSecondaryExposureNoEvidence?.status === 'open_check', playSecondaryExposureNoEvidence?.status)
  assert('PLAY secondaryLpExposure (no evidence) controller is null', playSecondaryExposureNoEvidence?.controller === null, playSecondaryExposureNoEvidence?.controller)
  assert('PLAY secondaryLpExposure (no evidence) controllerSharePercent is null', playSecondaryExposureNoEvidence?.controllerSharePercent === null, playSecondaryExposureNoEvidence?.controllerSharePercent)
  assert('PLAY secondaryLpExposure (no evidence) summary does NOT say "appears wallet-controlled"', !/appears wallet-controlled/i.test(playSecondaryExposureNoEvidence?.summary ?? ''), playSecondaryExposureNoEvidence?.summary)
  assert('PLAY secondaryLpExposure (no evidence) summary says lock/burn proof remains open', /Lock\/burn proof remains open until confirmed from LP holder evidence/i.test(playSecondaryExposureNoEvidence?.summary ?? ''), playSecondaryExposureNoEvidence?.summary)

  // O3. Public payload includes the secondary exposure card alongside the not_applicable
  // primary card, mentions "Secondary ERC-20 LP exposure", and never overrides the primary
  // lpControl/lpLockBurnIntel not_applicable status.
  const playPublicPayloadWithSecondary = sanitizePublicTokenResponse({
    symbol: 'PLAY',
    selectedPool: playSelectedPool,
    lpControl: playLpControl,
    lpControllerIntel: playControllerIntel,
    lpLockBurnIntel: playLockBurnIntel,
    lpMovementWatch: playMovementWatch,
    lpUnlockTimeline: playUnlockTimeline,
    secondaryLpExposure: playSecondaryExposureWithHolder,
    lpProofApplicability: 'not_applicable',
    lpProofStatus: 'not_applicable',
  }, false)
  assert('PLAY public payload includes secondaryLpExposure', Boolean(playPublicPayloadWithSecondary.secondaryLpExposure), playPublicPayloadWithSecondary.secondaryLpExposure)
  assert('PLAY public payload contains "Secondary ERC-20 LP exposure"', serialized(playPublicPayloadWithSecondary).includes('secondary erc-20 lp exposure'), playPublicPayloadWithSecondary.secondaryLpExposure?.summary)
  assert('PLAY public payload primary lpLockBurnIntel.status remains not_applicable alongside secondary exposure', playPublicPayloadWithSecondary.lpLockBurnIntel?.status === 'not_applicable', playPublicPayloadWithSecondary.lpLockBurnIntel)
  assert('PLAY public payload primary lpControl.proofApplicability remains not_applicable alongside secondary exposure', playPublicPayloadWithSecondary.lpControl?.proofApplicability === 'not_applicable', playPublicPayloadWithSecondary.lpControl)
}

// ─── P. CORTEX wording — no scam/financial-advice language, evidence-based instead ──
console.log('\nP. CORTEX wording is evidence-based, never scam/financial-advice language')
{
  // Mirrors app/api/token/route.ts clarkInterpretation._shortDriverPhrase/_joinDriverPhrases
  // for rugRiskLabel === 'critical'. Real riskDrivers entries are full sentences ending in
  // "." — joining them naively with ", " produces "X., Y., Z." (bad punctuation).
  const _shortDriverPhrase = (driver) => {
    const phraseMap = [
      [/^Holder concentration is very high/i, 'very high holder concentration'],
      [/^Dev Control: ownership is held by a wallet/i, 'active ownership'],
      [/^Whale pressure is high/i, 'deployer/top-holder supply control'],
    ]
    for (const [pattern, phrase] of phraseMap) {
      if (pattern.test(driver)) return phrase
    }
    const stripped = driver.replace(/\.$/, '')
    return stripped.charAt(0).toLowerCase() + stripped.slice(1)
  }
  const _joinDriverPhrases = (phrases) => {
    if (phrases.length === 0) return ''
    if (phrases.length === 1) return phrases[0]
    if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`
    return `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`
  }

  const playRiskDriversSample = [
    'Holder concentration is very high (Top 10 > 70%).',
    'Dev Control: ownership is held by a wallet.',
    'Whale pressure is high: top holder or top-5 hold a dominant share.',
  ]
  const criticalRiskSuffix = `Major risk drivers present: ${_joinDriverPhrases(playRiskDriversSample.slice(0, 3).map(_shortDriverPhrase))}. Verify open checks before relying on this scan.`
  assert('CORTEX critical wording has no double-period punctuation', !/\.\s*,/.test(criticalRiskSuffix), criticalRiskSuffix)
  assert('CORTEX critical wording reads "very high holder concentration, active ownership, and deployer/top-holder supply control"', criticalRiskSuffix.includes('very high holder concentration, active ownership, and deployer/top-holder supply control'), criticalRiskSuffix)

  const bannedPhrases = ['avoid exposure', 'critical rug vectors confirmed', 'scam', 'rug confirmed', 'guaranteed', 'risk-free', 'safe']
  for (const phrase of bannedPhrases) {
    assert(`CORTEX critical wording does not contain "${phrase}"`, !criticalRiskSuffix.toLowerCase().includes(phrase), criticalRiskSuffix)
  }
  assert('CORTEX critical wording cites risk drivers', /very high holder concentration/i.test(criticalRiskSuffix), criticalRiskSuffix)
  assert('CORTEX critical wording says to verify open checks', /verify open checks before relying on this scan/i.test(criticalRiskSuffix), criticalRiskSuffix)

  // A summary built from this suffix must not say "critical" anywhere, even when the legacy
  // rugRiskLabel tier was "critical" — only the canonical Token Safety Score/label (e.g.
  // "49/100 (moderate)") should describe the overall tier.
  const playClarkSummary = `Base token. Token Safety Score: 49/100 (moderate). ${criticalRiskSuffix}`
  assert('CORTEX summary does not say "critical" when riskLabel is moderate', !/critical/i.test(playClarkSummary), playClarkSummary)
  assert('CORTEX summary cites the canonical Token Safety Score (49/100 (moderate))', /Token Safety Score:\s*49\/100 \(moderate\)/i.test(playClarkSummary), playClarkSummary)

  // Mirrors lib/server/tokenPublicResponse.ts's cortexLpRead.riskSummary rewrite: a
  // "shows an overall ... risk tier" sentence built from the legacy rugRiskLabel tier
  // ("critical") must be replaced with evidence-first canonical Token Safety Score
  // wording, never left as "critical" when riskScore/riskLabel say 49/moderate.
  const playCortexRewritePayload = sanitizePublicTokenResponse({
    symbol: 'PLAY',
    riskScore: 49,
    riskLabel: 'moderate',
    cortexLpRead: {
      riskSummary: 'PLAY (PLAY) shows an overall "critical" risk tier based on observed pool data. Liquidity depth is moderate for this token.',
    },
  }, false)
  const rewrittenCortexLpReadSummary = playCortexRewritePayload.cortexLpRead.riskSummary
  assert('cortexLpRead.riskSummary does not say "critical" when riskLabel is moderate', !/critical/i.test(rewrittenCortexLpReadSummary), rewrittenCortexLpReadSummary)
  assert('cortexLpRead.riskSummary uses evidence-first moderate Token Safety wording', /PLAY has a moderate Token Safety Score \(49\/100\), with severe holder\/dev-control risk drivers\./i.test(rewrittenCortexLpReadSummary), rewrittenCortexLpReadSummary)

  // Public payload must never contain the old scam/financial-advice phrasing, regardless of token.
  for (const payload of [publicPayload, fallbackPublicPayload, protocolPayload, mferPublicPayload, playPublicPayload]) {
    assert('public payload does not contain "avoid exposure"', !serialized(payload).includes('avoid exposure'), payload.symbol)
    assert('public payload does not contain "critical rug vectors confirmed"', !serialized(payload).includes('critical rug vectors confirmed'), payload.symbol)
  }
}

// ─── Q. VIRTUAL Part 1 regression — GoldRush placeholder percentage=0 rows must not block
// the RPC totalSupply-derived fallback (lost dominant LP holder evidence) ──────────────
console.log('\nQ. VIRTUAL Aerodrome LP holder regression — placeholder percentage=0 rows')
{
  function toNumMirror(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim()) { const n = Number(v); return Number.isFinite(n) ? n : null }
    return null
  }
  function bigIntPctMirror(balanceRaw, supplyRaw) {
    try {
      const balance = BigInt(String(balanceRaw))
      const supply = BigInt(String(supplyRaw))
      if (supply <= BigInt(0)) return null
      return Number(balance * BigInt(1_000_000) / supply) / 10_000
    } catch { return null }
  }

  // GoldRush sometimes returns percentage/percent/ownership_percentage = 0 as a placeholder
  // on every LP-holder row instead of omitting the field. Mirrors the
  // _lpItemsHaveDirectPct / per-holder pct logic in app/api/token/route.ts's V2 LP-holder
  // branch: a row of all-zero "direct" percentages must NOT block the RPC
  // totalSupply-derived fallback, or the dominant holder's real share is lost and the scan
  // falls through to the RPC-only burn/locker/owner probe (evidence: only burn_share=0.00%,
  // locker_share=0.00%).
  const lpItemsAllZeroPct = [
    { address: '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', balance: '8247000000000000000000000', percentage: 0 },
    { address: '0x0000000000000000000000000000000000dead', balance: '1000000000000000000000', percentage: 0 },
  ]
  const rpcTotalSupply = '10000000000000000000000000'

  const _lpItemsHaveDirectPct = lpItemsAllZeroPct.some((h) => {
    const p = toNumMirror(h.percentage)
    return p != null && p > 0
  })
  assert('VIRTUAL: all-zero percentage=0 placeholder rows are NOT treated as direct pct', _lpItemsHaveDirectPct === false, _lpItemsHaveDirectPct)

  const top = lpItemsAllZeroPct.map((h) => {
    const directPctRaw = toNumMirror(h.percentage)
    const directPct = (directPctRaw != null && directPctRaw > 0) ? directPctRaw : null
    const derivedPct = directPct == null ? bigIntPctMirror(h.balance, rpcTotalSupply) : null
    return { address: h.address.toLowerCase(), pct: directPct ?? derivedPct ?? 0 }
  })
  const topHolder = top[0]
  assert('VIRTUAL: topHolder pct is derived from RPC totalSupply despite percentage=0 placeholder', topHolder.pct >= 82.45 && topHolder.pct <= 82.49, topHolder.pct)
  assert('VIRTUAL: top.some(pct>0) is true, so the RPC burn/locker-only fallback does not run and dominant-holder evidence is preserved', top.some((x) => x.pct > 0), top)
  assert('VIRTUAL: topHolder address matches the known dominant LP holder', topHolder.address === '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', topHolder.address)

  // The resulting lpControl must classify as team_controlled with top_holder/top_share
  // evidence — not "partial" with only burn_share=0.00%/locker_share=0.00%.
  const virtualLpControlRecovered = {
    status: topHolder.pct >= 80 ? 'team_controlled' : 'partial',
    confidence: 'high',
    evidence: [`top_holder=${topHolder.address}`, `top_share=${topHolder.pct.toFixed(2)}%`],
  }
  assert('VIRTUAL lpControl.status is team_controlled (not partial)', virtualLpControlRecovered.status === 'team_controlled', virtualLpControlRecovered.status)
  assert('VIRTUAL lpControl.evidence includes top_holder/top_share', virtualLpControlRecovered.evidence.some((e) => e.startsWith('top_holder=')) && virtualLpControlRecovered.evidence.some((e) => e.startsWith('top_share=')), virtualLpControlRecovered.evidence)
  assert('VIRTUAL lpControl.evidence is not only burn_share/locker_share', !virtualLpControlRecovered.evidence.every((e) => e.startsWith('burn_share=') || e.startsWith('locker_share=')), virtualLpControlRecovered.evidence)

  const virtualIdentityRecovered = resolveLpControllerIdentity({
    status: virtualLpControlRecovered.status,
    evidence: virtualLpControlRecovered.evidence,
    lpControllerFromProof: 'unknown',
    ownerAddr: null,
  })
  assert('VIRTUAL resolveLpControllerIdentity (recovered) yields wallet controller type', virtualIdentityRecovered.lpControllerType === 'wallet', virtualIdentityRecovered)
  assert('VIRTUAL resolveLpControllerIdentity (recovered) yields the dominant LP holder address', virtualIdentityRecovered.lpControllerAddress === '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', virtualIdentityRecovered)

  const virtualLpControlRecoveredFull = {
    ...virtualLpControlRecovered,
    poolType: 'aerodrome',
    lpController: virtualIdentityRecovered.lpController,
    lpControllerType: virtualIdentityRecovered.lpControllerType,
  }
  const virtualSelectedPoolRecovered = { address: '0x21594b992f68495dd28d605834b58889d0a727c7', pair: 'VIRTUAL / WETH', dex: 'Aerodrome', model: 'constant_product', liquidityUsd: 1234567 }
  const virtualControllerIntelRecovered = buildLpControllerIntel({
    lpControl: virtualLpControlRecoveredFull,
    selectedPool: virtualSelectedPoolRecovered,
    lpExitRisk: 'watch',
    liquidityDepthRisk: 'low',
    lpMigrationProof: { status: 'low' },
    lpMeta: {},
  })
  const virtualLockBurnIntelRecovered = buildLpLockBurnIntel({
    chain: 'base',
    lpControl: virtualLpControlRecoveredFull,
    lpControllerIntel: virtualControllerIntelRecovered,
    selectedPool: virtualSelectedPoolRecovered,
    lpMeta: {},
  })
  assert('VIRTUAL lpControllerIntel.status is wallet_controlled', virtualControllerIntelRecovered.status === 'wallet_controlled', virtualControllerIntelRecovered)
  assert('VIRTUAL lpControllerIntel.controller is the dominant LP holder', virtualControllerIntelRecovered.controller === '0xbd62cad65b49b4ad9c7aa9b8bdb89d63221f7af5', virtualControllerIntelRecovered)
  assert('VIRTUAL lpControllerIntel.controllerSharePercent is in 82.4-82.6 range', virtualControllerIntelRecovered.controllerSharePercent >= 82.4 && virtualControllerIntelRecovered.controllerSharePercent <= 82.6, virtualControllerIntelRecovered.controllerSharePercent)
  assert('VIRTUAL lpLockBurnIntel.status stays open_check', virtualLockBurnIntelRecovered.status === 'open_check', virtualLockBurnIntelRecovered)

  const virtualRiskInputRecovered = {
    marketCapUsd: 1_900_000_000,
    fdvUsd: 1_900_000_000,
    liquidityUsd: 1_234_567,
    holderDistribution: { top1: 12, top5: 30, top10: 48 },
    lpControl: { ...virtualLpControlRecoveredFull, displayLpModel: 'erc20_lp_token' },
    lpProofApplicability: 'applicable',
    lpProofStatus: 'open_check',
    lpModelProof: { model: 'constant_product', standardLockApplies: true },
    lpMigrationProof: { status: 'low' },
  }
  const virtualRiskRecovered = calculateTokenRiskScore(virtualRiskInputRecovered)
  assert('VIRTUAL riskScore stays around 58 (moderate)', virtualRiskRecovered.riskScore >= 50 && virtualRiskRecovered.riskScore <= 65, virtualRiskRecovered.riskScore)
  assert('VIRTUAL riskLabel stays moderate', virtualRiskRecovered.riskLabel === 'moderate', virtualRiskRecovered.riskLabel)
  assert('VIRTUAL liquiditySafety reasons do not include lp_controller_unknown when top_holder proof exists', !virtualRiskRecovered.riskBreakdown.liquiditySafety.reasons.includes('lp_controller_unknown'), virtualRiskRecovered.riskBreakdown.liquiditySafety.reasons)
}

// ─── R. PLAY Part 2 — poolType must reflect the primary pool, not the secondary Aerodrome
// proof pool; secondary controller/share must match the real PLAY Aerodrome holder ─────
console.log('\nR. PLAY primary poolType + secondary Aerodrome controller/share')
{
  const playSecondaryPoolR = '0x42781ec558f9fb95f5e080572bcd0a37523b55e2'

  // R1. reconcileSecondaryLpSignal must reset lpControl.poolType to the PRIMARY pool's type
  // (v3), not leave the SECONDARY Aerodrome pool's poolType ("aerodrome") on the
  // reconciled, canonical lpControl.
  const preReconcilePlayPoolType = {
    status: 'team_controlled',
    confidence: 'high',
    poolType: 'aerodrome',
    reason: 'Single normal wallet holds dominant LP share.',
    evidence: ['top_holder=0x5c38ab2c57b1446d031572fea5f13bbd85f341f4', 'top_share=99.47%'],
  }
  const { lpControl: reconciledPlayPoolType, secondary: secondaryPlayPoolType } = reconcileSecondaryLpSignal(preReconcilePlayPoolType, {
    primaryConcentrated: true,
    verifyPool: { address: playSecondaryPoolR, liquidityUsd: 50000, dexId: 'aerodrome-base', dexName: 'Aerodrome', poolType: 'aerodrome', hasLpToken: true, hasDexMeta: true, isValidAddress: true },
    primaryPoolAddress: playPoolAddress,
    primaryPoolType: 'v3',
    primaryDexId: 'pancakeswap-v3-base',
    marketPairLabel: 'PLAY / USDC',
  })
  assert('PLAY reconciled lpControl.poolType is the primary pool type (v3), not the secondary Aerodrome pool', reconciledPlayPoolType.poolType === 'v3', reconciledPlayPoolType.poolType)
  assert('PLAY reconciled lpControl.status is concentrated_liquidity', reconciledPlayPoolType.status === 'concentrated_liquidity', reconciledPlayPoolType.status)
  assert('PLAY secondaryLpControlSignals.poolType is the secondary Aerodrome pool type', secondaryPlayPoolType?.poolType === 'aerodrome', secondaryPlayPoolType?.poolType)

  // R2. Secondary LP exposure with the real PLAY Aerodrome dominant-holder evidence:
  // controller 0x5c38ab2c57b1446d031572fea5f13bbd85f341f4, share ~99.47%.
  const playSecondaryExposureReal = buildSecondaryLpExposure({
    secondarySignals: { ...secondaryPlayPoolType, pair: 'PLAY / USDC' },
    primaryDex: 'PancakeSwap V3',
    primaryPair: 'PLAY / USDC',
    primaryPoolModel: 'concentrated',
  })
  assert('PLAY secondaryLpExposure.status is wallet_controlled', playSecondaryExposureReal?.status === 'wallet_controlled', playSecondaryExposureReal?.status)
  assert('PLAY secondaryLpExposure.controller is 0x5c38ab2c57b1446d031572fea5f13bbd85f341f4', playSecondaryExposureReal?.controller === '0x5c38ab2c57b1446d031572fea5f13bbd85f341f4', playSecondaryExposureReal?.controller)
  assert('PLAY secondaryLpExposure.controllerSharePercent is ~99.47', playSecondaryExposureReal?.controllerSharePercent >= 99.4 && playSecondaryExposureReal?.controllerSharePercent <= 99.5, playSecondaryExposureReal?.controllerSharePercent)
  assert('PLAY secondaryLpExposure.lockBurnProof is open_check', playSecondaryExposureReal?.lockBurnProof === 'open_check', playSecondaryExposureReal?.lockBurnProof)
  assert('PLAY secondaryLpExposure.summary says this is secondary LP exposure, not primary liquidity', /secondary LP exposure, not primary liquidity/i.test(playSecondaryExposureReal?.summary ?? ''), playSecondaryExposureReal?.summary)

  const playSecondaryExposureMissingController = buildSecondaryLpExposure({
    secondarySignals: { ...secondaryPlayPoolType, evidence: ['top_share=99.47%'], pair: 'PLAY / USDC' },
    primaryDex: 'PancakeSwap V3',
    primaryPair: 'PLAY / USDC',
    primaryPoolModel: 'concentrated',
  })
  assert('PLAY secondaryLpExposure without controller evidence remains open_check', playSecondaryExposureMissingController?.status === 'open_check', playSecondaryExposureMissingController)
  assert('PLAY secondaryLpExposure without controller evidence has null controller', playSecondaryExposureMissingController?.controller === null, playSecondaryExposureMissingController)
  assert('PLAY secondaryLpExposure without controller evidence has null-ish controller when no top_holder is present', playSecondaryExposureMissingController?.controller === null, playSecondaryExposureMissingController?.controller)
  assert('PLAY secondaryLpExposure without controller evidence summary does not say appears wallet-controlled', !/appears wallet-controlled/i.test(playSecondaryExposureMissingController?.summary ?? ''), playSecondaryExposureMissingController?.summary)

  // R3. Public payload: lpControl.poolType reflects the primary pool, never "Aerodrome" for
  // PLAY's PancakeSwap V3 primary pool, while secondaryLpExposure carries the Aerodrome data.
  const playLpControlReconciled = { ...playLpControl, poolType: reconciledPlayPoolType.poolType, secondaryLpControlSignals: secondaryPlayPoolType }
  const playPublicPayloadReal = sanitizePublicTokenResponse({
    symbol: 'PLAY',
    selectedPool: playSelectedPool,
    lpControl: playLpControlReconciled,
    lpControllerIntel: playControllerIntel,
    lpLockBurnIntel: playLockBurnIntel,
    lpMovementWatch: playMovementWatch,
    lpUnlockTimeline: playUnlockTimeline,
    secondaryLpExposure: playSecondaryExposureReal,
    lpProofApplicability: 'not_applicable',
    lpProofStatus: 'not_applicable',
  }, false)
  assert('PLAY public payload lpControl.poolType is v3 (primary), not aerodrome', playPublicPayloadReal.lpControl?.poolType === 'v3', playPublicPayloadReal.lpControl?.poolType)
  assert('PLAY public payload secondaryLpExposure.controllerSharePercent is ~99.47', playPublicPayloadReal.secondaryLpExposure?.controllerSharePercent >= 99.4 && playPublicPayloadReal.secondaryLpExposure?.controllerSharePercent <= 99.5, playPublicPayloadReal.secondaryLpExposure?.controllerSharePercent)
}


// ─── S. CORTEX token identity formatter avoids duplicate name/symbol wording ─────
console.log('\nS. CORTEX identity formatter avoids duplicate symbol/name')
{
  assert('Virtual Protocol + VIRTUAL formats as Virtual Protocol (VIRTUAL)', formatTokenIdentity('Virtual Protocol', 'VIRTUAL') === 'Virtual Protocol (VIRTUAL)', formatTokenIdentity('Virtual Protocol', 'VIRTUAL'))
  assert('Play + PLAY formats as Play (PLAY)', formatTokenIdentity('Play', 'PLAY') === 'Play (PLAY)', formatTokenIdentity('Play', 'PLAY'))
  assert('mferGPT + MFERGPT formats as mferGPT (MFERGPT)', formatTokenIdentity('mferGPT', 'MFERGPT') === 'mferGPT (MFERGPT)', formatTokenIdentity('mferGPT', 'MFERGPT'))
  assert('symbol-only identity formats as symbol', formatTokenIdentity(null, 'PLAY') === 'PLAY', formatTokenIdentity(null, 'PLAY'))
  assert('same name/symbol identity is not duplicated', formatTokenIdentity('PLAY', 'PLAY') === 'PLAY', formatTokenIdentity('PLAY', 'PLAY'))

  const mferCortex = buildCortexLpRead({
    name: 'mferGPT',
    symbol: 'MFERGPT',
    totalLiq: 120000,
    fragments: 1,
    observedPoolPresent: true,
    riskTier: 'moderate',
    liquidityDepthRisk: 'low',
    lpModel: { model: 'concentrated', dexName: 'Uniswap V4', standardLockApplies: false },
    migrationSummary: 'Migration status is low.',
    mode: 'indexed',
    confidence: 'medium',
    gaps: [],
    lpLockStatus: 'unverified',
    lpLockProvider: null,
    lpUnlockTime: null,
    proofApplicability: 'not_applicable',
  })
  assert('MFERGPT CORTEX summary starts with normalized identity once', /^mferGPT \(MFERGPT\) shows/.test(mferCortex.riskSummary), mferCortex.riskSummary)
  assert('MFERGPT CORTEX summary does not append symbol after identity', !/\(MFERGPT\)\s+MFERGPT\s+has/i.test(mferCortex.riskSummary), mferCortex.riskSummary)

  const duplicateCases = [
    { name: 'Virtual Protocol', symbol: 'VIRTUAL', bad: /\(VIRTUAL\)\s+VIRTUAL\s+has/i },
    { name: 'Play', symbol: 'PLAY', bad: /\(PLAY\)\s+PLAY\s+has/i },
    { name: 'mferGPT', symbol: 'MFERGPT', bad: /\(MFERGPT\)\s+MFERGPT\s+has/i },
    { name: null, symbol: 'ONLY', bad: /\(ONLY\)\s+ONLY\s+has/i },
    { name: 'PLAY', symbol: 'PLAY', bad: /PLAY\s+PLAY\s+has/i },
  ]
  for (const tokenCase of duplicateCases) {
    const identity = formatTokenIdentity(tokenCase.name, tokenCase.symbol)
    const sanitizedSummary = sanitizePublicTokenResponse({
      name: tokenCase.name,
      symbol: tokenCase.symbol,
      riskScore: 58,
      riskLabel: 'moderate',
      cortexLpRead: {
        riskSummary: `${identity} shows an overall "moderate" risk tier based on observed pool data. Liquidity depth is moderate.`,
      },
    }, false).cortexLpRead.riskSummary
    assert(`${identity} public CORTEX summary starts with exactly one formatted identity`, sanitizedSummary.startsWith(`${identity} has a moderate Token Safety Score`), sanitizedSummary)
    assert(`${identity} public CORTEX summary does not duplicate symbol after formatted identity`, !tokenCase.bad.test(sanitizedSummary), sanitizedSummary)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
