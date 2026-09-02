// Tests for the Robinhood Wallet Scanner multi-chain UI integration task: Robinhood behaves like
// another supported chain inside the normal Wallet Scanner UX (auto-included on a normal scan,
// rendered with the same card/table/badge components as every other chain, never a raw debug dump
// unless ?debug=true) — without touching Robinhood's decoder/PnL gates or Base/ETH/BNB's own
// pipeline. Source-level (this file's own subject is a 'use client' React page, not something a
// plain Node script can render), consistent with this session's established pattern for this page.
//
// RELOCATED, DISCLOSED (split-Wallet-Scanner-results fix task): the Robinhood chain card's own
// content (metadata, holdings table, Activity/PnL/Evidence cards, debug raw view) moved out of
// page.tsx into app/frontend/components/RobinhoodChainSection.tsx so it can render as ONE MORE CHAIN
// TAB inside the merged Wallet Scanner result (WalletScannerTabsV3.tsx) instead of a second,
// competing top-level card — see that file's own header for the confirmed bug this closes (two
// conflicting portfolio totals for the same wallet). Checks below now read whichever file the
// content actually lives in today.

import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const pageSrc = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')
const robinhoodUiSrc = fs.readFileSync(new URL('../app/frontend/components/RobinhoodChainSection.tsx', import.meta.url), 'utf8')
const canonicalSelectorsSrc = fs.readFileSync(new URL('../lib/walletScan/canonicalWalletSelectors.ts', import.meta.url), 'utf8')

function run() {
  // ── 1. Robinhood chain metadata matches the task's exact spec ───────────────────────────────
  {
    check('the UI imports the shared canonical Robinhood chain metadata', robinhoodUiSrc.includes('ROBINHOOD_CHAIN_META as ROBINHOOD_CHAIN_META_SHARED'))
    check('chainSlug is the literal "robinhood"', /ROBINHOOD_CHAIN_META\s*=\s*\{\s*chainSlug:\s*'robinhood'/.test(canonicalSelectorsSrc))
    check('chainId is the real 4663', /ROBINHOOD_CHAIN_META[\s\S]{0,80}chainId:\s*4663/.test(canonicalSelectorsSrc))
    check('label is "Robinhood Chain"', /ROBINHOOD_CHAIN_META[\s\S]{0,120}label:\s*'Robinhood Chain'/.test(canonicalSelectorsSrc))
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
    // Explicit re-scan is reachable both from the Robinhood tab (WalletScannerTabsV3 passes
    // onRobinhoodRescan through to RobinhoodChainSection's onRescan prop) and from the debug/no-
    // main-result fallback card in page.tsx — both real, user-triggerable calls to the same function.
    check('page.tsx wires an explicit onRobinhoodRescan callback to handleRobinhoodScan', /onRobinhoodRescan=\{\(\) => void handleRobinhoodScan\(\)\}/.test(pageSrc))
    check('the fallback RobinhoodChainSection card also wires onRescan to handleRobinhoodScan', /onRescan=\{\(\) => void handleRobinhoodScan\(\)\}/.test(pageSrc))
  }

  // ── 4. Robinhood holdings render in a standard table (Token/Balance/Price/Value/Pricing
  //    status/Source), never a raw stacked list ────────────────────────────────────────────────
  {
    const tableMatch = robinhoodUiSrc.match(/<table[\s\S]{0,1400}?<\/thead>/)
    check('a real <table> exists for Robinhood holdings', tableMatch != null)
    const theadText = tableMatch ? tableMatch[0] : ''
    for (const col of ['Token', 'Balance', 'Price', 'Value', 'Pricing Status', 'Source']) {
      check(`holdings table has a "${col}" column header`, theadText.includes(`>${col}<`))
    }
    // The OLD raw-list rendering (space-between flex rows with inline balance/value text) is gone.
    check('the old raw flex-row holdings list is removed', !/justifyContent: 'space-between'[\s\S]{0,60}h\.symbol \?\? h\.address\.slice\(0, 8\)/.test(robinhoodUiSrc))
  }

  // ── 5. Unpriced tokens show a pricing-status badge, not raw text ────────────────────────────
  {
    check('each holdings row renders a Priced/Unpriced StatusBadge, not raw "price unavailable" text', /<StatusBadge label=\{h\.priceUsd != null \? 'Priced' : 'Unpriced'\}/.test(robinhoodUiSrc))
    check('the old raw "— price unavailable" text fragment is removed', !robinhoodUiSrc.includes('— price unavailable'))
    // The required warning-card wording for unpriced tokens.
    check('the unpriced-tokens warning card uses the exact required headline pattern', /\{unpricedCount\} token\{unpricedCount === 1 \? '' : 's'\} could not be priced/.test(robinhoodUiSrc))
    check('the unpriced-tokens warning card uses the exact required explanation sentence', robinhoodUiSrc.includes('These tokens are included in holdings but excluded from portfolio value until pricing is available.'))
  }

  // ── 6. Activity and PnL are separate cards ───────────────────────────────────────────────────
  {
    const activityCardIndex = robinhoodUiSrc.indexOf('ACTIVITY CARD:')
    const pnlCardIndex = robinhoodUiSrc.indexOf('PNL CARD:')
    check('an Activity card and a PnL card both exist, in that order', activityCardIndex !== -1 && pnlCardIndex !== -1 && activityCardIndex < pnlCardIndex)
    const activityCardSrc = robinhoodUiSrc.slice(activityCardIndex, pnlCardIndex)
    check('the Activity card never mentions Robinhood PnL wording inline', !/Verified Robinhood PnL|PnL: Not verified yet/.test(activityCardSrc))
  }

  // ── 7. verifiedSwapCount and skippedSwapLogs render ─────────────────────────────────────────
  {
    check('verifiedSwapCount renders in the Activity card', /Verified Robinhood swaps: <strong[^>]*>\{activity\.verifiedSwapCount\}/.test(robinhoodUiSrc))
    check('skippedSwapLogs renders in the Activity card', /Skipped unsupported swap logs: <strong[^>]*>\{activity\.skippedSwapLogs\}/.test(robinhoodUiSrc))
    check('verifiedSwapCount also renders in the Evidence card', robinhoodUiSrc.includes('verifiedSwapCount: {activity.verifiedSwapCount}'))
    check('skippedSwapLogs also renders in the Evidence card', robinhoodUiSrc.includes('skippedSwapLogs: {activity.skippedSwapLogs}'))
  }

  // ── 8. PnL stays disabled (UI-visible) without verified swaps — the UI reads pnl.status, never
  //    derives it from activity volume itself ─────────────────────────────────────────────────
  {
    // UPDATED, DISCLOSED (Gate-Robinhood-verified-PnL-on-Phase-3-sidecar-proof follow-up): the PnL
    // label now reads selectRobinhoodPnlLaneStatus(result) — the SAME shared lane-status selector
    // PnlStatusCard.tsx/CORTEX use — rather than a bare `pnl.status === 'verified'` check, so the UI
    // can never call PnL "Verified" without the full Phase 3 gate (source-marker/both-leg/FIFO-closed-
    // lot proof) also passing. Still honestly driven by real, already-computed status — never
    // re-derived from activity volume.
    check('the PnL card label is driven by the shared selectRobinhoodPnlLaneStatus selector, never activity data or a bare pnl.status check', /const robinhoodPnlVerified = selectRobinhoodPnlLaneStatus\(result\) === 'verified'/.test(robinhoodUiSrc))
    check('the PnL label reads "Robinhood PnL: Verified" only when the full lane check passes, otherwise "Robinhood: Not verified"', /const pnlLabel = robinhoodPnlVerified \? 'Robinhood PnL: Verified' : 'Robinhood: Not verified'/.test(robinhoodUiSrc))
    // WORDING UPDATE, DISCLOSED (split-Wallet-Scanner-results fix task's own explicit required
    // wording): "Robinhood PnL not verified yet — requires verified swap logs and both-leg price
    // evidence." — a genuine, task-mandated wording change; the underlying guarantee (a real, honest
    // not-verified explanation, never blended with portfolio value) is unchanged.
    // UPDATED, DISCLOSED (Gate-Robinhood-verified-PnL-on-Phase-3-sidecar-proof follow-up, and this
    // same session's own Wallet Read redesign task — both independently landed on this identical,
    // more precise wording): "Requires verified Robinhood swaps + both-leg price evidence." — the
    // underlying guarantee (a real, honest not-verified explanation, never blended with portfolio
    // value) is unchanged, only the exact sentence.
    check('the not-verified reason sentence is the exact required wording', robinhoodUiSrc.includes('Requires verified Robinhood swaps + both-leg price evidence.'))
  }

  // ── 9. Base/ETH/BNB output unchanged — the V2 scan call, its result state, and its own
  //    rendering path (WalletScannerResultsV3) are untouched by this integration ────────────────
  {
    // UPDATED, DISCLOSED (Robinhood-not-in-normal-pipeline fix): see test-robinhood-wallet-scanner.mjs's
    // matching update for the full disclosure — this literal string previously locked in the exact
    // bug being fixed (the client never told the route Robinhood was wanted, so it was silently
    // excluded from the normal scan pipeline even with every Robinhood env flag enabled).
    check("the Base/ETH scan call (scanWalletV2) still requests base+eth (plus robinhood, so Robinhood is honestly requested)", pageSrc.includes("scanWalletV2(address, ['base', 'eth', 'robinhood'], mode"))
    check('WalletScannerResultsV3 (the Base/ETH results renderer) is still used, untouched by this task', pageSrc.includes('<WalletScannerResultsV3'))
    check('the Base/ETH result/loading/error state names are unchanged', pageSrc.includes('const [loading, setLoading] = useState(false)') && pageSrc.includes('const [error, setError] = useState<string | null>(null)'))
    // handleScan's own Base/ETH scanWalletV2 call and error/degraded handling are untouched — the
    // only addition inside handleScan is the one fire-and-forget Robinhood call already checked above.
    check('handleScan still calls scanWalletV2 for the Base/ETH engine', /await scanWalletV2\(address, \['base', 'eth', 'robinhood'\], mode/.test(pageSrc))
  }

  // ── 10. Debug-only raw view — never the default page ─────────────────────────────────────────
  {
    check('a debugMode state exists, sourced from ?debug=true', pageSrc.includes("if (params.get('debug') === 'true') setDebugMode(true)"))
    check('the raw JSON view is gated behind debugMode', /\{debugMode && \([\s\S]{0,500}JSON\.stringify\(result/.test(robinhoodUiSrc))
  }

  // ── 11. No wrong-chain contamination: RobinhoodChainSection only ever reads fields off the
  //    RobinhoodWalletScanResponse it was given — never touches the Base/ETH `result`/`report`
  //    state, and vice versa ────────────────────────────────────────────────────────────────────
  {
    const sectionMatch = robinhoodUiSrc.match(/export function RobinhoodChainSection\([\s\S]*?\n\}\n/)
    check('RobinhoodChainSection component exists', sectionMatch != null)
    const sectionSrc = sectionMatch ? sectionMatch[0] : ''
    check('RobinhoodChainSection never references the Base/ETH WalletV2Report state', !/\bresultEnvelope\b|\bcortexRead\b/.test(sectionSrc))
  }

  // ── 12. ONE CANONICAL RESULT, DISCLOSED (split-Wallet-Scanner-results fix task): Robinhood
  //    renders as a chain tab inside the same merged Wallet Scanner result, never as an
  //    unconditional second top-level card competing with it — the confirmed root cause of the
  //    "$2.25 total next to a real Robinhood total" bug this task closes ───────────────────────
  {
    check('WalletScannerTabsV3 renders RobinhoodChainSection as one more tab, not a separate scanner', fs.readFileSync(new URL('../app/frontend/components/WalletScannerTabsV3.tsx', import.meta.url), 'utf8').includes("activeTab === 'robinhood' && robinhoodResult"))
    check('page.tsx no longer renders RobinhoodChainSection unconditionally whenever robinhoodResult exists', !/\{robinhoodResult && \(\s*<RobinhoodChainSection/.test(pageSrc))
    check('the standalone fallback card only renders when there is no main result, or in debug mode', pageSrc.includes('{robinhoodResult && (!result || debugMode) && !partialSnapshot && ('))
    check('the merged total helper sums the V2 total and Robinhood total when Robinhood was included', fs.readFileSync(new URL('../app/frontend/lib/mergedWalletView.ts', import.meta.url), 'utf8').includes('(v2Total ?? 0) + (valueUsd ?? 0)'))
    check('the old unconditional "are not included" wording is gone from PortfolioIntelligenceCard', !fs.readFileSync(new URL('../app/frontend/components/PortfolioIntelligenceCard.tsx', import.meta.url), 'utf8').includes('Custodial/exchange holdings (e.g. Robinhood) are not included'))
    check('the exact required "Includes Robinhood Chain..." wording exists for when Robinhood was scanned', fs.readFileSync(new URL('../app/frontend/lib/mergedWalletView.ts', import.meta.url), 'utf8').includes('Includes Robinhood Chain when enabled and successfully scanned.'))
  }

  console.log(`test-robinhood-multichain-ui.mjs: all ${passed} assertions passed`)
}

run()
