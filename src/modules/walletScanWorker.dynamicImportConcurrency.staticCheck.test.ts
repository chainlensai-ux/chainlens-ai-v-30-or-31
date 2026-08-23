// PERF-SPRINT TASK, DISCLOSED: static source check for the dynamic-import parallelization — see
// walletScanWorker.ts's own PERF-SPRINT comment right above the Promise.all block for the full
// "why this is safe" disclosure (each import is an independent module; none depends on another's
// resolved value; only ordering requirement is "before runWalletScanV2Worker starts", which
// Promise.all already guarantees).
// Run directly with:
//   npx tsx --test src/modules/walletScanWorker.dynamicImportConcurrency.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./walletScanWorker.ts', import.meta.url)), 'utf8')

describe('executeWalletScanJob dynamic imports run concurrently (perf-sprint: "detect sequential operations that could safely run in parallel")', () => {
  it('all reset-module imports resolve via one Promise.all, not sequential awaits', () => {
    assert.match(src, /\] = await Promise\.all\(\[\s*\n\s*import\('@\/lib\/server\/alchemyAudit'\)/, 'the destructured import results must come from a single Promise.all call')
    // Every module previously imported individually must still be imported — this only checks the
    // mechanism changed (concurrent vs sequential), not that any import was dropped.
    const expectedModules = [
      '@/lib/server/alchemyAudit',
      '@/workers/walletScanV2',
      '@/src/modules/pricingAtTimeEngine/sources/basedex',
      '@/src/modules/pricingAtTimeEngine/sources/goldrushPriceSource',
      '@/src/modules/pricingAtTimeEngine/sources/dexscreener',
      '@/src/modules/pricingAtTimeEngine/sources/coingecko',
      '@/src/pipeline/providers/geckoTerminalPriceSource',
      '@/src/pipeline/pricingAtTimeAdapter',
      '@/src/modules/providerFetchWindow/index',
      '@/src/modules/recoveryPolicy/utils',
      '@/src/lib/dexscreenerRequestCache',
      '@/src/modules/pricingAtTimeEngine/sources/alchemyHistoricalPriceSource',
      '@/src/modules/nativePriceResolver/index',
      '@/src/modules/providerCost/walletProviderCostLedger',
    ]
    for (const modulePath of expectedModules) {
      assert.match(src, new RegExp(`import\\('${modulePath.replace(/\//g, '\\/')}'\\)`), `${modulePath} must still be imported`)
    }
    // No sequential `await import(...)` should remain for any of these reset modules inside
    // executeWalletScanJob — a lingering sequential await would mean a module got left behind
    // during the Promise.all conversion rather than genuinely running concurrently.
    assert.doesNotMatch(src, /const \{ resetAlchemyAudit[\s\S]{0,50}\} = await import\(/, 'resetAlchemyAudit must not be individually awaited anymore')
  })

  it('claimWalletScanPayload (a separate function, runWalletScanWorker) is untouched — single import, nothing to parallelize', () => {
    assert.match(src, /const \{ claimWalletScanPayload \} = await import\('@\/src\/modules\/walletScanQueue'\)/, 'runWalletScanWorker\'s own single dynamic import must be unchanged')
  })
})
