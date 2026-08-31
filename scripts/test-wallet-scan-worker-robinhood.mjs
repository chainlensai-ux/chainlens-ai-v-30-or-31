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
    check('workerChainPropagationAudit is merged into body.data alongside the other new fields', /workerChainPropagationAudit,\s*\n\s*canonicalChainsScanned: actualChainsScanned,/.test(workerSrc))
    check('workerRequestedChains/workerAllowedChains are the SAME real value fetchAllHoldings was actually called with (holdingsAllowedChainIds) — never a separately-computed, possibly-diverging number', /workerRequestedChains: holdingsAllowedChainIds,\s*\n\s*workerAllowedChains: holdingsAllowedChainIds,/.test(workerSrc))
    check(
      "holdingsChainsProcessed/pricingChainsProcessed derivations read real chainId fields off EVM-only arrays (chainHoldings/pricing.pricedHoldings), never Robinhood/4663",
      /const holdingsChainsProcessed = Array\.from\(new Set\(chainHoldings\.map\(\(h\) => h\.chainId\)\)\)/.test(workerSrc)
      && /const pricingChainsProcessed = Array\.from\(new Set\(pricing\.pricedHoldings\.map\(\(p\) => p\.chainId\)\)\)/.test(workerSrc),
    )
  }

  console.log(`\n✅ ${passed} wallet-scan-worker-robinhood checks passed`)
}

run()
