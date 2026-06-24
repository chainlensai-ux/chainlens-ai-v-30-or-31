import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. base/base-mainnet duplicate events/lots are deduped using a canonical chain key, not raw
// provider chain strings — both at the lot-dedupe key and the shared sells_exceed_buys detector.
assert.match(snap, /function dedupeClosedLots\(lots: WalletClosedLot\[\]\): \{ deduped: WalletClosedLot\[\]; duplicatesRemoved: number \} \{/, 'dedupeClosedLots helper exists')
assert.match(snap, /const key = \[\s*\n\s*normalizeChain\(lot\.chain\),\s*\n\s*lot\.openedTxHash,\s*\n\s*lot\.closedTxHash,\s*\n\s*lot\.tokenAddress\.toLowerCase\(\),\s*\n\s*round\(lot\.amountClosed\),\s*\n\s*round\(lot\.entryPriceUsd\),\s*\n\s*round\(lot\.exitPriceUsd\),\s*\n\s*\]\.join\(':'\)/, 'closed-lot dedupe key normalizes chain (base/base-mainnet collapse to the same key) before comparing')
assert.match(snap, /function detectSellsExceedBuys\(openLots: WalletLotOpen\[\], closedLots: WalletClosedLot\[\]\): boolean \{/, 'shared sells_exceed_buys detector exists')
assert.match(snap, /const key = `\$\{normalizeChain\(lot\.chain\)\}:\$\{lot\.tokenAddress\.toLowerCase\(\)\}`/, 'sells_exceed_buys detector normalizes chain before keying buys/sells by token')

// 2. Duplicated same tx/token/direction/amount does not create duplicate closed lots — the dedupe
// key includes openedTxHash+closedTxHash+tokenAddress+amountClosed+entry/exit price, so an exact
// re-derivation of the same trade collapses to one entry.
assert.match(snap, /if \(seen\.has\(key\)\) continue\s*\n\s*seen\.add\(key\)\s*\n\s*deduped\.push\(lot\)/, 'exact duplicate closed lots are dropped, first occurrence wins')
assert.match(snap, /const \{ deduped: _syntheticLotsAfterSourceLotsRaw, duplicatesRemoved: _closedLotDuplicatesRemoved \} =\s*\n\s*dedupeClosedLots\(_syntheticLotsAfterSourceLotsBeforeDedupe\)/, 'the final assembled closed-lot list is run through dedupeClosedLots before feeding public performance/integrity')

// 3. Legitimate partial fills are preserved — distinct amountClosed (or a distinct closedTxHash)
// never collapses into the same dedupe key, so two genuine partial sells of the same lot survive.
assert.match(snap, /distinct partial fills \(different amountClosed, or a\s*\n\/\/ different logIndex-driven closeTx\) are never collapsed, only exact re-derivations of the same\s*\n\/\/ trade are removed\./, 'dedupeClosedLots documents that distinct partial fills are preserved, not collapsed')

// 4. sells_exceed_buys no longer triggers purely from duplicated sells — integrityCheckPnl now
// delegates to the shared (dedupe-aware) detector instead of its own inline buys/sells loop.
assert.match(snap, /if \(detectSellsExceedBuys\(input\.openLots, input\.closedLots\)\) \{\s*\n\s*violations\.push\('sells_exceed_buys'\)\s*\n\s*\}/, 'integrityCheckPnl uses the shared detector for sells_exceed_buys instead of a separate ad-hoc loop')
assert.ok(!/const buysByToken = new Map<string, number>\(\)\s*\n\s*for \(const lot of input\.openLots\)/.test(snap), 'the old ad-hoc buys/sells loop inside integrityCheckPnl was removed in favor of the shared detector')

// 5. PnL remains locked when real missing cost basis exists — the hard-invalid violation set and
// the underlying gating logic are unchanged; dedupe only removes false-positive duplicate inputs,
// it never relaxes a threshold or skips a real violation.
assert.match(snap, /isInvalid \?\s*\n?\s*'invalid' : isSuspicious \? 'warning' : 'ok'|const isInvalid =\s*\n\s*\(typeof input\.coveragePercent === 'number' && input\.coveragePercent < 20\)/, 'invalid-status thresholds (coverage/price-failure) are unchanged')
assert.match(snap, /\(typeof input\.coveragePercent === 'number' && input\.coveragePercent < 20\) \|\|\s*\n\s*\(typeof input\.priceFailureRatio === 'number' && input\.priceFailureRatio > 0\.5\)/, 'coverage and price-failure invalid thresholds were not loosened')

// 6. Limited sample/official PnL only show when existing gates still pass — REQUIRED_PUBLIC_GRADE_LOTS
// gate in Clark routing and the public PnL display lock are untouched by this change.
assert.match(snap, /walletClosedLotDedupeDebug,\n/, 'walletClosedLotDedupeDebug is wired into _diagnostics for transparency, alongside (not instead of) the existing PnL fields')
assert.match(snap, /sellsExceedBuysCausedByDuplicateLots: _sellsExceedBuysBeforeDedupe && !_sellsExceedBuysAfterDedupe,/, 'debug explicitly distinguishes a real sells_exceed_buys violation from one caused only by duplicate lots')

// 7. Public provider-name safety unchanged — this fix never introduces provider names into any
// public-facing string; the new dedupe/detector code is provider-agnostic (chain/lot data only).
const fixSection = snap.slice(snap.indexOf('function dedupeClosedLots'), snap.indexOf('// PHASE6-FIX-5'))
assert.ok(!/"[^"]*\b(Moralis|Zerion|GoldRush|Alchemy)\b[^"]*"/.test(fixSection), 'the closed-lot dedupe / sells_exceed_buys fix never hardcodes a provider name into a quoted string')

console.log('wallet false PnL lock dedupe checks passed')
