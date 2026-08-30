// Tests for the Wallet Scanner deep scan chain coverage fix: a new, purely-additive
// walletChainSelectionAudit (lib/server/walletChainSelectionAudit.ts) that honestly records
// Robinhood's requested/allowed/omitted chain-id status, wired into the REAL route that was the
// confirmed root cause (app/api/wallet-scan/route.ts) and into the canonical orchestrator
// (lib/server/walletScanOrchestrator.ts). Source-level checks follow this session's established
// convention (scripts/test-wallet-scan-orchestrator.mjs); the pure buildWalletChainSelectionAudit()
// function is also exercised directly via dynamic import + tsx-transpiled behavior checks.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

function read(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

// tsx's `-e` eval mode does not reliably resolve named ESM exports (observed: only a `default`
// export surfaces). Writing a real temp .mjs file and running it avoids that and matches how tsx
// is used everywhere else in this codebase.
function runNodeScript(env, code) {
  const repoRoot = new URL('..', import.meta.url).pathname
  const tmpFile = path.join(os.tmpdir(), `wallet-chain-selection-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(tmpFile, code)
  try {
    return execFileSync(process.execPath, ['--import', 'tsx', tmpFile], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    })
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}

function run() {
  const auditSrc = read('lib/server/walletChainSelectionAudit.ts')
  const orchestratorSrc = read('lib/server/walletScanOrchestrator.ts')
  const routeSrc = read('app/api/wallet-scan/route.ts')
  const mergedViewSrc = read('app/frontend/lib/mergedWalletView.ts')
  const ledgerSrc = read('src/modules/providerCost/walletProviderCostLedger.ts')
  const chainTypesSrc = read('src/modules/providerFetchWindow/types.ts')

  // ── 1. buildWalletChainSelectionAudit exists with the required exact field set ────────────────
  {
    check('exports buildWalletChainSelectionAudit', /export function buildWalletChainSelectionAudit\(/.test(auditSrc))
    const typeMatch = auditSrc.match(/export type WalletChainSelectionAudit = \{[\s\S]*?\n\}\n/)
    check('WalletChainSelectionAudit type exists', typeMatch != null)
    const t = typeMatch ? typeMatch[0] : ''
    for (const field of [
      'requestedMode', 'enableRobinhood', 'envHasRobinhoodRpc', 'envHasGoldrush', 'envHasBlockscout',
      'requestedChains', 'allowedChains', 'omittedChains', 'omittedReasons', 'finalChainsScanned',
    ]) {
      check(`WalletChainSelectionAudit has field ${field}`, t.includes(field))
    }
    check('reuses ROBINHOOD_CHAIN_ID from robinhoodChainConfig.ts, never hardcodes 4663 as a magic number for it', /import \{[\s\S]*ROBINHOOD_CHAIN_ID[\s\S]*\} from '\.\/robinhoodChainConfig'/.test(auditSrc))
    check('reuses isRobinhoodChainFeatureEnabled/isRobinhoodRpcConfigured/isRobinhoodChainAvailable, never reimplements the env checks', /isRobinhoodChainFeatureEnabled[\s\S]*isRobinhoodRpcConfigured[\s\S]*isRobinhoodChainAvailable/.test(auditSrc))
    check('is side-effect-free: no fetch()/RPC call in this module', !/\bfetch\(/.test(auditSrc))
  }

  // ── 2. Behavioral checks: run the real function with different env combinations ────────────────
  {
    const code = `
      import { buildWalletChainSelectionAudit } from '/home/user/chainlens-ai-v-30-or-31/lib/server/walletChainSelectionAudit'
      const enabledAvailable = buildWalletChainSelectionAudit({ requestedMode: 'auto', evmChainSlugs: ['base','eth'], includeRobinhoodRequested: true, finalChainsScanned: ['base','eth','robinhood'] })
      console.log('ENABLED_AVAILABLE=' + JSON.stringify(enabledAvailable))
    `
    const out = runNodeScript({ ENABLE_ROBINHOOD_CHAIN: 'true', ALCHEMY_ROBINHOOD_RPC_URL: 'https://example.invalid/rpc' }, code)
    const line = out.split('\n').find((l) => l.startsWith('ENABLED_AVAILABLE='))
    const audit = JSON.parse(line.slice('ENABLED_AVAILABLE='.length))
    check('ENABLE_ROBINHOOD_CHAIN=true + RPC configured: requestedChains includes 4663', audit.requestedChains.includes(4663))
    check('ENABLE_ROBINHOOD_CHAIN=true + RPC configured: allowedChains includes 4663', audit.allowedChains.includes(4663))
    check('ENABLE_ROBINHOOD_CHAIN=true + RPC configured: requestedChains includes base(8453)/eth(1)', audit.requestedChains.includes(8453) && audit.requestedChains.includes(1))
    check('ENABLE_ROBINHOOD_CHAIN=true + RPC configured: omittedChains does not include 4663', !audit.omittedChains.includes(4663))
    check('ENABLE_ROBINHOOD_CHAIN=true + RPC configured: finalChainsScanned includes robinhood', audit.finalChainsScanned.includes('robinhood'))
  }

  {
    const code = `
      import { buildWalletChainSelectionAudit } from '/home/user/chainlens-ai-v-30-or-31/lib/server/walletChainSelectionAudit'
      const disabled = buildWalletChainSelectionAudit({ requestedMode: 'auto', evmChainSlugs: ['base','eth'], includeRobinhoodRequested: true, finalChainsScanned: ['base','eth'] })
      console.log('DISABLED=' + JSON.stringify(disabled))
    `
    const out = runNodeScript({ ENABLE_ROBINHOOD_CHAIN: 'false', ALCHEMY_ROBINHOOD_RPC_URL: '' }, code)
    const line = out.split('\n').find((l) => l.startsWith('DISABLED='))
    const audit = JSON.parse(line.slice('DISABLED='.length))
    check('Robinhood disabled: requestedChains still includes 4663 (it was requested)', audit.requestedChains.includes(4663))
    check('Robinhood disabled: allowedChains does NOT include 4663', !audit.allowedChains.includes(4663))
    check('Robinhood disabled: omittedChains includes 4663', audit.omittedChains.includes(4663))
    check("Robinhood disabled: omittedReasons['4663'] === 'robinhood_disabled'", audit.omittedReasons['4663'] === 'robinhood_disabled')
    check('Robinhood disabled: not silently omitted — a reason is always present', typeof audit.omittedReasons['4663'] === 'string' && audit.omittedReasons['4663'].length > 0)
  }

  {
    const code = `
      import { buildWalletChainSelectionAudit } from '/home/user/chainlens-ai-v-30-or-31/lib/server/walletChainSelectionAudit'
      const noRpc = buildWalletChainSelectionAudit({ requestedMode: 'auto', evmChainSlugs: ['base','eth'], includeRobinhoodRequested: true, finalChainsScanned: ['base','eth'] })
      console.log('NO_RPC=' + JSON.stringify(noRpc))
    `
    const out = runNodeScript({ ENABLE_ROBINHOOD_CHAIN: 'true', ALCHEMY_ROBINHOOD_RPC_URL: '' }, code)
    const line = out.split('\n').find((l) => l.startsWith('NO_RPC='))
    const audit = JSON.parse(line.slice('NO_RPC='.length))
    check('Feature flag on, RPC missing: requestedChains includes 4663', audit.requestedChains.includes(4663))
    check('Feature flag on, RPC missing: allowedChains does NOT include 4663', !audit.allowedChains.includes(4663))
    check("Feature flag on, RPC missing: omittedReasons['4663'] === 'robinhood_rpc_not_configured' (not_configured, not silent)", audit.omittedReasons['4663'] === 'robinhood_rpc_not_configured')
  }

  // ── 3. Wired into app/api/wallet-scan/route.ts, THE route the live logs came from ───────────────
  {
    check('imports buildWalletChainSelectionAudit', /import \{ buildWalletChainSelectionAudit \} from '@\/lib\/server\/walletChainSelectionAudit'/.test(routeSrc))
    check('imports isRobinhoodChainAvailable', /import \{ isRobinhoodChainAvailable \} from '@\/lib\/server\/robinhoodChainConfig'/.test(routeSrc))
    check('imports scanRobinhoodWallet for the cache-warm call', /import \{ scanRobinhoodWallet \} from '@\/lib\/server\/robinhoodWalletScanner'/.test(routeSrc))
    check('response includes walletChainSelectionAudit additively alongside jobId/wallet/status', /NextResponse\.json\(\{ jobId, wallet, status: 'queued', walletChainSelectionAudit \}\)/.test(routeSrc))
    check('logs the audit', /console\.log\('\[wallet-scan\] walletChainSelectionAudit', walletChainSelectionAudit\)/.test(routeSrc))
    check('the Robinhood cache-warm call is fire-and-forget (void, never awaited in the response path)', /void scanRobinhoodWallet\(wallet, fetch\)\.catch/.test(routeSrc))
    // The chains array actually enqueued must never contain 'robinhood' — regex-confirm the
    // enqueue call still only ever references the filtered `chains` variable.
    const enqueueCallMatch = routeSrc.match(/await enqueueWalletScanJob\(jobId, \{[\s\S]*?\}\)/)
    check('enqueueWalletScanJob call exists', enqueueCallMatch != null)
    check("enqueueWalletScanJob call passes `chains` (the EVM-only variable), never a literal 'robinhood'", enqueueCallMatch != null && /chains,/.test(enqueueCallMatch[0]) && !/'robinhood'/.test(enqueueCallMatch[0]))
    check("the `chains` variable itself is explicitly filtered to exclude 'robinhood' before being used", /chains = \(rawChains \? rawChains\.filter\(\(c\) => c\.toLowerCase\(\) !== 'robinhood'\)/.test(routeSrc))
  }

  // ── 4. Wired into the canonical orchestrator ────────────────────────────────────────────────────
  {
    check('CanonicalWalletScanResult includes walletChainSelectionAudit: WalletChainSelectionAudit', /walletChainSelectionAudit: WalletChainSelectionAudit/.test(orchestratorSrc))
    check('runWalletScan builds the audit via buildWalletChainSelectionAudit', /const walletChainSelectionAudit = buildWalletChainSelectionAudit\(/.test(orchestratorSrc))
    check('runWalletScan logs the audit', /console\.log\('\[walletScanOrchestrator\] walletChainSelectionAudit', walletChainSelectionAudit\)/.test(orchestratorSrc))
    check('the result object always includes walletChainSelectionAudit (not gated behind params.debug)', /walletChainSelectionAudit,\s*\n\s*\}/.test(orchestratorSrc))
    // Already-correct behavior (prior task) — confirm it still holds alongside the new field.
    check("orchestrator still pushes 'robinhood' into chainsScanned on a real successful Robinhood scan", /chainsScanned = chainsScanned\.concat\(\['robinhood'\]\)/.test(orchestratorSrc))
  }

  // ── 5. mergedWalletView.ts exact wording for the disabled/not-configured case ──────────────────
  {
    check("exports the exact string 'Robinhood Chain not scanned — not configured'", /export const ROBINHOOD_NOT_CONFIGURED_COPY = 'Robinhood Chain not scanned — not configured'/.test(mergedViewSrc))
    check('exports robinhoodStatusCopy(robinhoodResult, robinhoodIncluded)', /export function robinhoodStatusCopy\(/.test(mergedViewSrc))
    check('robinhoodStatusCopy returns the not-configured copy specifically for holdings.status === not_configured', /status === 'not_configured'\) return ROBINHOOD_NOT_CONFIGURED_COPY/.test(mergedViewSrc))
    check('computeRobinhoodInclusion (requirement 6, already correct) is untouched — still requires ok:true and status ok|partial', /if \(!robinhoodResult \|\| !robinhoodResult\.ok\) return \{ included: false, valueUsd: null \}/.test(mergedViewSrc) && /if \(status !== 'ok' && status !== 'partial'\) return \{ included: false, valueUsd: null \}/.test(mergedViewSrc))
  }

  // ── 6. No duplicate totals: computeMergedTotalValueUsd still sums exactly once, unchanged ────────
  {
    check('computeMergedTotalValueUsd sums v2Total + robinhood valueUsd exactly once (no duplicate addition)', /return \{ totalValueUsd: \(v2Total \?\? 0\) \+ \(valueUsd \?\? 0\), robinhoodIncluded: included, robinhoodValueUsd: valueUsd \}/.test(mergedViewSrc))
  }

  // ── 7. The untouchable EVM pipeline stays untouched: no 'robinhood'/4663 in its typed internals ──
  {
    check("SupportedChain union is still exactly 'base'|'eth'|'arbitrum'|'hyperevm' — no 'robinhood' member added", /export type SupportedChain = 'base' \| 'eth' \| 'arbitrum' \| 'hyperevm'/.test(chainTypesSrc))
    check("walletProviderCostLedger.ts's callsByChain/chain fields still typed off SupportedChain, no Robinhood-specific addition", !/robinhood/i.test(ledgerSrc))
  }

  console.log(`\n✅ ${passed} wallet-chain-selection-audit checks passed`)
}

run()
