import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  normalizeFollowupChain,
  followupChainUnsupportedMessage,
} from '../lib/server/clarkRouting.ts'

// Clark/CORTEX audit Item 14: Clark's local SupportedChain must not claim polygon
// token-scan support that does not exist, and follow-up scans must never fall
// through to Base for robinhood/polygon/unknown.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /type SupportedChain = "base" \| "ethereum" \| "bnb";/, 'Clark local SupportedChain excludes polygon')
assert.doesNotMatch(routeCode, /type SupportedChain = "base" \| "ethereum" \| "polygon" \| "bnb";/, 'polygon must not remain in the GoldRush/GoPlus union')
assert.doesNotMatch(routeCode, /polygon: "matic-mainnet"/, 'GOLDRUSH_CHAIN must not claim polygon')
assert.doesNotMatch(routeCode, /polygon: "137"/, 'GOPLUS_CHAIN_ID must not claim polygon')
assert.match(routeSrc, /forcedTokenScan\?\.chain/, 'forcedTokenScan.chain must be applied onto chainForClarkTools')
assert.match(routeCode, /if \(!followupChain\)/, 'scan_rank follow-ups must refuse an unscannable chain instead of defaulting to Base')
assert.match(routeCode, /if \(!rescanChain\)/, 'rescan_current_token must refuse an unscannable chain instead of defaulting to Base')
assert.match(routeSrc, /followupChainUnsupportedMessage\(memItem\.chain\)/, 'rank-memory follow-up must refuse an unscannable chain instead of defaulting to Base')
assert.match(routeCode, /forcedScanChain/, 'recursive scan_rank must prefer forcedTokenScan.chain so robinhood list items stay on robinhood')

assert.equal(normalizeFollowupChain('base'), 'base')
assert.equal(normalizeFollowupChain('ethereum'), 'ethereum')
assert.equal(normalizeFollowupChain('eth'), 'ethereum')
assert.equal(normalizeFollowupChain('bnb'), 'bnb')
assert.equal(normalizeFollowupChain('bsc'), 'bnb')
assert.equal(normalizeFollowupChain('robinhood'), 'robinhood', 'robinhood list items must not become Base')
assert.equal(normalizeFollowupChain('polygon'), null, 'polygon must not fall through to Base')
assert.equal(normalizeFollowupChain('matic'), null)
assert.equal(normalizeFollowupChain('solana'), null)
assert.equal(normalizeFollowupChain('arbitrum'), null)
assert.equal(normalizeFollowupChain(null), null, 'missing chain must not be guessed as Base')
assert.equal(normalizeFollowupChain(''), null)
assert.equal(normalizeFollowupChain('unknown-chain'), null)

assert.match(followupChainUnsupportedMessage('polygon'), /Polygon/)
assert.match(followupChainUnsupportedMessage('solana'), /Solana/)
assert.doesNotMatch(followupChainUnsupportedMessage('polygon'), /Base scan|scanned as Base/i)
assert.match(followupChainUnsupportedMessage('polygon'), /Base, Ethereum, BNB, or Robinhood Chain/)

console.log('test-clark-supported-chain-consistency.mjs: all assertions passed')
