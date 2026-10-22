// Scan-window labels and the Wallet Read's next action after a deep scan.
//   npx tsx --test app/frontend/lib/scanWindow.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectScanWindow } from './scanWindow'
import { buildNextAction, selectPersonalityLabel } from './walletReadBuilder'

test('selectScanWindow: narrowed only when the scan read less than its configured window', () => {
  assert.deepEqual(selectScanWindow({ windowCoverage: { realDataDays: 6 }, scanMetadata: { provider_fetch_window_days: 90, scanMode: 'deep' } }), { windowDays: 6, narrowed: true, deepScan: true })
  assert.deepEqual(selectScanWindow({ windowCoverage: { realDataDays: 90 }, scanMetadata: { provider_fetch_window_days: 90, scanMode: 'normal' } }), { windowDays: 90, narrowed: false, deepScan: false })
  assert.deepEqual(selectScanWindow(null), { windowDays: null, narrowed: false, deepScan: false })
})

test('buildNextAction: never suggests a deep scan that already ran', () => {
  const base = { robinhoodPnlLane: 'not_scanned' as never, robinhoodResult: null, concentrationLabel: null }
  const deepNarrowed = selectScanWindow({ windowCoverage: { realDataDays: 6 }, scanMetadata: { provider_fetch_window_days: 90, scanMode: 'deep' } })
  const partial = buildNextAction({ ...base, evmPnlLane: 'partial', scanWindow: deepNarrowed })
  assert.doesNotMatch(partial, /Run Deep Scan/)
  assert.match(partial, /last 6d/)
  assert.doesNotMatch(buildNextAction({ ...base, evmPnlLane: 'unavailable', scanWindow: deepNarrowed }), /Run Deep Scan/)
  assert.match(buildNextAction({ ...base, evmPnlLane: 'partial' }), /Run Deep Scan/)
})

test('selectPersonalityLabel: an LP-strategy wallet is a Liquidity Provider, not a Rotator', () => {
  const rotator = { rotationStyle: { value: 'rotator' }, multiChainParticipation: { activeChains: ['base'] } } as never
  assert.equal(selectPersonalityLabel(rotator), 'Rotator')
  assert.equal(selectPersonalityLabel(rotator, true), 'Liquidity Provider')
})
