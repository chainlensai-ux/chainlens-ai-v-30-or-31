// TESTS — Wallet Scanner graph/API + DEX model support audit task.
//
// Covers:
//   1. validatePreScan's existing chain-allowlist behavior for an unsupported chain (e.g.
//      'robinhood'/'bnb', which this pipeline's providerFetchWindow/holdings/dedupe layer has zero
//      integration for today) — confirms it degrades honestly (valid:false, real error, empty
//      sanitizedChains) rather than crashing or silently pretending to support the chain.
//   2. buildWalletScannerProviderSupportAudit — the new, purely-additive audit aggregator — for
//      coverage-gap detection, provider-failure reporting, duplicate-count reporting, and the
//      LP/uncertain-event exclusion counts it reuses from eventClassification's own real pass.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePreScan } from './utils'
import { buildWalletScannerProviderSupportAudit } from './index'
import type { RunWalletScanParams } from './types'

function preScanParams(overrides: Partial<RunWalletScanParams> = {}): RunWalletScanParams {
  return {
    walletAddress: '0x111111111111111111111111111111111111111a',
    chains: ['base'],
    scanMode: 'normal',
    ...overrides,
  }
}

test('ROBINHOOD/BNB UNSUPPORTED PATH: a request for only unsupported chains fails closed, never crashes, never fakes coverage', () => {
  const result = validatePreScan(preScanParams({ chains: ['robinhood', 'bnb'] }))
  assert.equal(result.valid, false)
  assert.deepEqual(result.sanitizedChains, [])
  assert.ok(result.errors.some((e) => /none of the requested chains are supported/.test(e)))
})

test('a mixed request (one supported, one unsupported chain) sanitizes down to only the supported chain, not zero and not a crash', () => {
  const result = validatePreScan(preScanParams({ chains: ['base', 'robinhood'] }))
  assert.equal(result.valid, true)
  assert.deepEqual(result.sanitizedChains, ['base'])
})

test('buildWalletScannerProviderSupportAudit: a requested-but-unsupported chain is reported as a real coverage gap', () => {
  const audit = buildWalletScannerProviderSupportAudit({
    requestedChains: ['base', 'robinhood'],
    enabledChains: ['base'],
    scanMode: 'normal',
    providerDiagnostics: [
      { chain: 'base', providerStatus: 'ok', goldrush: { ok: true, errorReason: null }, alchemy: { ok: true, errorReason: null } },
    ],
    eventsByClassification: {
      genuine_trade_leg: 4, ordinary_transfer: 0, distribution_airdrop: 0, router_intermediary: 0,
      bridge: 0, lp_staking: 0, dust_non_economic: 0, unknown: 0,
    },
    duplicateEventCount: 0,
    runtimeCommitSha: null,
  })

  assert.deepEqual(audit.coverageGaps, [{ chain: 'robinhood', reason: 'chain_not_supported_by_wallet_scanner' }])
  assert.deepEqual(audit.requestedChains, ['base', 'robinhood'])
  assert.deepEqual(audit.enabledChains, ['base'])
  // Never fabricated — this codebase has no per-protocol swap breakdown threaded to this layer.
  assert.equal(audit.dexModelsDetected, null)
  assert.equal(audit.v2EventsDetected, null)
  assert.equal(audit.v3EventsDetected, null)
  assert.equal(audit.v4EventsDetected, null)
  assert.equal(audit.concentratedEventsDetected, null)
})

test('buildWalletScannerProviderSupportAudit: a provider failure on an ENABLED chain surfaces as both providerFailures and a coverage gap — never silently dropped, never faked as healthy', () => {
  const audit = buildWalletScannerProviderSupportAudit({
    requestedChains: ['base'],
    enabledChains: ['base'],
    scanMode: 'normal',
    providerDiagnostics: [
      { chain: 'base', providerStatus: 'provider_unavailable', goldrush: { ok: false, errorReason: 'timeout' }, alchemy: { ok: false, errorReason: 'timeout' } },
    ],
    eventsByClassification: {
      genuine_trade_leg: 0, ordinary_transfer: 0, distribution_airdrop: 0, router_intermediary: 0,
      bridge: 0, lp_staking: 0, dust_non_economic: 0, unknown: 0,
    },
    duplicateEventCount: 0,
    runtimeCommitSha: null,
  })

  assert.equal(audit.providerFailures.length, 2)
  assert.ok(audit.providerFailures.every((f) => f.chain === 'base' && f.errorReason === 'timeout'))
  assert.deepEqual(audit.providerSourcesFailed.sort(), ['alchemy', 'goldrush'])
  assert.deepEqual(audit.providerSourcesSucceeded, [])
  assert.deepEqual(audit.coverageGaps, [{ chain: 'base', reason: 'provider_unavailable_this_scan' }])
})

test('buildWalletScannerProviderSupportAudit: LP/uncertain events reported are exactly eventClassification\'s own FIFO-excluded set, never counting genuine_trade_leg/unknown/dust_non_economic', () => {
  const audit = buildWalletScannerProviderSupportAudit({
    requestedChains: ['base'],
    enabledChains: ['base'],
    scanMode: 'normal',
    providerDiagnostics: [
      { chain: 'base', providerStatus: 'ok', goldrush: { ok: true, errorReason: null }, alchemy: { ok: true, errorReason: null } },
    ],
    eventsByClassification: {
      genuine_trade_leg: 10, ordinary_transfer: 2, distribution_airdrop: 1, router_intermediary: 3,
      bridge: 1, lp_staking: 4, dust_non_economic: 5, unknown: 6,
    },
    duplicateEventCount: 7,
    runtimeCommitSha: 'abc123',
  })

  assert.equal(audit.lpActionsDetected, 4)
  assert.equal(audit.lpActionsExcludedFromOfficialPnl, 4)
  // ordinary_transfer(2) + distribution_airdrop(1) + router_intermediary(3) + bridge(1) + lp_staking(4) = 11
  assert.equal(audit.uncertainEventsExcludedFromOfficialPnl, 11)
  assert.equal(audit.duplicateEventsRemovedBeforeCap, 7)
  assert.equal(audit.runtimeCommitSha, 'abc123')
  assert.equal(audit.selectedChainMode, 'normal')
})
