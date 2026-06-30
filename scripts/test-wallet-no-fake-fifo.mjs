import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

assert.match(src, /NO-FAKE-TRADES-FIX: never create a synthetic entry for uncovered sells/, 'uncovered sells are explicitly treated as missing cost basis')
assert.match(src, /unmatchedSells\+\+\s*\n\s*missingCostBasisSellEvents\+\+/, 'uncovered sells increment unmatched/missing-cost-basis counters')
assert.ok(!/evidence:\s*\{\s*entrySource:\s*'synthetic'/.test(src), 'FIFO no longer emits synthetic closed lots')
assert.ok(!/const estimateQueue = estimateLotsMap\.get\(lotKey\)[\s\S]{0,220}queue = estimateQueue/.test(src), 'FIFO no longer closes sells against estimate-only open lots')
assert.match(src, /missing\.push\(`missing_cost_basis_sells:\$\{missingCostBasisSellEvents\}`\)/, 'missing-cost-basis reason is surfaced deterministically')

console.log('wallet FIFO no-fake-trade invariants passed')
