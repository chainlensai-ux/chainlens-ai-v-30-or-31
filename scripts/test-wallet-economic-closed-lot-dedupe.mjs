import fs from 'node:fs'
import assert from 'node:assert/strict'

// Regression test for dedupeClosedLotsEconomic() (commit c2bcc8a) — the final post-FIFO,
// post-price-upgrade closed-lot dedupe that collapses the same economic trade when it survives
// as two near-identical-but-not-bit-identical closed lots (e.g. a live ClawBank duplicate seen on
// wallet 0x27e89a8b74c7c2bb4ee589816db43c701deb805c where amountClosed differed only at the 9th
// significant digit: 10653260.930471554 vs 10653260.930471553). No live provider access is
// available in this sandbox, so this test extracts the real function source from
// lib/server/walletSnapshot.ts verbatim and executes it directly against constructed
// WalletClosedLot-shaped objects — it proves the actual shipped logic, not a reimplementation.

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. Confirm the dedupe lives at the documented location and is wired in before any public-gate
// consumer (trade stats / public performance classification / closed-trade samples).
assert.match(snap, /function dedupeClosedLotsEconomic\(lots: WalletClosedLot\[\]\): \{/, 'dedupeClosedLotsEconomic exists')
assert.match(snap, /const _economicClosedLotDedupeResult = dedupeClosedLotsEconomic\(_syntheticLotsAfterSourceLots\)/, 'dedupeClosedLotsEconomic is called on the shared post-price-upgrade closed-lot array')
assert.match(snap, /_syntheticLotsAfterSourceLots = _economicClosedLotDedupeResult\.deduped/, 'the deduped array replaces _syntheticLotsAfterSourceLots before downstream consumers read it')
assert.match(snap, /walletEconomicClosedLotDedupeDebug,\n/, 'walletEconomicClosedLotDedupeDebug is wired into _diagnostics for transparency')

// 2. Gates untouched — computePriceIndependence and classifyClosedLotForPublicPerformance bodies
// are not referenced anywhere inside the new dedupe helpers, and both functions still exist intact.
assert.match(snap, /function computePriceIndependence\(/, 'computePriceIndependence still exists')
assert.match(snap, /function classifyClosedLotForPublicPerformance\(lot: WalletClosedLot, walletValueUsd: number\): \{/, 'classifyClosedLotForPublicPerformance still exists')
const dedupeSection = snap.slice(snap.indexOf('const CLOSED_LOT_AMOUNT_REL_TOL'), snap.indexOf('// Shared sells_exceed_buys detector'))
assert.ok(!/computePriceIndependence|classifyClosedLotForPublicPerformance/.test(dedupeSection), 'dedupeClosedLotsEconomic never calls either public-gate function')

// 3. Extract the real shipped source for normalizeChain + the economic dedupe helpers and execute
// it directly (after stripping TS-only type syntax) so the test runs the actual committed logic.
const normalizeChainSrc = snap.slice(snap.indexOf('function normalizeChain(chain: string): string {'), snap.indexOf('function normalizeChainForGoldrush'))
  .replace('function normalizeChain(chain: string): string {', 'function normalizeChain(chain) {')

let dedupeSrc = dedupeSection
  .replace('function _closedLotEvidenceRank(source: string | undefined | null): number {', 'function _closedLotEvidenceRank(source) {')
  .replace('function _closedLotEvidenceScore(lot: WalletClosedLot): number {', 'function _closedLotEvidenceScore(lot) {')
  .replace('function _closedLotNearlyEqual(a: number, b: number, relTol: number): boolean {', 'function _closedLotNearlyEqual(a, b, relTol) {')
  .replace(
    /function dedupeClosedLotsEconomic\(lots: WalletClosedLot\[\]\): \{[\s\S]*?\} \{/,
    'function dedupeClosedLotsEconomic(lots) {'
  )
  .replace('const groups = new Map<string, WalletClosedLot[]>()', 'const groups = new Map()')
  .replace('const deduped: WalletClosedLot[] = []', 'const deduped = []')
  .replace('const duplicatesRemovedByReason: Record<string, number> = {}', 'const duplicatesRemovedByReason = {}')
  .replace(/const sampleRemoved: Array<\{[^}]*\}> = \[\]/g, 'const sampleRemoved = []')
  .replace('const kept: WalletClosedLot[] = []', 'const kept = []')

const sandbox = {}
// eslint-disable-next-line no-new-func
new Function('sandbox', `
  ${normalizeChainSrc}
  ${dedupeSrc}
  sandbox.dedupeClosedLotsEconomic = dedupeClosedLotsEconomic
`)(sandbox)
const { dedupeClosedLotsEconomic } = sandbox
assert.equal(typeof dedupeClosedLotsEconomic, 'function', 'dedupeClosedLotsEconomic extracted and compiled from the real source')

// 4. Exact duplicate case — the live ClawBank shape: same chain/token/entry-exit tx/timestamps,
// same entry/exit price, amountClosed differing only by 9th-significant-digit float noise.
const clawBankBase = {
  tokenAddress: '0x16332535e2c27da578bc2e82beb09ce9d3c8eb07',
  tokenSymbol: 'CLAWBANK',
  chain: 'base',
  openedTxHash: '0xcc04d7b15cb36179f4ddb187bcf3796235b8c17965b7c3794542d064c62d9b37',
  closedTxHash: '0x8a99123007b95c6794827a67bed7362475aa33ffef2aa0ee8d3a451a0489f942',
  openedAt: '2026-06-19T04:53:45.000Z',
  closedAt: '2026-06-19T18:46:25.000Z',
  entryPriceUsd: 0.000015852890697245367,
  exitPriceUsd: 0.000025423265664959856,
  costBasisUsd: 168.95,
  proceedsUsd: 270.90,
  realizedPnlUsd: 101.95,
  realizedPnlPercent: 60.35,
  holdingTimeSeconds: 50800,
  confidence: 'high',
  evidence: { entrySource: 'provider_event_usd', exitSource: 'provider_event_usd', method: 'fifo' },
}
const lotA = { ...clawBankBase, amountClosed: 10653260.930471554, entryPriceSource: 'provider_event_usd', exitPriceSource: 'provider_event_usd' }
const lotB = { ...clawBankBase, amountClosed: 10653260.930471553, entryPriceSource: 'swap_reconstruction_v1', exitPriceSource: 'swap_reconstruction_v1' }

const exactDupeResult = dedupeClosedLotsEconomic([lotA, lotB])
assert.equal(exactDupeResult.duplicatesRemoved, 1, 'duplicateClosedLotsRemoved = 1 for the live ClawBank duplicate shape')
assert.equal(exactDupeResult.deduped.length, 1, 'output lots length decreases by 1 (2 -> 1)')
assert.equal(exactDupeResult.deduped[0].entryPriceSource, 'swap_reconstruction_v1', 'the lot with stronger evidence on both legs (swap_reconstruction_v1 > provider_event_usd) is kept deterministically')
assert.equal(exactDupeResult.sampleRemoved.length, 1, 'sampleDuplicateClosedLotsRemoved records the removed duplicate')
assert.equal(exactDupeResult.sampleRemoved[0].removedAmount, 10653260.930471554, 'the weaker-evidence lot is the one removed')
console.log('exact ClawBank duplicate case passed: duplicatesRemoved=1, lots 2 -> 1, kept evidence=swap_reconstruction_v1')

// 5. Tie-break determinism — when evidence is equal, the first deterministic FIFO lot (i.e. the
// first one encountered in input order) is kept, not the second.
const lotC = { ...clawBankBase, amountClosed: 10653260.930471554, entryPriceSource: 'provider_event_usd', exitPriceSource: 'provider_event_usd' }
const lotD = { ...clawBankBase, amountClosed: 10653260.930471553, entryPriceSource: 'provider_event_usd', exitPriceSource: 'provider_event_usd' }
const tieResult = dedupeClosedLotsEconomic([lotC, lotD])
assert.equal(tieResult.duplicatesRemoved, 1, 'equal-evidence duplicates still collapse to 1')
assert.equal(tieResult.deduped[0].amountClosed, lotC.amountClosed, 'on equal evidence, the first input lot is kept (deterministic FIFO order preserved)')
console.log('tie-break determinism case passed: first FIFO lot kept on equal evidence')

// 6. Negative case — a genuinely different partial fill (amount differs by >= 0.001%, i.e. far
// outside the 1e-9 relative tolerance) must NOT collapse.
const lotE = { ...clawBankBase, amountClosed: 10653260.930471554, entryPriceSource: 'provider_event_usd', exitPriceSource: 'provider_event_usd' }
const lotF = { ...clawBankBase, amountClosed: 10653260.930471554 * 1.00002, entryPriceSource: 'provider_event_usd', exitPriceSource: 'provider_event_usd' }
const partialFillResult = dedupeClosedLotsEconomic([lotE, lotF])
assert.equal(partialFillResult.duplicatesRemoved, 0, 'a real partial fill (amount differs by 0.002%) is not removed')
assert.equal(partialFillResult.deduped.length, 2, 'both genuinely distinct partial-fill lots are preserved')
console.log('partial-fill negative case passed: distinct amounts (0.002% apart) are preserved, not collapsed')

// 7. A different closedTxHash (a separate sell of the same lot) must never collapse either, even
// with an identical amount/price — distinct economic trades are never merged.
const lotG = { ...clawBankBase, amountClosed: 10653260.930471554, closedTxHash: '0x' + '1'.repeat(64), entryPriceSource: 'provider_event_usd', exitPriceSource: 'provider_event_usd' }
const lotH = { ...clawBankBase, amountClosed: 10653260.930471554, closedTxHash: '0x' + '2'.repeat(64), entryPriceSource: 'provider_event_usd', exitPriceSource: 'provider_event_usd' }
const distinctTradeResult = dedupeClosedLotsEconomic([lotG, lotH])
assert.equal(distinctTradeResult.duplicatesRemoved, 0, 'two distinct closedTxHash values are never merged')
assert.equal(distinctTradeResult.deduped.length, 2, 'distinct trades by closedTxHash are preserved')
console.log('distinct closedTxHash case passed: separate trades are never merged')

console.log('wallet economic closed-lot dedupe checks passed')
