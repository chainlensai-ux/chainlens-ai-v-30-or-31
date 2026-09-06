import assert from 'node:assert/strict'
import fs from 'node:fs'
import { formatFastTokenRead } from '../lib/server/clarkRouting.ts'

// Clark/CORTEX audit Item 15: clark_fast must stay Not Checked for skipped
// security/LP/holders. Never imply 0% tax / sellable / verified.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(routeCode, /tokenApiMode === "clark_fast" && usableEvidence/, 'clark_fast with market data must still use formatFastTokenRead, not the full verdict engine')
assert.doesNotMatch(routeCode, /tokenApiMode === "clark_fast" && !ev\.ok && usableEvidence/, 'market-present clark_fast must not fall through to renderClarkTokenVerdictForEvm')
assert.match(routeCode, /wantsFastPreview \|\| honeypotChain == null/, 'clark_fast must not secretly run Clark\'s independent security simulation')
assert.match(routeCode, /wantsFastPreview \|\| \(typeof tSectSecurity\.status === "string"/, 'clark_fast maps skipped sim onto simulationStatus not_checked')

const ADDR = '0x' + '1'.repeat(40)
const skipped = formatFastTokenRead({
  ok: true,
  token: { name: 'FastCoin', symbol: 'FAST', address: ADDR },
  market: { price: 0.01, liquidity: 50_000, volume24h: 5_000, change24h: null, marketCap: null },
  holders: null,
  lpControl: { status: 'not_checked', reason: 'Not Checked: fast scan skipped LP proof', confidence: 'low' },
  security: { honeypot: false, buyTax: 0, sellTax: 0, ownerRenounced: null, mintable: null, proxy: null, simulationStatus: 'not_checked', missing: [] },
}, 'Base')

assert.match(skipped, /TOKEN READ — fast evidence/)
assert.match(skipped, /Security: Not Checked: fast scan skipped security simulation/)
assert.match(skipped, /LP: Not Checked: fast scan skipped LP proof/)
assert.match(skipped, /Holders: Not Checked: fast scan skipped holder scan/)
assert.match(skipped, /Verdict: Not Checked: fast scan skipped full token verification/)
assert.doesNotMatch(skipped, /no honeypot signal/i)
assert.doesNotMatch(skipped, /sellable/i)
assert.doesNotMatch(skipped, /0\.0%/)
assert.doesNotMatch(skipped, /Verified$|^- Verdict: Verified/m)
assert.doesNotMatch(skipped, /buy tax/)

const flagged = formatFastTokenRead({
  ok: false,
  token: { name: 'Trap', symbol: 'TRAP', address: ADDR },
  market: { price: 0.01, liquidity: 1_000, volume24h: 100, change24h: null, marketCap: null },
  holders: null,
  lpControl: { status: 'not_checked' },
  security: { honeypot: true, buyTax: 99, sellTax: 99, missing: [] },
}, 'Base')
assert.match(flagged, /HONEYPOT flagged/)
assert.match(flagged, /Avoid — honeypot detected/)
assert.match(flagged, /LP: Not Checked: fast scan skipped LP proof/)

console.log('test-clark-fast-preview-not-checked.mjs: all assertions passed')
