import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildClarkPipelineAudit } from '../lib/server/clarkPipelineAudit.ts'
import { TOKEN_SCANNER_RISK_SCORE_SOURCE } from '../lib/tokenScannerPipelineAudit.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routeSrc = fs.readFileSync(path.join(__dirname, '../app/api/clark/route.ts'), 'utf8')
const builderSrc = fs.readFileSync(path.join(__dirname, '../lib/server/clarkPipelineAudit.ts'), 'utf8')

const REQUIRED_FIELDS = [
  'prompt', 'parsedIntent', 'resolvedIntent', 'requiredContextType',
  'explicitTokenAddress', 'explicitWalletAddress', 'requestedTicker', 'requestedChain',
  'tickerSearchId', 'tickerCandidates', 'selectedTickerAddress', 'selectedTickerChain',
  'tokenRequestId', 'walletRequestId', 'activeTokenBefore', 'activeTokenAfter',
  'activeWalletBefore', 'activeWalletAfter',
  'scannerCalled', 'scannerType', 'scannerAddress', 'scannerChain', 'scannerEvidenceStatus',
  'canonicalRiskScore', 'riskScoreSource', 'momentumListId', 'selectedRank',
  'staleResponseIgnored', 'memorySourceUsed', 'cortexTokenAddress', 'cortexChainId',
  'finalResponseStatus', 'firstFailureStage', 'exactFailureReason',
  'walletReadPath', 'walletStubHit', 'walletSnapshotStatus',
]

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

function baseInput(overrides = {}) {
  return {
    prompt: `/token ${USDC} on base`,
    identity: { command: 'token', intent: 'token_scan', address: USDC, chain: 'base', routeSelected: 'token_scan' },
    body: { prompt: `/token ${USDC} on base`, chain: 'base', tokenAddress: USDC },
    result: { intent: 'token_scan', toolsUsed: ['token_scan'], riskScore: 42, riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE, address: USDC, chain: 'base' },
    requestId: 'req-1',
    activeTokenBefore: null,
    activeTokenAfter: USDC,
    activeWalletBefore: null,
    activeWalletAfter: null,
    tickerSearchId: null,
    tickerCandidates: null,
    momentumListId: null,
    selectedRank: null,
    entityAudit: null,
    clarkAudit: { intent: 'token_scan', scannerDataUsed: true, fallbackUsed: false, missingFields: [], unavailableReason: null },
    timedOut: false,
    staleResponseIgnored: false,
    ...overrides,
  }
}

{
  const audit = buildClarkPipelineAudit(baseInput())
  for (const field of REQUIRED_FIELDS) {
    assert.ok(field in audit, `clarkPipelineAudit missing ${field}`)
  }
  assert.equal(audit.parsedIntent, 'token_scan')
  assert.equal(audit.resolvedIntent, 'token_scan')
  assert.equal(audit.requiredContextType, 'token')
  assert.equal(audit.explicitTokenAddress, USDC)
  assert.equal(audit.explicitWalletAddress, null)
  assert.equal(audit.requestedChain, 'base')
  assert.equal(audit.scannerCalled, true)
  assert.equal(audit.scannerType, 'token')
  assert.equal(audit.canonicalRiskScore, 42)
  assert.equal(audit.riskScoreSource, TOKEN_SCANNER_RISK_SCORE_SOURCE)
  assert.equal(audit.finalResponseStatus, 'ok')
  assert.equal(audit.firstFailureStage, null)
  assert.equal(audit.tokenRequestId, 'req-1')
  assert.equal(audit.walletRequestId, null)
  assert.equal(audit.activeTokenAfter, USDC)
  assert.equal(audit.memorySourceUsed, 'explicit_prompt')
  assert.equal(audit.walletStubHit, false)
}

{
  const audit = buildClarkPipelineAudit(baseInput({
    prompt: `/wallet ${WALLET}`,
    identity: { command: 'wallet', intent: 'wallet_scan', address: WALLET, chain: null, routeSelected: 'wallet_scan' },
    body: { prompt: `/wallet ${WALLET}`, walletAddress: WALLET },
    result: {
      intent: 'wallet_scan',
      toolsUsed: ['wallet_scan_orchestrator'],
      clarkWalletReadAudit: { sourceRoute: 'buildClarkWalletReadResponse', scanDepth: 'preview', staleResultRejected: false, usedCanonicalWalletScanner: true },
    },
    clarkAudit: { intent: 'wallet_scan', scannerDataUsed: true, fallbackUsed: false, missingFields: [], unavailableReason: null },
    activeWalletAfter: WALLET,
  }))
  assert.equal(audit.requiredContextType, 'wallet')
  assert.equal(audit.explicitWalletAddress, WALLET)
  assert.equal(audit.explicitTokenAddress, null)
  assert.equal(audit.scannerType, 'wallet')
  assert.equal(audit.walletReadPath, 'buildClarkWalletReadResponse')
  assert.equal(audit.walletSnapshotStatus, 'preview')
  assert.equal(audit.walletRequestId, 'req-1')
  assert.equal(audit.canonicalRiskScore, null, 'wallet path must not invent a token risk score')
  assert.equal(audit.riskScoreSource, null)
}

{
  const audit = buildClarkPipelineAudit(baseInput({
    timedOut: true,
    result: { intent: 'token_scan', toolsUsed: ['token_scan'] },
    clarkAudit: { intent: 'token_scan', scannerDataUsed: true, fallbackUsed: true, missingFields: [], unavailableReason: 'timed out: token_scan' },
  }))
  assert.equal(audit.finalResponseStatus, 'timeout')
  assert.equal(audit.firstFailureStage, 'timeout')
  assert.match(String(audit.exactFailureReason), /timed out/)
}

{
  const audit = buildClarkPipelineAudit(baseInput({
    prompt: 'scan 1',
    identity: { command: null, intent: 'token_scan', address: null, chain: null, routeSelected: 'token_scan' },
    body: { prompt: 'scan 1' },
    result: { intent: 'token_scan', toolsUsed: [], tickerSelectionAudit: { status: 'stale_search' } },
    clarkAudit: { intent: 'token_scan', scannerDataUsed: false, fallbackUsed: true, missingFields: [], unavailableReason: null },
    selectedRank: 1,
    tickerSearchId: 'clkts_old',
  }))
  assert.equal(audit.selectedRank, 1)
  assert.equal(audit.firstFailureStage, 'ticker_resolution')
  assert.equal(audit.scannerCalled, false)
}

{
  const audit = buildClarkPipelineAudit(baseInput({
    result: { intent: 'token_scan', toolsUsed: ['token_scan'], walletStubHit: true },
    clarkAudit: { intent: 'token_scan', scannerDataUsed: true, fallbackUsed: true, missingFields: ['snapshot'], unavailableReason: 'stub' },
  }))
  assert.equal(audit.walletStubHit, true)
  assert.equal(audit.firstFailureStage, 'wallet_stub')
}

{
  const audit = buildClarkPipelineAudit(baseInput({
    result: { intent: 'token_scan', toolsUsed: ['token_scan'] },
    clarkAudit: { intent: 'token_scan', scannerDataUsed: true, fallbackUsed: false, missingFields: [], unavailableReason: 'token_scan: failed' },
  }))
  assert.equal(audit.scannerEvidenceStatus, 'unavailable')
  assert.equal(audit.finalResponseStatus, 'unavailable')
  assert.equal(audit.firstFailureStage, 'scanner_evidence')
  assert.equal(audit.exactFailureReason, 'token_scan: failed')
}

{
  const audit = buildClarkPipelineAudit(baseInput({
    tickerCandidates: [
      { tokenAddress: USDC, chainSlug: 'base' },
      { address: WALLET, chain: 'ethereum' },
      { name: 'no-address' },
    ],
    tickerSearchId: 'clkts_1',
    body: { tickerSelection: { tickerSearchId: 'clkts_1', optionIndex: 0, tokenAddress: USDC, chainId: 8453 } },
    momentumListId: 'list-9',
    staleResponseIgnored: true,
  }))
  assert.equal(audit.tickerSearchId, 'clkts_1')
  assert.equal(audit.selectedTickerAddress, USDC)
  assert.equal(audit.selectedTickerChain, 8453)
  assert.equal(audit.tickerCandidates.length, 2)
  assert.equal(audit.momentumListId, 'list-9')
  assert.equal(audit.staleResponseIgnored, true)
}

{
  const before = buildClarkPipelineAudit(baseInput({ activeTokenBefore: WALLET, activeTokenAfter: USDC }))
  assert.equal(before.activeTokenBefore, WALLET)
  assert.equal(before.activeTokenAfter, USDC)
}

assert.match(builderSrc, /PURE and READ-ONLY/)
assert.doesNotMatch(builderSrc, /calculateTokenRiskScore\(/)
assert.doesNotMatch(builderSrc, /runWalletScan/)
assert.match(routeSrc, /function attachClarkPipelineAudit/)
assert.match(routeSrc, /normData\.clarkPipelineAudit|attachClarkPipelineAudit\(normData/)
assert.match(routeSrc, /attachClarkPipelineAudit\(normalized\.data/)
assert.match(routeSrc, /attachClarkPipelineAudit\(catchData/)
assert.match(routeSrc, /buildClarkPipelineAudit/)

console.log('test-clark-pipeline-audit.mjs: all assertions passed')
