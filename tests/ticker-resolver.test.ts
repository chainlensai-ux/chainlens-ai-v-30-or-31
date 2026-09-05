import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeTickerResolution, rankTickerMatches, TICKER_CHAIN_IDS, type TickerChainSlug, type TickerMatch } from '../lib/tickerResolverCore'

function match(symbol: string, chainSlug: TickerChainSlug, addressSeed: string, liquidityUsd: number, source: TickerMatch['source'] = 'dexscreener'): TickerMatch {
  return {
    name: symbol, symbol, chainId: TICKER_CHAIN_IDS[chainSlug], chainSlug,
    tokenAddress: chainSlug === 'solana' ? addressSeed.padEnd(32, '1') : `0x${addressSeed.padEnd(40, '0')}`,
    pairAddress: null, dex: 'test', priceUsd: 1, marketCapUsd: liquidityUsd * 10,
    fdvUsd: null, liquidityUsd, volume24hUsd: liquidityUsd / 2, priceChange24hPct: 2,
    confidence: 0, reason: 'test', source, matchType: 'exact_symbol',
  }
}

test('selected chain outranks and filters cross-chain ticker duplicates', () => {
  const rows = rankTickerMatches('BRETT', [match('BRETT', 'eth', '1', 5_000_000), match('BRETT', 'base', '2', 100_000)], 'base')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chainSlug, 'base')
})

test('multiple exact ticker identities require user choice', () => {
  const result = finalizeTickerResolution({
    query: 'PEPE', selectedChain: null,
    matches: [match('PEPE', 'eth', '1', 2_000_000), match('PEPE', 'base', '2', 1_500_000)],
    providersTried: ['dexscreener'],
  })
  assert.equal(result.needsUserChoice, true)
  assert.equal(result.selectedMatch, null)
  assert.equal(result.tickerResolverAudit.finalAction, 'show_picker')
  assert.equal(result.tickerResolverAudit.selectedMatch, null)
  assert.ok(result.tickerResolverAudit.topMatch)
})

test('one strong selected-chain match auto scans', () => {
  const result = finalizeTickerResolution({ query: 'BRETT', selectedChain: 'base', matches: [match('BRETT', 'base', '2', 2_000_000)], providersTried: ['chainlens_cache', 'dexscreener'] })
  assert.equal(result.needsUserChoice, false)
  assert.equal(result.selectedMatch?.chainSlug, 'base')
  assert.equal(result.contractAddress, result.selectedMatch?.tokenAddress)
})

test('low-confidence partial result never auto scans', () => {
  const row = match('PEPEX', 'base', '3', 10)
  row.name = 'Pepe Experimental'
  const result = finalizeTickerResolution({ query: 'PEP', selectedChain: 'base', matches: [row], providersTried: ['dexscreener'] })
  assert.equal(result.needsUserChoice, true)
  assert.equal(result.selectedMatch, null)
})

test('direct address preserves exact chain and identity', () => {
  const row = match('TOKEN', 'bnb', 'abc', 0, 'chain_fallback')
  const result = finalizeTickerResolution({ query: row.tokenAddress, selectedChain: 'bnb', matches: [row], providersTried: [], directAddressChain: 'bnb' })
  assert.equal(result.selectedMatch?.tokenAddress, row.tokenAddress)
  assert.equal(result.selectedMatch?.chainSlug, 'bnb')
  assert.equal(result.tickerResolverAudit.finalAction, 'direct_scan')
})

test('known wrapped ETH identities rank ahead of unrelated ETH tickers', () => {
  const knownWeth = match('WETH', 'base', '420', 0, 'chainlens_cache')
  knownWeth.name = 'Wrapped Ether'
  const junk = match('ETH', 'solana', 'SoEth', 100_000)
  const rows = rankTickerMatches('ETH', [junk, knownWeth], null)
  assert.equal(rows[0].symbol, 'WETH')
  assert.equal(rows[0].chainSlug, 'base')
})
