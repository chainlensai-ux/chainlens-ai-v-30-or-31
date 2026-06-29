import fs from 'node:fs'
import assert from 'node:assert/strict'

const scoring = fs.readFileSync('lib/token/scoring.ts', 'utf8')
const clusterMap = fs.readFileSync('lib/clusterMap.ts', 'utf8')
const tokenRoute = fs.readFileSync('app/api/token/route.ts', 'utf8')
const devWalletRoute = fs.readFileSync('app/api/dev-wallet/route.ts', 'utf8')

// --- DevScore V2 (lib/token/scoring.ts) ---

// Evidence reused from devIntel/clusterMap/lpControl/rugRisk — not invented.
assert.match(scoring, /function getDevControlEvidence\(result: AnyRecord\)/, 'getDevControlEvidence helper exists')
for (const field of ['deployerConfirmed', 'linkedWallets', 'clusterDominancePercent', 'holderOverlapPercent', 'supplyControlPercent', 'lpOwnershipPercent', 'deployerRotationDetected', 'riskFlags', 'simulationStatus']) {
  assert.match(scoring, new RegExp(field), `getDevControlEvidence exposes ${field}`)
}

// Open check is now an ALL-missing gate, not an ANY-missing gate.
assert.doesNotMatch(scoring, /breakdown\.some\(\(item\) => item\.score == null\)/, 'old any-missing open_check gate removed')
assert.match(scoring, /const available = breakdown\.filter\(\(item\) => item\.score != null\)/, 'available-evidence filter present')
assert.match(scoring, /if \(available\.length === 0\) \{/, 'open_check only when ALL categories missing')

// Partial evidence produces a real reweighted score, not a fixed fallback band.
assert.match(scoring, /const availableWeight = available\.reduce\(\(sum, item\) => sum \+ item\.weight, 0\)/, 'reweights across available categories only')
assert.match(scoring, /available\.reduce\(\(sum, item\) => sum \+ \(item\.score! \* item\.weight\), 0\) \/ availableWeight/, 'score reflects partial evidence proportionally')

// --- Dev Map confidence (lib/clusterMap.ts) ---

for (const field of ['lpLockBurnConfirmed', 'adminFunctionsDetected', 'upgradeabilityDetected', 'simulationStatus']) {
  assert.match(clusterMap, new RegExp(`${field}\\?:`), `BuildClusterMapInput accepts ${field}`)
}
assert.match(clusterMap, /const hasCriticalEvidence = Boolean\(/, 'hasCriticalEvidence computed from full evidence set')
assert.match(clusterMap, /riskFromSupply\(clusterSupplyPercent, Boolean\(input\.suspiciousTransfers\), hasCriticalEvidence\)/, 'riskFromSupply receives hasCriticalEvidence')
assert.match(clusterMap, /if \(!otherCriticalEvidence\) return \{ score: null, label: 'open_check' \}/, 'open_check only when no other critical evidence present')

// --- Dev Control evidence ingestion wires through to buildClusterMap ---

assert.match(tokenRoute, /lpLockBurnConfirmed: lpProofStatus === 'verified'[\s\S]{0,300}adminFunctionsDetected:/, 'token route passes lpLockBurnConfirmed/adminFunctionsDetected into buildClusterMap')
assert.match(tokenRoute, /upgradeabilityDetected: cortexContractFlags\.proxy\.status === 'verified'/, 'token route passes upgradeabilityDetected into buildClusterMap')
assert.match(tokenRoute, /simulationStatus: hpResult\.ok \? 'ok' : 'open_check',\s*\n\s*\}\)/, 'token route passes simulationStatus into buildClusterMap')

assert.match(devWalletRoute, /lpLockBurnConfirmed: liqLpLocked,/, 'dev-wallet route passes lpLockBurnConfirmed into buildClusterMap')
assert.match(devWalletRoute, /simulationStatus: secHoneypot === false \? 'ok' : secHoneypot === true \? 'risk' : null,/, 'dev-wallet route passes simulationStatus into buildClusterMap')

console.log('devscore/clustermap evidence wiring checks passed')
