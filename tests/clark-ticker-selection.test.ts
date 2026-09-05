import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateTickerSearchId,
  buildTickerPickerOptions,
  resolveTickerSelection,
  parseTypedTickerOptionIndex,
  buildTickerSelectionAudit,
  tickerChainId,
  type ClarkTickerMatch,
} from '../lib/server/clarkTickerSelection'

function match(overrides: Partial<ClarkTickerMatch> = {}): ClarkTickerMatch {
  return {
    name: null, symbol: 'CASHCAT', chainSlug: 'base', tokenAddress: '0x1111111111111111111111111111111111111111',
    pairAddress: null, liquidityUsd: 1000, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, confidence: 90,
    ...overrides,
  }
}

const CASHCAT = [
  match({ symbol: 'CASHCAT', tokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chainSlug: 'base' }),
  match({ symbol: 'CASHCAT', tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', chainSlug: 'eth' }),
]
const BASEJUICE = [
  match({ symbol: 'BASEJUICE', tokenAddress: '0xccccccccccccccccccccccccccccccccccccccc0', chainSlug: 'base' }),
]

test('generateTickerSearchId returns unique ids across calls', () => {
  const ids = new Set(Array.from({ length: 20 }, () => generateTickerSearchId()))
  assert.equal(ids.size, 20)
})

test('option 1 scans matches[0] exactly — button payload carries the exact displayed option', () => {
  const searchId = generateTickerSearchId()
  const options = buildTickerPickerOptions(CASHCAT, searchId)
  assert.equal(options[0].label, 'Scan 1')
  assert.equal(options[0].tokenAddress, CASHCAT[0].tokenAddress)
  assert.equal(options[0].chainId, 8453)
  assert.equal(options[0].tickerSearchId, searchId)
  assert.equal(options[1].label, 'Scan 2')
  assert.equal(options[1].tokenAddress, CASHCAT[1].tokenAddress)
  assert.equal(options[1].chainId, 1)
})

test('/token cashcat then scan 1 scans CASHCAT option 1, not another token', () => {
  const searchId = generateTickerSearchId()
  const options = buildTickerPickerOptions(CASHCAT, searchId)
  const selection = { tickerSearchId: options[0].tickerSearchId, optionIndex: options[0].optionIndex, tokenAddress: options[0].tokenAddress, chainId: options[0].chainId }
  const resolution = resolveTickerSelection({ selection, currentSearchId: searchId, currentMatches: CASHCAT })
  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.selectedMatch?.tokenAddress, CASHCAT[0].tokenAddress)
  assert.equal(resolution.selectedMatch?.symbol, 'CASHCAT')
  // Never Base Juice — the exact reported bug.
  assert.notEqual(resolution.selectedMatch?.symbol, 'BASEJUICE')
})

test('clicking Scan 2 scans option 2 exactly', () => {
  const searchId = generateTickerSearchId()
  const options = buildTickerPickerOptions(CASHCAT, searchId)
  const selection = { tickerSearchId: options[1].tickerSearchId, optionIndex: options[1].optionIndex, tokenAddress: options[1].tokenAddress, chainId: options[1].chainId }
  const resolution = resolveTickerSelection({ selection, currentSearchId: searchId, currentMatches: CASHCAT })
  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.selectedMatch?.tokenAddress, CASHCAT[1].tokenAddress)
  assert.equal(resolution.selectedMatch?.chainSlug, 'eth')
})

test('old ticker options cannot be used after a newer /token search', () => {
  const oldSearchId = generateTickerSearchId()
  const oldOptions = buildTickerPickerOptions(CASHCAT, oldSearchId)
  // A newer /token search replaces both matches and searchId atomically.
  const newSearchId = generateTickerSearchId()
  const currentMatches = BASEJUICE
  // The stale button click still carries the OLD searchId.
  const staleSelection = { tickerSearchId: oldOptions[0].tickerSearchId, optionIndex: 0, tokenAddress: oldOptions[0].tokenAddress, chainId: oldOptions[0].chainId }
  const resolution = resolveTickerSelection({ selection: staleSelection, currentSearchId: newSearchId, currentMatches })
  assert.equal(resolution.status, 'stale_search')
  assert.equal(resolution.selectedMatch, null)
})

test('option button payload matches displayed token — a tampered/mismatched payload is rejected', () => {
  const searchId = generateTickerSearchId()
  // optionIndex 0 is CASHCAT on base, but the payload claims a different tokenAddress/chain.
  const tamperedSelection = { tickerSearchId: searchId, optionIndex: 0, tokenAddress: BASEJUICE[0].tokenAddress, chainId: 8453 }
  const resolution = resolveTickerSelection({ selection: tamperedSelection, currentSearchId: searchId, currentMatches: CASHCAT })
  assert.equal(resolution.status, 'mismatch')
})

test('an index outside the current match list is rejected, never silently clamped to another option', () => {
  const searchId = generateTickerSearchId()
  const resolution = resolveTickerSelection({ selection: { tickerSearchId: searchId, optionIndex: 5, tokenAddress: '0x0', chainId: 8453 }, currentSearchId: searchId, currentMatches: CASHCAT })
  assert.equal(resolution.status, 'invalid_index')
})

test('no active search in session never resolves a selection', () => {
  const resolution = resolveTickerSelection({ selection: { tickerSearchId: 'ticker_x', optionIndex: 0, tokenAddress: '0x0', chainId: 8453 }, currentSearchId: null, currentMatches: null })
  assert.equal(resolution.status, 'no_active_search')
})

test('parseTypedTickerOptionIndex handles "scan 1", "1", and rejects non-numeric replies', () => {
  assert.equal(parseTypedTickerOptionIndex('scan 1'), 0)
  assert.equal(parseTypedTickerOptionIndex('Scan 2'), 1)
  assert.equal(parseTypedTickerOptionIndex('3'), 2)
  assert.equal(parseTypedTickerOptionIndex('  scan   4 '), 3)
  assert.equal(parseTypedTickerOptionIndex('cashcat'), null)
  assert.equal(parseTypedTickerOptionIndex('scan cashcat'), null)
})

test('tickerChainId maps known chain slugs and is null for solana/unknown', () => {
  assert.equal(tickerChainId('base'), 8453)
  assert.equal(tickerChainId('eth'), 1)
  assert.equal(tickerChainId('ethereum'), 1)
  assert.equal(tickerChainId('bnb'), 56)
  assert.equal(tickerChainId('robinhood'), 4663)
  assert.equal(tickerChainId('solana'), null)
  assert.equal(tickerChainId('unknown-chain'), null)
  assert.equal(tickerChainId(null), null)
})

test('buildTickerSelectionAudit reports a resolved selection honestly, matching the displayed option', () => {
  const searchId = generateTickerSearchId()
  const options = buildTickerPickerOptions(CASHCAT, searchId)
  const selection = { tickerSearchId: options[0].tickerSearchId, optionIndex: 0, tokenAddress: options[0].tokenAddress, chainId: options[0].chainId }
  const resolution = resolveTickerSelection({ selection, currentSearchId: searchId, currentMatches: CASHCAT })
  const audit = buildTickerSelectionAudit({ rawUserReply: 'scan 1', tickerSearchId: searchId, selectedIndex: 0, resolution, previousActiveToken: BASEJUICE[0].tokenAddress })
  assert.equal(audit.finalStatus, 'scanned')
  assert.equal(audit.selectionMatchesDisplayedOption, true)
  assert.equal(audit.staleSearchIgnored, false)
  assert.equal(audit.scannerPayloadTokenAddress, CASHCAT[0].tokenAddress)
  assert.equal(audit.displayedSymbol, 'CASHCAT')
  // activeToken/previousActiveToken is recorded for the audit trail but never used to pick the option.
  assert.equal(audit.previousActiveToken, BASEJUICE[0].tokenAddress)
  assert.notEqual(audit.scannerPayloadTokenAddress, audit.previousActiveToken)
})

test('buildTickerSelectionAudit reports a stale search as ignored, not scanned', () => {
  const oldSearchId = generateTickerSearchId()
  const newSearchId = generateTickerSearchId()
  const resolution = resolveTickerSelection({ selection: { tickerSearchId: oldSearchId, optionIndex: 0, tokenAddress: CASHCAT[0].tokenAddress, chainId: 8453 }, currentSearchId: newSearchId, currentMatches: BASEJUICE })
  const audit = buildTickerSelectionAudit({ rawUserReply: 'scan 1', tickerSearchId: oldSearchId, selectedIndex: 0, resolution, previousActiveToken: null })
  assert.equal(audit.finalStatus, 'ignored_stale')
  assert.equal(audit.staleSearchIgnored, true)
  assert.equal(audit.scannerPayloadTokenAddress, null)
})

test('low-confidence multiple matches still require a choice — buildTickerPickerOptions never collapses to a single auto-pick', () => {
  const searchId = generateTickerSearchId()
  const lowConfidence = [match({ confidence: 40, tokenAddress: '0xdddddddddddddddddddddddddddddddddddddddd' }), match({ confidence: 35, tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })]
  const options = buildTickerPickerOptions(lowConfidence, searchId)
  assert.equal(options.length, 2)
  assert.notEqual(options[0].tokenAddress, options[1].tokenAddress)
})
