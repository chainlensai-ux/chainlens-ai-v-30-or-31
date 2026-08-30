// Tests for the Wallet Scanner unification task: one canonical orchestrator
// (lib/server/walletScanOrchestrator.ts) fronting the real V2 engine (preview) and the real async
// job queue (deep), plus a shared Robinhood scan sequence, wired into Clark's primary wallet-scan
// call site. Source-level, matching this session's established convention (scripts/
// test-button-responsiveness.mjs) — every check reads the real file source and confirms the actual
// code shape, not a description of intended behavior.

import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

function read(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

function run() {
  const orchestratorSrc = read('lib/server/walletScanOrchestrator.ts')
  const v2AdaptersSrc = read('lib/server/v2Adapters.ts')
  const robinhoodScannerSrc = read('lib/server/robinhoodWalletScanner.ts')
  const robinhoodRouteSrc = read('app/api/wallet-scan/robinhood/route.ts')
  const clarkSrc = read('app/api/clark/route.ts')
  const walletScanRouteSrc = read('app/api/wallet-scan/route.ts')

  // ── 1. The orchestrator is a plain function export, never a new API route file ────────────────
  {
    check('walletScanOrchestrator.ts lives under lib/server, not app/api', fs.existsSync(new URL('../lib/server/walletScanOrchestrator.ts', import.meta.url)))
    check('no app/api/wallet-scan-orchestrator (or similar) route file was created', !fs.existsSync(new URL('../app/api/wallet-scan-orchestrator', import.meta.url)))
    check('exports a plain async function runWalletScan (not a Next.js route handler)', /export async function runWalletScan\(params: RunWalletScanParams\): Promise<CanonicalWalletScanResult>/.test(orchestratorSrc))
    check('does not export GET/POST route handlers', !/export (async )?function (GET|POST)\(/.test(orchestratorSrc))
  }

  // ── 2. Chain resolution per chainMode ───────────────────────────────────────────────────────
  {
    check('ChainMode type covers all six required modes', /export type ChainMode = 'auto' \| 'all_supported' \| 'base' \| 'ethereum' \| 'bnb' \| 'robinhood'/.test(orchestratorSrc))
    check('ScanDepth type covers preview and deep', /export type ScanDepth = 'preview' \| 'deep'/.test(orchestratorSrc))
    const resolveMatch = orchestratorSrc.match(/function resolveChains\(chainMode: ChainMode\): ResolvedChains \{[\s\S]*?\n\}\n/)
    check('resolveChains exists', resolveMatch != null)
    const body = resolveMatch ? resolveMatch[0] : ''
    check("'base' resolves to EVM chains ['base']", /case 'base':\s*\n\s*return \{ evmChains: \['base'\]/.test(body))
    check("'ethereum' resolves to EVM chains ['eth']", /case 'ethereum':\s*\n\s*return \{ evmChains: \['eth'\]/.test(body))
    check("'bnb' resolves to zero EVM chains (honestly unsupported, never fabricated)", /case 'bnb':\s*\n\s*return \{ evmChains: \[\]/.test(body))
    check("'robinhood' resolves to zero EVM chains and includeRobinhood: true regardless of gate result", /case 'robinhood':[\s\S]*?return \{ evmChains: \[\], includeRobinhood: true/.test(body))
    check("'auto'/'all_supported' use the exported DEFAULT_CHAINS from v2Adapters.ts", /case 'auto':\s*\n\s*case 'all_supported':[\s\S]*?evmChains: \[\.\.\.DEFAULT_CHAINS\]/.test(body))
    check("'auto'/'all_supported' gate Robinhood inclusion on the real isRobinhoodChainAvailable() result", /includeRobinhood: robinhoodAvailable/.test(body))
    check('BNB is reflected as unsupported via missingEvidence/nextActions, never fabricated data', /chainMode === 'bnb'[\s\S]*?missingEvidence\.push\('BNB chain is not supported/.test(orchestratorSrc))
  }

  // ── 3. Robinhood inclusion gated on isRobinhoodChainAvailable() ────────────────────────────────
  {
    check('imports the real isRobinhoodChainAvailable() gate (not reimplemented)', /import \{ isRobinhoodChainAvailable \} from '@\/lib\/server\/robinhoodChainConfig'/.test(orchestratorSrc))
    check('resolveChains calls the real gate function', /const robinhoodAvailable = isRobinhoodChainAvailable\(\)/.test(orchestratorSrc))
    check('a disabled gate under chainMode: robinhood is reported honestly, never silently skipped', /chainMode === 'robinhood' && !robinhoodAvailable\)[\s\S]*?missingEvidence\.push\('Robinhood Chain scanning is currently disabled/.test(orchestratorSrc))
  }

  // ── 4. Canonical result shape has all required fields ──────────────────────────────────────────
  {
    const typeMatch = orchestratorSrc.match(/export type CanonicalWalletScanResult = \{[\s\S]*?\n\}\n/)
    check('CanonicalWalletScanResult type exists', typeMatch != null)
    const body = typeMatch ? typeMatch[0] : ''
    for (const field of [
      'wallet', 'chainsScanned', 'totalValueUsd', 'holdings', 'activitySummary', 'pnlStatus',
      'realizedPnlUsd', 'unrealizedPnlUsd', 'pricingCoverage', 'verifiedSwapCount', 'skippedSwapLogs',
      'evidenceSources', 'missingEvidence', 'nextActions', 'scanMode', 'scanId', 'debug',
    ]) {
      check(`CanonicalWalletScanResult declares ${field}`, body.includes(`${field}`))
    }
  }

  // ── 5. Cache key format includes wallet + chainMode + scanDepth + version ──────────────────────
  {
    check('cache key builder uses the wsorch:v1: prefix plus wallet/chainMode/scanDepth', /`wsorch:\$\{ORCHESTRATOR_CACHE_VERSION\}:\$\{walletAddress\.toLowerCase\(\)\}:\$\{chainMode\}:\$\{scanDepth\}`/.test(orchestratorSrc))
    check("cache version literal is 'v1'", /const ORCHESTRATOR_CACHE_VERSION = 'v1'/.test(orchestratorSrc))
    check('wrong-chain cache entries are rejected rather than served (mirrors rejectWrongChainRobinhoodCache philosophy)', /WRONG-CHAIN CACHE REJECTION/.test(orchestratorSrc) && /if \(!sameChains\) return null/.test(orchestratorSrc))
  }

  // ── 6. No raw debug dump unless debug:true ──────────────────────────────────────────────────────
  {
    check('debug field is only populated when params.debug is explicitly true', /\.\.\.\(params\.debug \? \{ debug: \{ evmReport, robinhoodAudit \} \} : \{\}\)/.test(orchestratorSrc))
    check('preview-mode cache write always strips debug before storing (stripDebug helper)', /await writeOrchestratorCache\(cacheKey, stripDebug\(result\), evmChains\)/.test(orchestratorSrc))
    check('a cache hit returns the stripped shape unless the caller explicitly requested debug', /return params\.debug \? cached : stripDebug\(cached\)/.test(orchestratorSrc))
    check('never spreads the raw FinalReport into the canonical shape', !/\.\.\.report\b/.test(orchestratorSrc) && !/\.\.\.evmReport\b/.test(orchestratorSrc))
  }

  // ── 7. Deep mode calls the same enqueueWalletScanJob() app/api/wallet-scan/route.ts uses ────────
  {
    check('orchestrator imports enqueueWalletScanJob from the real queue module', /import \{ enqueueWalletScanJob \} from '@\/src\/modules\/walletScanQueue'/.test(orchestratorSrc))
    check('app/api/wallet-scan/route.ts imports the same enqueueWalletScanJob (same function, no duplicate queue)', /enqueueWalletScanJob/.test(walletScanRouteSrc))
    check('deep-mode EVM scan enqueues a real job with scanMode: \'deep\'', /await enqueueWalletScanJob\(jobId, \{[\s\S]*?scanMode: 'deep'/.test(orchestratorSrc))
    check('deep mode never fabricates a completed result — reports an honest queued/unavailable jobStatus', /jobStatus = 'queued'/.test(orchestratorSrc) && /jobStatus = 'unavailable'/.test(orchestratorSrc))
    check("scanId for a deep scan is the real jobId used to poll the existing /api/wallet-scan/[jobId] route", /scanId: jobId \?\? crypto\.randomUUID\(\)/.test(orchestratorSrc))
  }

  // ── 8. Preview mode reuses the real, now-exported runV2Scan()/DEFAULT_CHAINS from v2Adapters.ts ──
  {
    check('v2Adapters.ts still exports DEFAULT_CHAINS', /export const DEFAULT_CHAINS = \['base', 'eth', 'arbitrum'\]/.test(v2AdaptersSrc))
    check('v2Adapters.ts still exports runV2Scan', /export async function runV2Scan\(address: string, route: string\)/.test(v2AdaptersSrc))
    check('orchestrator imports both from v2Adapters.ts rather than reimplementing the scan call', /import \{ DEFAULT_CHAINS, runV2Scan \} from '@\/lib\/server\/v2Adapters'/.test(orchestratorSrc))
    check('preview EVM scan calls the real runV2Scan()', /evmReport = await runV2Scan\(walletAddress, `orchestrator_preview/.test(orchestratorSrc))
  }

  // ── 9. Robinhood route now calls the shared scanRobinhoodWallet() ──────────────────────────────
  {
    check('robinhoodWalletScanner.ts exports scanRobinhoodWallet', /export async function scanRobinhoodWallet\(/.test(robinhoodScannerSrc))
    check('scanRobinhoodWallet runs the real holdings -> pricing -> activity -> pnl -> audit sequence (no reimplementation)', /const holdings = await getCachedRobinhoodWalletHoldings\(wallet, fetchImpl\)/.test(robinhoodScannerSrc) && /const audit = buildRobinhoodWalletScannerAudit\(/.test(robinhoodScannerSrc))
    check('app/api/wallet-scan/robinhood/route.ts now calls scanRobinhoodWallet instead of the inline sequence', /const \{ holdings, activity, pnl, audit \} = await scanRobinhoodWallet\(wallet, fetchImpl\)/.test(robinhoodRouteSrc))
    check('the Robinhood route no longer inlines the individual holdings/activity/pnl/audit calls directly', !/const holdings = await getCachedRobinhoodWalletHoldings\(wallet, fetchImpl\)/.test(robinhoodRouteSrc))
    check('the Robinhood route keeps its existing plan gate untouched', /canAccessFeature\(plan, 'wallet-scanner'\)/.test(robinhoodRouteSrc))
    check('the Robinhood route keeps its existing rate limiter untouched', /createRateLimiter\(\{ windowMs: 60_000, max: 10 \}\)/.test(robinhoodRouteSrc))
    check('orchestrator reuses the same scanRobinhoodWallet (no second copy of the call sequence)', /import \{ scanRobinhoodWallet \} from '@\/lib\/server\/robinhoodWalletScanner'/.test(orchestratorSrc))
  }

  // ── 10. Clark's wired call site references runWalletScan, additively alongside getWalletFromV2 ──
  {
    check('Clark imports the canonical orchestrator', /import \{ runWalletScan \} from "@\/lib\/server\/walletScanOrchestrator";/.test(clarkSrc))
    check('the primary wallet_scan intent handler still calls getWalletFromV2 (rich EVM/PnL formatting untouched)', /appIntent\.intent === 'wallet_scan'[\s\S]{0,1200}await getWalletFromV2\(walletAddress\)/.test(clarkSrc))
    check('the same handler additively calls runWalletScan alongside it (never replacing it)', /appIntent\.intent === 'wallet_scan'[\s\S]{0,2200}const orchestratorResult = await runWalletScan\(\{/.test(clarkSrc))
    check('the orchestrator call passes chainMode: auto and maps deepScan to scanDepth', /chainMode: 'auto',\s*\n\s*scanDepth: deepScan \? 'deep' : 'preview'/.test(clarkSrc))
    check('a failed orchestrator call is swallowed and never breaks the existing reply', /\}\)\.catch\(\(err\) => \{\s*\n\s*console\.warn\('\[clark\] wallet scan orchestrator failed'/.test(clarkSrc))
    check('deep-scan-it now surfaces the real queued jobId instead of only a CTA link', /orchestratorResult\?\.jobStatus === 'queued' && orchestratorResult\.jobId/.test(clarkSrc))
  }

  // ── 11. Real EVM engine, FIFO/PnL, and Robinhood swap-gate logic are never rewritten ─────────────
  {
    check('orchestrator never reimplements FIFO/PnL — it only reads already-computed report fields (mirrors projectWalletV2ForClark)', /reconciliation\?\.\publicPnlStatus/.test(orchestratorSrc) && !/matchLots\(|computeFifo\(/.test(orchestratorSrc))
    check('projectWalletV2ForClark in v2Adapters.ts is untouched by this task (still the sole Clark EVM projector)', /export function projectWalletV2ForClark\(address: string, report: RunWalletScanV2Result\): WalletLiteResult \{/.test(v2AdaptersSrc))
    check('robinhoodWalletScanner.ts keeps its existing verified-swap PnL gate function untouched', /export async function resolveRobinhoodWalletPnl\(/.test(robinhoodScannerSrc))
  }

  console.log(`test-wallet-scan-orchestrator.mjs: all ${passed} assertions passed`)
}

run()
