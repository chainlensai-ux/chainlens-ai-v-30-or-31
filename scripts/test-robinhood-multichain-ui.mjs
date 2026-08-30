// Tests for the Robinhood Wallet Scanner multi-chain UI integration task: Robinhood behaves like
// another supported chain inside the normal Wallet Scanner UX (auto-included on a normal scan,
// rendered with the same card/table/badge components as every other chain, never a raw debug dump
// unless ?debug=true) — without touching Robinhood's decoder/PnL gates or Base/ETH/BNB's own
// pipeline. Source-level (this file's own subject is a 'use client' React page, not something a
// plain Node script can render), consistent with this session's established pattern for this page.

import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const pageSrc = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')

function run() {
  // ── 1. Robinhood chain metadata matches the task's exact spec ───────────────────────────────
  {
    check('chainSlug is the literal "robinhood"', /ROBINHOOD_CHAIN_META\s*=\s*\{\s*chainSlug:\s*'robinhood'/.test(pageSrc))
    check('chainId is the real 4663', /ROBINHOOD_CHAIN_META[\s\S]{0,80}chainId:\s*4663/.test(pageSrc))
    check('label is "Robinhood Chain"', /ROBINHOOD_CHAIN_META[\s\S]{0,120}label:\s*'Robinhood Chain'/.test(pageSrc))
  }

  // ── 2. Robinhood appears in multi-chain scan results / chain=auto includes it ───────────────
  {
    // handleScan() is the ONE trigger a normal "Scan" click calls — confirm it also fires the
    // Robinhood scan automatically (not gated behind a separate, hidden button the user must find).
    const handleScanBody = pageSrc.match(/async function handleScan\([\s\S]*?\n  \}\n/)
    check('handleScan (the normal multi-chain scan entry point) exists', handleScanBody != null)
    check('handleScan automatically triggers the Robinhood scan (chain=auto includes Robinhood)', handleScanBody != null && handleScanBody[0].includes('void handleRobinhoodScan()'))
    // The old standalone top-level "Robinhood Chain" button (separate from the main Scan action) is
    // gone — Robinhood is no longer a bolt-on second scan the user has to discover and click.
    check('the old separate top-level "Robinhood Chain" scan button is removed', !/>\s*\{robinhoodLoading \? 'Scanning…' : 'Robinhood Chain'\}\s*</.test(pageSrc))
  }

  // ── 3. Explicit Robinhood scan still works ───────────────────────────────────────────────────
  {
    check('handleRobinhoodScan is still a real, standalone, callable function', /async function handleRobinhoodScan\(\)/.test(pageSrc))
    // Explicit re-scan is now reachable from inside the Robinhood card itself (RobinhoodChainSection's
    // onRescan prop), not a top-level button — still a real, user-triggerable call to the same function.
    check('RobinhoodChainSection wires an explicit onRescan callback to handleRobinhoodScan', /onRescan=\{\(\) => void handleRobinhoodScan\(\)\}/.test(pageSrc))
  }

  // ── 4. Robinhood holdings render in a standard table (Token/Balance/Price/Value/Pricing
  //    status/Source), never a raw stacked list ────────────────────────────────────────────────
  {
    const tableMatch = pageSrc.match(/<table[\s\S]{0,1400}?<\/thead>/)
    check('a real <table> exists for Robinhood holdings', tableMatch != null)
    const theadText = tableMatch ? tableMatch[0] : ''
    for (const col of ['Token', 'Balance', 'Price', 'Value', 'Pricing Status', 'Source']) {
      check(`holdings table has a "${col}" column header`, theadText.includes(`>${col}<`))
    }
    // The OLD raw-list rendering (space-between flex rows with inline balance/value text) is gone.
    check('the old raw flex-row holdings list is removed', !/justifyContent: 'space-between'[\s\S]{0,60}h\.symbol \?\? h\.address\.slice\(0, 8\)/.test(pageSrc))
  }

  // ── 5. Unpriced tokens show a pricing-status badge, not raw text ────────────────────────────
  {
    check('each holdings row renders a Priced/Unpriced StatusBadge, not raw "price unavailable" text', /<StatusBadge label=\{h\.priceUsd != null \? 'Priced' : 'Unpriced'\}/.test(pageSrc))
    check('the old raw "— price unavailable" text fragment is removed', !pageSrc.includes('— price unavailable'))
    // The required warning-card wording for unpriced tokens.
    check('the unpriced-tokens warning card uses the exact required headline pattern', /\{unpricedCount\} token\{unpricedCount === 1 \? '' : 's'\} could not be priced/.test(pageSrc))
    check('the unpriced-tokens warning card uses the exact required explanation sentence', pageSrc.includes('These tokens are included in holdings but excluded from portfolio value until pricing is available.'))
  }

  // ── 6. Activity and PnL are separate cards ───────────────────────────────────────────────────
  {
    const activityCardIndex = pageSrc.indexOf('ACTIVITY CARD, DISCLOSED')
    const pnlCardIndex = pageSrc.indexOf('PNL CARD, DISCLOSED')
    check('an Activity card and a PnL card both exist, in that order', activityCardIndex !== -1 && pnlCardIndex !== -1 && activityCardIndex < pnlCardIndex)
    const activityCardSrc = pageSrc.slice(activityCardIndex, pnlCardIndex)
    check('the Activity card never mentions Robinhood PnL wording inline', !/Verified Robinhood PnL|PnL: Not verified yet/.test(activityCardSrc))
  }

  // ── 7. verifiedSwapCount and skippedSwapLogs render ─────────────────────────────────────────
  {
    check('verifiedSwapCount renders in the Activity card', /Verified Robinhood swaps: <strong[^>]*>\{activity\.verifiedSwapCount\}/.test(pageSrc))
    check('skippedSwapLogs renders in the Activity card', /Skipped unsupported swap logs: <strong[^>]*>\{activity\.skippedSwapLogs\}/.test(pageSrc))
    check('verifiedSwapCount also renders in the Evidence card', pageSrc.includes('verifiedSwapCount: {activity.verifiedSwapCount}'))
    check('skippedSwapLogs also renders in the Evidence card', pageSrc.includes('skippedSwapLogs: {activity.skippedSwapLogs}'))
  }

  // ── 8. PnL stays disabled (UI-visible) without verified swaps — the UI reads pnl.status, never
  //    derives it from activity volume itself ─────────────────────────────────────────────────
  {
    check('the PnL card label is driven by pnl.status, not activity data', /pnlLabel = pnl\.status === 'verified' \? 'Verified Robinhood PnL' : 'PnL: Not verified yet'/.test(pageSrc))
    check('the not-verified reason sentence is the exact required wording', pageSrc.includes('Robinhood PnL requires verified swap logs and price evidence on both legs. Activity alone is not counted as PnL.'))
  }

  // ── 9. Base/ETH/BNB output unchanged — the V2 scan call, its result state, and its own
  //    rendering path (WalletScannerResultsV3) are untouched by this integration ────────────────
  {
    check('the Base/ETH scan call (scanWalletV2) still requests exactly base+eth, untouched', pageSrc.includes("scanWalletV2(address, ['base', 'eth'], mode"))
    check('WalletScannerResultsV3 (the Base/ETH results renderer) is still used, untouched by this task', pageSrc.includes('<WalletScannerResultsV3'))
    check('the Base/ETH result/loading/error state names are unchanged', pageSrc.includes('const [loading, setLoading] = useState(false)') && pageSrc.includes('const [error, setError] = useState<string | null>(null)'))
    // handleScan's own Base/ETH scanWalletV2 call and error/degraded handling are untouched — the
    // only addition inside handleScan is the one fire-and-forget Robinhood call already checked above.
    check('handleScan still calls scanWalletV2 for the Base/ETH engine', /await scanWalletV2\(address, \['base', 'eth'\], mode/.test(pageSrc))
  }

  // ── 10. Debug-only raw view — never the default page ─────────────────────────────────────────
  {
    check('a debugMode state exists, sourced from ?debug=true', pageSrc.includes("if (params.get('debug') === 'true') setDebugMode(true)"))
    check('the raw JSON view is gated behind debugMode', /\{debugMode && \([\s\S]{0,500}JSON\.stringify\(result/.test(pageSrc))
  }

  // ── 11. No wrong-chain contamination: RobinhoodChainSection only ever reads fields off the
  //    RobinhoodWalletScanResponse it was given — never touches the Base/ETH `result`/`report`
  //    state, and vice versa ────────────────────────────────────────────────────────────────────
  {
    const sectionMatch = pageSrc.match(/function RobinhoodChainSection\([\s\S]*?\n\}\n/)
    check('RobinhoodChainSection component exists', sectionMatch != null)
    const sectionSrc = sectionMatch ? sectionMatch[0] : ''
    check('RobinhoodChainSection never references the Base/ETH WalletV2Report state', !/\bresultEnvelope\b|\bcortexRead\b/.test(sectionSrc))
  }

  console.log(`test-robinhood-multichain-ui.mjs: all ${passed} assertions passed`)
}

run()
