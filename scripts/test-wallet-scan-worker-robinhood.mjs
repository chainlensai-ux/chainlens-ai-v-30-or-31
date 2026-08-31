// Tests for the Wallet Scanner chain selection fix, WORKER level: the real background job worker
// (workers/walletScanV2.ts's runWalletScanV2Worker, invoked via src/modules/walletScanWorker.ts's
// executeWalletScanJob when the async queue dequeues a job) now genuinely calls scanRobinhoodWallet()
// as part of processing a real deep-scan job — not just app/api/wallet-scan/route.ts's own
// non-blocking cache-warm call, which never becomes part of the job's own published result.
//
// Style, DISCLOSED: follows this session's established convention (scripts/test-wallet-chain-
// selection-audit.mjs, scripts/test-wallet-scan-orchestrator.mjs) — source-level regex/string checks
// against the real files, since workers/walletScanV2.ts is a huge file with heavy real dependencies
// not easily unit-tested end-to-end.

import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

function read(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

function run() {
  const workerSrc = read('workers/walletScanV2.ts')
  const holdingsSrc = read('lib/engine/modules/holdings/fetchHoldings.ts')
  const chainTypesSrc = read('src/modules/providerFetchWindow/types.ts')
  const queueSrc = read('src/modules/walletScanQueue.ts')
  const workerModuleSrc = read('src/modules/walletScanWorker.ts')
  const routeSrc = read('app/api/wallet-scan/route.ts')
  const pageSrc = read('app/terminal/wallet-scanner/page.tsx')

  // ── 1. workers/walletScanV2.ts genuinely calls scanRobinhoodWallet() concurrently ───────────────
  {
    check('imports scanRobinhoodWallet', /import \{ scanRobinhoodWallet \} from '@\/lib\/server\/robinhoodWalletScanner'/.test(workerSrc))
    // UPDATED, DISCLOSED (Robinhood-worker-module-propagation fix): this import gained a second,
    // named export (ROBINHOOD_CHAIN_ID, needed to key Robinhood into portfolioTotalByChain by its
    // real numeric chain id) — isRobinhoodChainAvailable's own presence/behavior is unchanged.
    check('imports isRobinhoodChainAvailable (and ROBINHOOD_CHAIN_ID)', /import \{ isRobinhoodChainAvailable, ROBINHOOD_CHAIN_ID \} from '@\/lib\/server\/robinhoodChainConfig'/.test(workerSrc))
    check('imports buildWalletChainSelectionAudit', /import \{ buildWalletChainSelectionAudit \} from '@\/lib\/server\/walletChainSelectionAudit'/.test(workerSrc))
    check('runWalletScanV2Worker accepts a 4th, optional includeRobinhoodRequested param (additive, defaults false)', /export async function runWalletScanV2Worker\(rawBody: unknown, ip: string, jobId\?: string, includeRobinhoodRequested = false\)/.test(workerSrc))
    check('creates a robinhoodPromise calling scanRobinhoodWallet, gated on includeRobinhood', /const robinhoodPromise = includeRobinhood\s*\n\s*\? scanRobinhoodWallet\(walletAddress, fetch\)\.catch/.test(workerSrc))
    check('robinhoodPromise is started BEFORE the core await (concurrently, not sequentially)', workerSrc.indexOf('const robinhoodPromise') < workerSrc.indexOf('result = await corePromise'))
    check('robinhoodPromise has the same unhandled-rejection guard as fastSnapshotPromise', /robinhoodPromise\.catch\(\(\) => \{\}\)/.test(workerSrc))
  }

  // ── 2. Success path merges robinhood + a real, reconciled walletChainSelectionAudit ─────────────
  {
    check('awaits robinhoodPromise on the success path', /const robinhood = await robinhoodPromise/.test(workerSrc))
    check('reconciles finalChainsScanned against the REAL outcome (only true when robinhood is non-null)', /const actualChainsScanned = includeRobinhood && robinhood \? \[\.\.\.sanitized\.chains, 'robinhood'\] : \[\.\.\.sanitized\.chains\]/.test(workerSrc))
    check('merges body.data.robinhood additively (never replacing existing EVM fields)', /data: \{\s*\n\s*\.\.\.body\.data,\s*\n\s*robinhood: robinhood \? \{ holdings: robinhood\.holdings, activity: robinhood\.activity, pnl: robinhood\.pnl, audit: robinhood\.audit \} : null,\s*\n\s*walletChainSelectionAudit: finalWalletChainSelectionAudit,/.test(workerSrc))
    check('a failed/null robinhood scan merges robinhood: null, never a fabricated stand-in', /robinhood \? \{ holdings: robinhood\.holdings, activity: robinhood\.activity, pnl: robinhood\.pnl, audit: robinhood\.audit \} : null/.test(workerSrc))
  }

  // ── 3. The pre-scan intent log fires unconditionally, right after the existing CU-TRACK line ────
  {
    check('the existing "[CU-TRACK] deep-scan start" line is byte-identical (EVM-only, untouched)', /console\.warn\('\[CU-TRACK\] deep-scan start:', \{ walletAddress, scanMode: sanitized\.scanMode, chainsScanned: sanitized\.chains, chains: holdingsAllowedChainIds \}\)/.test(workerSrc))
    check('a NEW, adjacent "[CU-TRACK] wallet chain selection audit" log line exists', /console\.warn\('\[CU-TRACK\] wallet chain selection audit:', initialWalletChainSelectionAudit\)/.test(workerSrc))
    check('a final, reconciled audit log line exists on the success path', /console\.warn\('\[CU-TRACK\] wallet chain selection audit \(final\):', finalWalletChainSelectionAudit\)/.test(workerSrc))
  }

  // ── 4. The untouchable EVM pipeline stays untouched (repeat of the route-level test, worker scope) ─
  {
    check("fetchHoldings.ts contains no 'robinhood' reference anywhere", !/robinhood/i.test(holdingsSrc))
    check('fetchHoldings.ts contains no literal 4663 anywhere', !/4663/.test(holdingsSrc))
    check("SupportedChain union is still exactly 'base'|'eth'|'arbitrum'|'hyperevm' — no 'robinhood' member added", /export type SupportedChain = 'base' \| 'eth' \| 'arbitrum' \| 'hyperevm'/.test(chainTypesSrc))
    // UPDATED, DISCLOSED: gained a third named import (SUPPORTED_CHAIN_TO_CHAIN_ID, a real, already-
    // exported map this file already used internally — see test 7) — fetchAllHoldings/
    // resolveHoldingsAllowedChainIds themselves are unmodified.
    check('fetchAllHoldings/resolveHoldingsAllowedChainIds (and SUPPORTED_CHAIN_TO_CHAIN_ID) are still imported unmodified (same names) by the worker', /import \{ fetchAllHoldings, resolveHoldingsAllowedChainIds, SUPPORTED_CHAIN_TO_CHAIN_ID \} from '@\/lib\/engine\/modules\/holdings\/fetchHoldings'/.test(workerSrc))
    check('holdingsAllowedChainIds is still computed the exact same EVM-only way', /const holdingsAllowedChainIds = resolveHoldingsAllowedChainIds\(sanitized\.chains\)/.test(workerSrc))
  }

  // ── 5. includeRobinhoodRequested is threaded end-to-end: route → queue payload → job metadata → worker ─
  {
    check('WalletScanJobPayload carries includeRobinhoodRequested (optional, purely additive for existing callers)', /export type WalletScanJobPayload = \{[\s\S]*?includeRobinhoodRequested\?: boolean[\s\S]*?\}/.test(queueSrc))
    check('WalletScanJobMetadata carries includeRobinhoodRequested (optional, for records written before this task)', /export type WalletScanJobMetadata = \{[\s\S]*?includeRobinhoodRequested\?: boolean[\s\S]*?\}/.test(queueSrc))
    check('claimWalletScanPayload reads it back with a safe false default', /claimWalletScanPayload[\s\S]*?includeRobinhoodRequested: job\.includeRobinhoodRequested \?\? false/.test(queueSrc))
    check('claimNextWalletScanPayload reads it back with a safe false default', /claimNextWalletScanPayload[\s\S]*?includeRobinhoodRequested: job\.includeRobinhoodRequested \?\? false/.test(queueSrc))
    check('enqueueWalletScanJob writes it into the stored job record', /includeRobinhoodRequested: payload\.includeRobinhoodRequested \?\? false,/.test(queueSrc))
    check('app/api/wallet-scan/route.ts passes its own includeRobinhoodRequested decision into enqueueWalletScanJob', /await enqueueWalletScanJob\(jobId, \{ jobId, walletAddress: wallet, chains, scanMode, ip, includeRobinhoodRequested \}\)/.test(routeSrc))
    check('src/modules/walletScanWorker.ts passes payload.includeRobinhoodRequested as runWalletScanV2Worker\'s 4th arg', /payload\.includeRobinhoodRequested,\s*\n\s*\)/.test(workerModuleSrc))
  }

  // ── 6. UI prefers the worker's real, post-scan audit over the pre-scan enqueue-time one ─────────
  {
    check('page.tsx reads walletChainSelectionAudit off the completed job result and overrides state with it', /workerReportAudit[\s\S]*?setChainSelectionAudit\(workerReportAudit\)/.test(pageSrc))
  }

  // ── 7. workerChainPropagationAudit, DISCLOSED (Robinhood-worker-module-propagation fix): honest
  //    per-stage accounting of where chain 4663 is filtered out of the EVM-native worker stages, and
  //    whether it was still successfully re-attached via the canonical adapter.
  {
    check("SUPPORTED_CHAIN_TO_CHAIN_ID is imported for numeric chain-id keying", /import \{ fetchAllHoldings, resolveHoldingsAllowedChainIds, SUPPORTED_CHAIN_TO_CHAIN_ID \} from '@\/lib\/engine\/modules\/holdings\/fetchHoldings'/.test(workerSrc))
    check('ROBINHOOD_CHAIN_ID is imported from robinhoodChainConfig', /import \{ isRobinhoodChainAvailable, ROBINHOOD_CHAIN_ID \} from '@\/lib\/server\/robinhoodChainConfig'/.test(workerSrc))
    check('holdingsChainsProcessed is derived from the REAL chainHoldings rows, not just the requested list', /const holdingsChainsProcessed = Array\.from\(new Set\(chainHoldings\.map\(\(h\) => h\.chainId\)\)\)/.test(workerSrc))
    check('pricingChainsProcessed is derived from the REAL pricing.pricedHoldings rows', /const pricingChainsProcessed = Array\.from\(new Set\(pricing\.pricedHoldings\.map\(\(p\) => p\.chainId\)\)\)/.test(workerSrc))
    check('portfolioTotalByChain keys are numeric chain ids (via SUPPORTED_CHAIN_TO_CHAIN_ID), not EVM chain slugs', /portfolioTotalByChain\[String\(chainId\)\]/.test(workerSrc))
    check('Robinhood is keyed into portfolioTotalByChain under its real numeric ROBINHOOD_CHAIN_ID (4663), never a slug', /portfolioTotalByChain\[String\(ROBINHOOD_CHAIN_ID\)\]/.test(workerSrc))
    check('robinhoodDroppedAtStage is null (not dropped) exactly when a real robinhood result was merged', /const robinhoodDroppedAtStage: string \| null = robinhood\s*\n\s*\? null/.test(workerSrc))
    check('workerChainPropagationAudit object has all 8 required fields', /const workerChainPropagationAudit = \{\s*\n\s*selectedChainsFromOrchestrator: finalWalletChainSelectionAudit\.requestedChainsAfter,\s*\n\s*workerRequestedChains: holdingsAllowedChainIds,\s*\n\s*workerAllowedChains: holdingsAllowedChainIds,\s*\n\s*holdingsChainsProcessed,\s*\n\s*pricingChainsProcessed,\s*\n\s*portfolioChainsIncluded,\s*\n\s*robinhoodDroppedAtStage,\s*\n\s*dropReason: robinhoodDropReason,\s*\n\s*\}/.test(workerSrc))
    check('the audit is logged unconditionally on the success path', /console\.warn\('\[CU-TRACK\] worker chain propagation audit:', workerChainPropagationAudit\)/.test(workerSrc))
    // UPDATED, DISCLOSED (final-canonical-merge-proof follow-up): a new finalCanonicalMergeAudit
    // field was inserted between workerChainPropagationAudit and canonicalChainsScanned — both are
    // still merged into body.data, just no longer literally adjacent.
    // UPDATED, DISCLOSED (proof-that-Blockscout-is-actually-used follow-up): robinhoodBlockscoutUsageAudit
    // was inserted between finalCanonicalMergeAudit and canonicalChainsScanned — all three fields are
    // still merged into body.data, just no longer literally adjacent in that exact order.
    check('workerChainPropagationAudit is merged into body.data alongside the other new fields', /workerChainPropagationAudit,\s*\n\s*finalCanonicalMergeAudit,\s*\n\s*robinhoodBlockscoutUsageAudit,\s*\n\s*canonicalChainsScanned: actualChainsScanned,/.test(workerSrc))
    check('workerRequestedChains/workerAllowedChains are the SAME real value fetchAllHoldings was actually called with (holdingsAllowedChainIds) — never a separately-computed, possibly-diverging number', /workerRequestedChains: holdingsAllowedChainIds,\s*\n\s*workerAllowedChains: holdingsAllowedChainIds,/.test(workerSrc))
    check(
      "holdingsChainsProcessed/pricingChainsProcessed derivations read real chainId fields off EVM-only arrays (chainHoldings/pricing.pricedHoldings), never Robinhood/4663",
      /const holdingsChainsProcessed = Array\.from\(new Set\(chainHoldings\.map\(\(h\) => h\.chainId\)\)\)/.test(workerSrc)
      && /const pricingChainsProcessed = Array\.from\(new Set\(pricing\.pricedHoldings\.map\(\(p\) => p\.chainId\)\)\)/.test(workerSrc),
    )
  }

  // ── 8. valuedChainsDisplayed/partialChainsDisplayed/failedChainsDisplayed, DISCLOSED
  //    (Robinhood-partial-adapter-and-Blockscout-proof follow-up, this task's own explicit
  //    requirement 4): uiChainsDisplayed/cortexChainsDisplayed alone still list a scanned-but-
  //    unpriced Robinhood as "displayed" — these three fields are the honest split that lets a
  //    caller distinguish genuinely valued chains from ones that were merely attempted.
  {
    check(
      'robinhoodDisplayBucket is computed off includeRobinhoodRequested/robinhoodMerged/robinhoodHoldingsCount, not re-derived separately',
      /const robinhoodDisplayBucket: 'valued' \| 'partial' \| 'failed' \| null = !includeRobinhoodRequested/.test(workerSrc),
    )
    check('valuedChainsDisplayed starts from the real EVM chain list and adds robinhood only when robinhoodDisplayBucket is "valued"', /const valuedChainsDisplayed = \[\.\.\.sanitized\.chains, \.\.\.\(robinhoodDisplayBucket === 'valued' \? \['robinhood'\] : \[\]\)\]/.test(workerSrc))
    check('partialChainsDisplayed only ever contains robinhood, only when robinhoodDisplayBucket is "partial"', /const partialChainsDisplayed = robinhoodDisplayBucket === 'partial' \? \['robinhood'\] : \[\]/.test(workerSrc))
    check('failedChainsDisplayed only ever contains robinhood, only when robinhoodDisplayBucket is "failed"', /const failedChainsDisplayed = robinhoodDisplayBucket === 'failed' \? \['robinhood'\] : \[\]/.test(workerSrc))
    check('all three are merged into finalCanonicalMergeAudit alongside the existing uiChainsDisplayed/cortexChainsDisplayed fields', /uiChainsDisplayed: actualChainsScanned,\s*\n\s*cortexChainsDisplayed: actualChainsScanned,\s*\n\s*valuedChainsDisplayed,\s*\n\s*partialChainsDisplayed,\s*\n\s*failedChainsDisplayed,/.test(workerSrc))
  }

  // ── 9. robinhoodChainCallAudit, DISCLOSED (Wallet-Scanner-Robinhood-final-integration follow-up,
  //    this task's own explicit requirement 1): confirmed live confusion — walletChainSelectionAudit
  //    (a canonical INTENT audit) legitimately lists 4663/'robinhood' in requestedChainsAfter/
  //    finalChainsScanned, while the REAL EVM worker call ([chain-call-audit], fetchHoldings.ts) only
  //    ever logs Base+ETH — reusing requestedChains/allowedChains as field names in both reads, out
  //    of context, as if Robinhood silently dropped out of the canonical path. This new, distinctly-
  //    named log makes the sidecar mechanism explicit and cross-references the real EVM chain list.
  {
    const holdingsSrc2 = read('lib/engine/modules/holdings/fetchHoldings.ts')
    check(
      '[chain-call-audit] (the REAL EVM worker call, fetchHoldings.ts) is untouched by this task — still logs requestedChains/allowedChains/blockedChains only, never Robinhood',
      /console\.warn\('\[chain-call-audit\]', \{\s*\n\s*requestedChains: requestedChainIds,\s*\n\s*allowedChains: allowedChainIds,\s*\n\s*blockedChains: blockedChainIds,/.test(holdingsSrc2)
      && !/robinhood/i.test(holdingsSrc2) && !/4663/.test(holdingsSrc2),
    )
    check('robinhoodChainCallAudit is built as its own, distinctly-named object — never reusing the [chain-call-audit] field names for a different real meaning', /const robinhoodChainCallAudit = \{/.test(workerSrc))
    check('it explicitly identifies itself as a sidecar call, never part of the V2 worker\'s own chain-call-audit', /calledVia: 'sidecar_scanRobinhoodWallet',\s*\n\s*partOfV2WorkerChainCallAudit: false,/.test(workerSrc))
    check('it cross-references the REAL EVM chain list [chain-call-audit] was actually called with (holdingsAllowedChainIds), read directly off the same value the worker used — never re-derived', /v2WorkerChainCallAuditChains: holdingsAllowedChainIds,/.test(workerSrc))
    check('robinhoodResultReceived/robinhoodHoldingsStatus are real, post-await outcomes — read off the actual awaited robinhood result, never guessed before the scan completes', /robinhoodResultReceived: robinhood != null,\s*\n\s*robinhoodHoldingsStatus: robinhood\?\.holdings\.status \?\? null,/.test(workerSrc))
    check('robinhoodChainCallAudit is logged unconditionally, every scan', /console\.warn\('\[CU-TRACK\] robinhoodChainCallAudit:', robinhoodChainCallAudit\)/.test(workerSrc))
    check('robinhoodChainCallAudit is built AFTER robinhood is awaited (post-outcome, not pre-scan intent)', workerSrc.indexOf('const robinhood = await robinhoodPromise') < workerSrc.indexOf('const robinhoodChainCallAudit = {'))
  }

  console.log(`\n✅ ${passed} wallet-scan-worker-robinhood checks passed`)
}

run()
