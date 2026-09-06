import assert from 'node:assert/strict'
import fs from 'node:fs'

// Clark/CORTEX audit Item 13: wallet_analyze_quality must never send an empty/stub
// walletScan to the LLM. If the canonical snapshot is missing, return the exact
// Wallet Scanner failure reason.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')

const qualityIdx = routeSrc.indexOf('if (tool.name === "wallet_analyze_quality")')
assert.ok(qualityIdx > 0, 'wallet_analyze_quality tool handler exists')
const qualityBlock = routeSrc.slice(qualityIdx, qualityIdx + 1800)
assert.match(qualityBlock, /if \(!snapshot \|\| !snapshot\.ok\)/, 'refuses to call the LLM without a real ok:true snapshot')
assert.match(qualityBlock, /WALLET QUALITY — UNAVAILABLE/, 'unavailable path returns the exact Wallet Scanner failure, not invented metrics')
assert.match(qualityBlock, /callAnthropic/, 'ok:true path may call the LLM with the real snapshot')
assert.ok(
  qualityBlock.indexOf('if (!snapshot || !snapshot.ok)') < qualityBlock.indexOf('callAnthropic'),
  'the ok:true guard must run before callAnthropic',
)
assert.doesNotMatch(qualityBlock, /walletScan:\s*\{\s*\}/, 'wallet_analyze_quality must not construct an empty walletScan stub')
assert.doesNotMatch(qualityBlock, /wallet route removed/, 'dead wallet-route-removed stub must not be sent to the LLM')

assert.doesNotMatch(routeSrc, /walletScan:\s*\{\s*\}/, 'no empty walletScan stub is passed into ClarkContext for the LLM')

console.log('test-clark-wallet-analyze-quality-guard.mjs: all assertions passed')
