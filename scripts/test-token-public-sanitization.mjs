/**
 * Regression tests for /api/token public-vs-debug response shape.
 * Run: node --experimental-strip-types scripts/test-token-public-sanitization.mjs
 */
import { sanitizePublicTokenResponse } from '../lib/server/tokenPublicResponse.ts'

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
  selectedPool: { address: '0x1111111111111111111111111111111111111111', dex: 'geckoterminal' },
  riskScore: 58,
  riskLabel: 'moderate',
  riskBreakdown: { total: 58, liquiditySafety: { score: 7, max: 30, reasons: ['Wallet-controlled LP'] } },
  lpControl: {
    status: 'team_controlled',
    proofStatus: 'open_check',
    lockStatus: 'not_confirmed',
    burnStatus: 'not_confirmed',
    lpControllerType: 'wallet',
    reason: 'GoldRush holder evidence and Alchemy RPC confirmed LP controller wallet.',
  },
  lpControlRead: { title: 'LP controlled by wallet', meaning: 'Control Proof: Confirmed' },
  lpMigrationProof: { status: 'low', reason: 'GeckoTerminal pools show a selected primary pool.' },
  lpExitRisk: 'watch',
  liquidityDepthRisk: 'low',
  holderDistribution: { top10: 48, holderCount: 100000, topHolders: holders },
  devIntel: { holderDistribution: { topHolders: holders } },
  holderResolver: { holders, sourceTrail: ['goldrush:attempted'], fallbackUsed: 'goldrush_token_holders' },
  transferResolver: { transfers, sourceTrail: ['moralis:attempted'], fallbackUsed: 'moralis_token_transfers' },
  suspiciousFlows: { transfers, fallbackUsed: 'moralis_token_transfers' },
  securityDiagnostics: { honeypotProvider: 'honeypot.is' },
  projectSocials: { twitter: 'x', sourceTrail: ['coingecko:succeeded'] },
  sections: { contractChecks: { totalSupply: '0x1234', decimalsRpc: '0x12', source: 'alchemy' } },
  rugRisk: { score: 42, label: 'watch', raw: { provider: 'moralis', holders } },
  riskEngine: { cortexScoreDebug: { raw: true }, cortexScore: 67, note: 'dexscreener fallback' },
  cortexScore: 67,
  cortexVerdict: 'CAUTION',
  cortexScoreDebug: { raw: true },
  gtRaw: { provider: 'geckoterminal' },
  gtPools: [{ provider: 'geckoterminal' }],
  gmgn: { provider: 'gmgn' },
  _debug: { goldrushUsage: true },
}

console.log('\nA. VIRTUAL-like public response')
const publicPayload = sanitizePublicTokenResponse(JSON.parse(JSON.stringify(virtualLikePayload)), false)
assert('riskScore remains present', publicPayload.riskScore === 58, publicPayload.riskScore)
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

console.log('\nB. debug=true response')
const debugPayload = sanitizePublicTokenResponse(JSON.parse(JSON.stringify(virtualLikePayload)), true)
assert('debug keeps score debug', Boolean(debugPayload.cortexScoreDebug && debugPayload.riskEngine.cortexScoreDebug), debugPayload.cortexScoreDebug)
assert('debug keeps raw/provider evidence', Boolean(debugPayload.gtRaw && debugPayload.gtPools && debugPayload.gmgn), { gtRaw: debugPayload.gtRaw, gtPools: debugPayload.gtPools, gmgn: debugPayload.gmgn })
assert('debug keeps raw holder arrays', Array.isArray(debugPayload.holderResolver.holders) && debugPayload.holderResolver.holders.length === 25, debugPayload.holderResolver.holders?.length)
assert('debug keeps raw transfer arrays', Array.isArray(debugPayload.transferResolver.transfers) && debugPayload.transferResolver.transfers.length === 25, debugPayload.transferResolver.transfers?.length)
assert('debug keeps provider names for diagnostics', serialized(debugPayload).includes('goldrush') && serialized(debugPayload).includes('moralis'), debugPayload)

console.log('\nC. concentrated/protocol pool regression')
const protocolPayload = sanitizePublicTokenResponse({
  selectedPool: { address: '0x2222222222222222222222222222222222222222' },
  lpControl: { status: 'protocol_managed', displayLpModel: 'concentrated_liquidity', proofStatus: 'not_applicable', lockStatus: 'not_applicable', burnStatus: 'not_applicable' },
  lpProofApplicability: 'not_applicable',
  lpModelProof: { model: 'concentrated', standardLockApplies: false },
  riskScore: 70,
  riskBreakdown: { total: 70 },
}, false)
assert('protocol pool proofApplicability remains not_applicable', protocolPayload.lpProofApplicability === 'not_applicable', protocolPayload.lpProofApplicability)
assert('concentrated pool is not forced into ERC20 lock/burn proof', protocolPayload.lpControl?.proofStatus === 'not_applicable' && protocolPayload.lpControl?.lockStatus === 'not_applicable' && protocolPayload.lpControl?.burnStatus === 'not_applicable', protocolPayload.lpControl)
assert('selected pool address is not fake-truncated', protocolPayload.selectedPool.address === '0x2222222222222222222222222222222222222222', protocolPayload.selectedPool.address)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
