import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const source = readFileSync('lib/clusterMap.ts', 'utf8')
const ts = source.replace(/import type \{ CanonicalStatus \} from '\.\/canonicalStatus'\n/, '')
const { default: tsModule } = await import('typescript')
const js = tsModule.transpileModule(ts, { compilerOptions: { module: tsModule.ModuleKind.ES2022, target: tsModule.ScriptTarget.ES2022 } }).outputText
const file = join(tmpdir(), `clusterMap-${Date.now()}.mjs`)
await import('node:fs').then(fs => fs.writeFileSync(file, js))
const { buildClusterMap } = await import(file)

const DEPLOYER = '0xAa00000000000000000000000000000000000001'
const LINKED = '0xbb00000000000000000000000000000000000002'
const HOLDER = '0xCc00000000000000000000000000000000000003'

const map = buildClusterMap({
  deployerAddress: DEPLOYER,
  deployerStatus: 'confirmed',
  linkedWallets: [{ address: LINKED, reason: 'linked wallet evidence without transfer edge', confidence: 'medium' }],
  matchedLinkedWallets: [{ address: LINKED.toUpperCase(), percent: 3.2, rank: 4, confidence: 'medium' }],
  holderDistribution: { topHolders: [
    { address: DEPLOYER.toLowerCase(), percent: 7.6, rank: 2 },
    { address: HOLDER, percent: 2.1, rank: 5 },
  ] },
  holderRowsAvailable: true,
})
const deployer = map.nodes.find(n => n.type === 'deployer')
assert.equal(deployer.supplyPercent, 7.6, 'deployer address present in holders gets supplyPercent')
assert.equal(deployer.holderRank, 2, 'deployer address present in holders gets rank')
assert.ok(deployer.evidence.includes('deployer_found_in_holders'), 'deployer holder evidence chip is present')
assert.notEqual(deployer.confidence, 'open_check', 'deployer holder evidence is not open_check')
const holder = map.nodes.find(n => n.address === HOLDER.toLowerCase())
assert.equal(holder.confidence, 'high', 'indexed holder with supply does not become open_check')
assert.match(holder.confidenceReason, /2\.1%/, 'indexed holder reason includes supply')
const linked = map.nodes.find(n => n.address === LINKED.toLowerCase())
assert.equal(linked.supplyPercent, 3.2, 'case-insensitive linked address supply matching works')
assert.notEqual(linked.confidence, 'open_check', 'missing transfer edges does not force open_check when supply/link evidence exists')
assert.ok(map.clusterMapDebug.deployerSupplyResolved, 'debug notes deployer supply resolved')

const missing = buildClusterMap({
  deployerAddress: DEPLOYER,
  deployerStatus: 'confirmed',
  holderDistribution: { topHolders: [{ address: HOLDER, percent: 1, rank: 9 }] },
  holderRowsAvailable: true,
})
const missingDeployer = missing.nodes.find(n => n.type === 'deployer')
assert.equal(missingDeployer.supplyPercent, null, 'deployer missing from holders has null supply')
assert.match(missingDeployer.confidenceReason, /holder supply not found|not found in indexed top holders/i, 'deployer missing from holders has clean unknown supply reason')
assert.equal(missingDeployer.confidence, 'low', 'deployer role-only evidence is low, not open_check')

const ui = readFileSync('app/terminal/token-scanner/ClusterMapPanel.tsx', 'utf8')
assert.match(ui, /Supply not found in indexed holders\./, 'Wallet Detail renders no blank/undefined supply text')
assert.match(ui, /Holder rank #/, 'Wallet Detail renders holder rank copy')
assert.match(ui, /CONFIDENCE REASON/, 'Wallet Detail renders confidence reason')
assert.match(ui, /nodeRoleLabel\(node\.type/, 'graph labels include role')
assert.match(ui, /supplyPercent\.toFixed\(1\)/, 'graph labels include supply when known')
assert.doesNotMatch(ui, />\s*undefined\s*</, 'UI does not render literal undefined text')
console.log('dev cluster map evidence tests passed')
