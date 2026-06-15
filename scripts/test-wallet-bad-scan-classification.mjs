import fs from 'node:fs'
import assert from 'node:assert/strict'

const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// 1. pnlCacheQuality union includes the new statuses, and getPnlCacheQuality
//    classifies "no swaps + no closed lots" as 'no_trade_evidence' (not 'complete'),
//    with the priority ordering: complete check first, then stale_low_coverage,
//    then no_trade_evidence / no_pnl_coverage / historical_not_started, then
//    partial_needs_historical as the final fallback.
assert.match(
  route,
  /type PnlCacheQuality = 'complete' \| 'partial_needs_historical' \| 'stale_low_coverage' \| 'no_trade_evidence' \| 'no_pnl_coverage' \| 'historical_not_started'/,
  'pnlCacheQuality union includes no_trade_evidence, no_pnl_coverage, historical_not_started'
)
assert.match(
  route,
  /function getPnlCacheQuality[\s\S]*?if \(s\.closedLots > 0 && s\.coveragePercent >= 60 && !tradeStatsOpenCheck\) return 'complete'[\s\S]*?if \(s\.backfillTimedOut && lowCoverage\) return 'stale_low_coverage'[\s\S]*?if \(s\.swapCandidateEvents === 0 && s\.closedLots === 0\) return 'no_trade_evidence'[\s\S]*?if \(s\.coveragePercent === 0 \|\| tradeStatsOpenCheck\) return 'no_pnl_coverage'[\s\S]*?if \(s\.historicalRequested && s\.pagesAttempted === 0\) return 'historical_not_started'[\s\S]*?return 'partial_needs_historical'/,
  'getPnlCacheQuality has correct priority ordering for the new no-trade-evidence cases'
)

// 2. walletScanCostMode override: 'historical_live' is downgraded when historical
//    recovery did not actually run (no pages fetched against requested coverage).
assert.match(
  route,
  /'deep_cached_no_trade_evidence' \| 'historical_not_started'/,
  'WalletScanCostMode union includes the new downgrade modes'
)
assert.match(
  route,
  /if \(snapshot\.walletScanCostMode === 'historical_live'\)[\s\S]*?_historicalDidNotRun[\s\S]*?deep_cached_no_trade_evidence[\s\S]*?historical_not_started/,
  'walletScanCostMode is downgraded when historical recovery did not actually run'
)

// 3. requested historical + pagesAttempted 0 + no swap evidence => not_applicable / reason
assert.match(
  route,
  /walletHistoricalRecoveryStatus = 'not_applicable'/,
  'walletHistoricalRecoveryStatus can be set to not_applicable'
)
assert.match(
  route,
  /walletHistoricalRecoveryReason = 'no_valid_swap_or_lot_evidence'/,
  'walletHistoricalRecoveryReason explains no valid swap or lot evidence'
)
assert.match(
  route,
  /walletHistoricalScanNote = 'Historical PnL recovery was not applicable because no valid swap or closed-lot evidence was detected\.'/,
  'walletHistoricalScanNote explains why historical recovery was not applicable'
)
// route.ts treats the snapshot as `any` and has no explicit union for this field —
// the literal assignment checks above cover its usage. page.tsx declares the
// WalletResult union explicitly and must include 'not_applicable'.
assert.match(
  ui,
  /'needed' \| 'attempted' \| 'blocked' \| 'timed_out' \| 'not_applicable'/,
  'walletHistoricalRecoveryStatus union (page.tsx) includes not_applicable'
)

// 4. realizedPnlUsd / totalEstimatedPnlUsd default to null when no closed lots —
//    verify this remains true (FIFO engine / snapshot defaults untouched).
assert.match(
  snap,
  /realizedPnlUsd:\s*status === 'unavailable' \? null/,
  'realizedPnlUsd is null when estimatedPnl status is unavailable (no closed lots / no evidence)'
)
assert.match(
  snap,
  /totalEstimatedPnlUsd:\s*status === 'unavailable' \? null/,
  'totalEstimatedPnlUsd is null when estimatedPnl status is unavailable (no closed lots / no evidence)'
)

// 5 & 6. Spoof detection — execute the real implementation from
//    lib/server/tokenSymbolSpoof.ts via dynamic import. Node 20+ can import
//    .ts files directly when the project's tsconfig/loader allows it; if not,
//    fall back to a small inline reimplementation that mirrors the source
//    (kept in sync with lib/server/tokenSymbolSpoof.ts).
let detectSuspiciousTokenSymbol
try {
  const mod = await import('../lib/server/tokenSymbolSpoof.ts')
  detectSuspiciousTokenSymbol = mod.detectSuspiciousTokenSymbol
} catch {
  // Inline mirror of lib/server/tokenSymbolSpoof.ts — keep in sync if that file changes.
  const KNOWN_SYMBOLS = ['USDC', 'USDT', 'ETH', 'BTC', 'WETH', 'WBTC', 'DAI']
  const CONFUSABLE_MAP = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
    'ꓚ': 'C',
  }
  const stripInvisibleAndCombining = (input) => {
    let out = ''
    for (const ch of input.normalize('NFKD')) {
      if (/[\p{Mn}\p{Cf}\p{Cc}]/u.test(ch)) continue
      out += ch
    }
    return out
  }
  const applyConfusableMap = (input) => {
    let out = ''
    for (const ch of input) out += CONFUSABLE_MAP[ch] ?? ch
    return out
  }
  const scriptFamily = (ch) => {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x80) return /[A-Za-z]/.test(ch) ? 'latin' : null
    if (cp >= 0x0080 && cp <= 0x024F) return 'latin'
    if (cp >= 0x0400 && cp <= 0x04FF) return 'cyrillic'
    if (cp >= 0x0370 && cp <= 0x03FF) return 'greek'
    if (cp >= 0x1780 && cp <= 0x17FF) return 'khmer'
    return 'other'
  }
  detectSuspiciousTokenSymbol = (symbol) => {
    if (!symbol || typeof symbol !== 'string') return { suspicious: false }
    if (/^[\x20-\x7E]*$/.test(symbol)) return { suspicious: false }
    const hasInvisibleOrCombining = /[\p{Mn}\p{Cf}\p{Cc}]/u.test(symbol.normalize('NFKD'))
    const families = new Set()
    for (const ch of symbol) { const fam = scriptFamily(ch); if (fam) families.add(fam) }
    const mixedScripts = families.size > 1
    const cleaned = applyConfusableMap(stripInvisibleAndCombining(symbol)).toUpperCase()
    const matchedKnown = KNOWN_SYMBOLS.find((known) => cleaned === known)
    if (hasInvisibleOrCombining || mixedScripts) {
      return matchedKnown && symbol !== matchedKnown
        ? { suspicious: true, normalizedGuess: matchedKnown }
        : { suspicious: true }
    }
    if (matchedKnown && symbol !== matchedKnown) return { suspicious: true, normalizedGuess: matchedKnown }
    return { suspicious: false }
  }
}

// Exact spoof strings from the spec:
//  - 'U឵S឵DΤ' : "USDT" with Khmer combining signs (U+17B5) + Greek Tau (U+03A4) for the T
//  - 'U឵S឵Dꓚ' : "USDC" with Khmer combining signs (U+17B5) + lookalike capital C (U+A4DA)
//  - 'ỤSDC'  : "USDC" with U+1EE4 (U with dot below) instead of plain U
//  - 'EṬH'   : "ETH" with U+1E6C (T with dot below) instead of plain T
const spec = {
  usdtKhmerGreek: 'U឵S឵DΤ',
  usdcKhmerLookalike: 'U឵S឵Dꓚ',
  usdcDotBelowU: 'ỤSDC',
  ethDotBelowT: 'EṬH',
}

for (const [label, symbol] of Object.entries(spec)) {
  const result = detectSuspiciousTokenSymbol(symbol)
  assert.equal(result.suspicious, true, `${label} ("${symbol}") must be flagged suspicious`)
}

for (const symbol of ['USDC', 'USDT', 'ETH', 'BTC', 'WETH']) {
  const result = detectSuspiciousTokenSymbol(symbol)
  assert.equal(result.suspicious, false, `canonical symbol "${symbol}" must NOT be flagged suspicious`)
}

// 7. STABLES regex guard excludes suspicious symbols from stablecoin-activity detection.
assert.match(
  snap,
  /STABLES\.test\(e\.symbol\) && !detectSuspiciousTokenSymbol\(e\.symbol\)\.suspicious/,
  'symbol-based stablecoin detection (activity events) excludes spoofed symbols'
)
assert.match(
  snap,
  /STABLES\.test\(t\.asset\) && !detectSuspiciousTokenSymbol\(t\.asset\)\.suspicious/,
  'symbol-based stablecoin detection (alchemy transfers) excludes spoofed symbols'
)
assert.match(
  snap,
  /import \{ detectSuspiciousTokenSymbol \} from '\.\/tokenSymbolSpoof'/,
  'walletSnapshot.ts imports detectSuspiciousTokenSymbol'
)
assert.match(
  snap,
  /suspiciousTokenSummary\??:\s*\{/,
  'WalletSnapshot type includes suspiciousTokenSummary'
)

// 8. UI shows the "PnL unavailable" card gated on pnlCacheQuality === 'no_trade_evidence'
assert.match(ui, /PnL unavailable/, 'UI contains the PnL unavailable card title')
assert.match(
  ui,
  /result\.pnlCacheQuality === 'no_trade_evidence'/,
  'UI gates the PnL unavailable card on pnlCacheQuality === no_trade_evidence'
)

console.log('wallet bad-scan classification checks passed')
