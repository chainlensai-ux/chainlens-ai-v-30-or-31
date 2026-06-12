/**
 * Regression tests for /api/token public-vs-debug response shape.
 * Run: node --experimental-strip-types scripts/test-token-public-sanitization.mjs
 */
import { sanitizePublicTokenResponse } from '../lib/server/tokenPublicResponse.ts'
import { publicLpDataMode, computeLpExitRisk, buildCortexLpRead } from '../lib/server/lpProof.ts'
import { buildLpControllerIntel } from '../lib/server/lpControllerIntel.ts'
import { buildLpMovementWatch } from '../lib/server/lpMovementWatch.ts'
import { buildLpLockBurnIntel, LP_LOCK_BURN_REGISTRY } from '../lib/server/lpLockBurnIntel.ts'
import { buildLpUnlockTimeline } from '../lib/server/lpUnlockTimeline.ts'

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
  selectedPool: { address: '0x21594b992f68495dd28d605834b58889d0a727c7', pair: 'VIRTUAL / WETH', dex: 'geckoterminal', liquidityUsd: 1234567 },
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
  lpMigrationProof: { status: 'low', reason: 'GeckoTerminal pools show a selected primary pool.' },
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
    dex: 'geckoterminal',
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
  lpMigrationProof: { status: 'low', reason: 'Fallback market data shows a usable pool.' },
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
for (const provider of providerNames) assert(`fallback response does not expose provider name ${provider}`, !serialized(fallbackPublicPayload).includes(provider), provider)
for (const rawId of rawDexIds) assert(`fallback response does not expose raw DEX id ${rawId}`, !serialized(fallbackPublicPayload).includes(rawId), rawId)
assert('fallback response has no legacy Rug-risk pressure wording', !/Rug-risk pressure/i.test(serialized(fallbackPublicPayload)), fallbackPublicPayload)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
