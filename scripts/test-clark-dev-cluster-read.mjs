import assert from 'node:assert/strict'
import fs from 'node:fs'

// DEV-CLUSTER-READ FIX, DISCLOSED.
//
// Requested live: "cant we use like the section from dev cluster for clark on token scan" — a
// follow-up to the always-same-deployer memory fix. THIS_DEV_RE's answer ("who deployed this")
// already called /api/dev-wallet — the same endpoint Token Scanner's own "Dev" tab uses, which
// returns deployerAddress, linkedWallets, clusterMap (linked/cluster/holder wallet counts, supply
// %, dominance, a risk label), devClusterSupply, previousProjects, suspiciousTransfers, AND a
// dedicated clarkVerdict object (label/confidence/summary/keySignals/risks/nextAction) — but threw
// the whole response away in favor of hardcoded boilerplate lines that never read a single field
// from it ("Likely origin wallet is shown only when returned by this CORTEX read.", etc.), so the
// answer looked identically empty and unhelpful for every token regardless of what was actually
// found.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// The old hardcoded, evidence-blind boilerplate must be gone.
assert.doesNotMatch(routeCode, /Likely origin wallet is shown only when returned by this CORTEX read/, 'the old hardcoded boilerplate origin line must be removed')
assert.doesNotMatch(routeCode, /No linked wallet signals returned unless explicitly shown/, 'the old hardcoded boilerplate linked-wallet line must be removed')
assert.doesNotMatch(routeCode, /Dev\/origin data is still a missing confidence layer unless origin is returned/, 'the old hardcoded boilerplate risk line must be removed')

// The new header and every real field it reads from /api/dev-wallet's response must be present.
assert.match(routeCode, /"DEPLOYER \/ DEV CLUSTER READ", ""/, 'the new answer must use the DEPLOYER / DEV CLUSTER READ header')
assert.match(routeCode, /const dw = devRes\.json as Record<string, unknown>;/, 'must read the real /api/dev-wallet response instead of discarding it')
assert.match(routeCode, /const cv = \(dw\.clarkVerdict/, 'must read the dedicated clarkVerdict object /api\/dev-wallet already computes')
assert.match(routeCode, /const cm = \(dw\.clusterMap/, 'must read the real clusterMap (same data Token Scanner\'s Dev tab renders)')
assert.match(routeCode, /const deployerAddress = typeof dw\.deployerAddress === "string"/, 'must read the real resolved deployerAddress')
assert.match(routeCode, /const linkedWallets = Array\.isArray\(dw\.linkedWallets\)/, 'must read the real linkedWallets array')
assert.match(routeCode, /const devClusterSupply = typeof dw\.devClusterSupply === "number"/, 'must read the real devClusterSupply percentage')
assert.match(routeCode, /const previousProjects = Array\.isArray\(dw\.previousProjects\)/, 'must read the real previousProjects array')
assert.match(routeCode, /const suspiciousTransfers = dw\.suspiciousTransfers === true;/, 'must read the real suspiciousTransfers flag')

// A resolved deployer here must feed the existing generic deployer-memory harvester (top-level
// deployerAddress field), not require a separate, new write path.
assert.match(routeCode, /\.\.\.\(deployerAddress \? \{ deployerAddress, devWallet: \{ confidence: deployerConfidence \?\? "medium" \} \} : \{\}\),/, 'a resolved deployer must be surfaced at the top level so the existing DEPLOYER MEMORY harvester remembers it')

console.log('test-clark-dev-cluster-read.mjs: all assertions passed')
