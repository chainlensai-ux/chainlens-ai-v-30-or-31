// Static check: public PnL card must not render server-only wallet-scanner audits,
// and raw exclusion counts must sit behind Technical details.
//   npx tsx --test src/pipeline/walletScannerPublicUiLeak.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const uiSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../app/frontend/components/PnlStatusCard.tsx'), 'utf8')

test('public PnL card hides raw debug behind Technical details and never names server audits', () => {
  assert.doesNotMatch(uiSrc, /walletWorkerTimingAudit/)
  assert.doesNotMatch(uiSrc, /legacyMisleadingCurrentPriceCallsUsedForUnrealized/)
  assert.doesNotMatch(uiSrc, /goldRushHistoricalPricingEfficiencyAudit/)
  assert.doesNotMatch(uiSrc, /openPositionExclusionAudit/)
  assert.doesNotMatch(uiSrc, /walletProviderCostAudit/)
  assert.match(uiSrc, /Technical details/)
  assert.match(uiSrc, /Realized PnL: <strong/)
  assert.match(uiSrc, /Unrealized PnL: <strong/)
  assert.match(uiSrc, /currently held/)
})
