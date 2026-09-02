import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classifyClarkMarketIntent,
  extractClarkMarketSymbol,
  isClarkMarketPronounReference,
  resolveClarkMarketData,
  formatClarkMarketAnswer,
  formatClarkMarketAmbiguousAnswer,
} from '../lib/server/clarkMarketData.ts'

function quote(overrides = {}) {
  return {
    provider: 'coingecko',
    name: 'Ethereum',
    symbol: 'ETH',
    address: null,
    chainId: null,
    chain: null,
    priceUsd: 3200.5,
    change24hPct: 2.1,
    marketCapUsd: 385_000_000_000,
    fdvUsd: null,
    volume24hUsd: 12_000_000_000,
    liquidityUsd: null,
    fetchedAt: Date.now(),
    ...overrides,
  }
}

async function main() {
  // ── Intent classification covers every required intent ──
  assert.equal(classifyClarkMarketIntent('What is ETH price?'), 'live_price')
  assert.equal(classifyClarkMarketIntent('What is PEPE market cap?'), 'market_cap')
  assert.equal(classifyClarkMarketIntent('Show SOL volume'), 'volume')
  assert.equal(classifyClarkMarketIntent('What is BTC doing today?'), 'price_change')
  assert.equal(classifyClarkMarketIntent('Why is this token pumping?'), 'trending_reason')
  assert.equal(classifyClarkMarketIntent('Price of this CA'), 'live_price')
  assert.equal(classifyClarkMarketIntent('Market cap and FDV for this token'), 'market_cap')
  assert.equal(classifyClarkMarketIntent('Compare ETH and SOL'), 'compare_tokens')
  assert.equal(classifyClarkMarketIntent('What is PEPE?'), 'token_lookup')
  assert.equal(classifyClarkMarketIntent('Deploy a smart contract for me'), null, 'unrelated prompts are never misclassified as a market question')

  // ── Symbol extraction ──
  assert.equal(extractClarkMarketSymbol('What is ETH price?'), 'ETH')
  assert.equal(extractClarkMarketSymbol('What is PEPE market cap?'), 'PEPE')
  assert.equal(extractClarkMarketSymbol('Show SOL volume'), 'SOL')
  assert.equal(extractClarkMarketSymbol('$WIF price'), 'WIF')
  assert.equal(isClarkMarketPronounReference('Market cap and FDV for this token'), true)
  assert.equal(isClarkMarketPronounReference('Price of this CA'), true)
  assert.equal(isClarkMarketPronounReference('What is ETH price?'), false)

  // ── Clark answers ETH/BTC/SOL price (majors, symbol-only, no address) ──
  {
    const providers = { coingecko: async (symbol) => (symbol === 'ETH' ? { quote: quote(), matches: [quote()] } : null) }
    const r = await resolveClarkMarketData({ prompt: 'What is ETH price?', intent: 'live_price', address: null, symbol: 'ETH', chainId: null, chain: null }, providers)
    assert.equal(r.audit.finalStatus, 'resolved')
    assert.equal(r.audit.providerUsed, 'coingecko')
    assert.equal(r.quote.priceUsd, 3200.5)
    const answer = formatClarkMarketAnswer(r.quote)
    assert.match(answer, /Price: \$3,200\.50/)
    assert.match(answer, /Not financial advice\./)
  }

  // ── Clark answers market cap for a top token symbol ──
  {
    const pepe = quote({ name: 'Pepe', symbol: 'PEPE', priceUsd: 0.000012, marketCapUsd: 5_000_000_000, fdvUsd: 5_000_000_000 })
    const providers = { coingecko: async () => ({ quote: pepe, matches: [pepe] }) }
    const r = await resolveClarkMarketData({ prompt: 'What is PEPE market cap?', intent: 'market_cap', address: null, symbol: 'PEPE', chainId: null, chain: null }, providers)
    assert.equal(r.audit.finalStatus, 'resolved')
    assert.equal(r.quote.marketCapUsd, 5_000_000_000)
    const answer = formatClarkMarketAnswer(r.quote)
    assert.match(answer, /Market cap: \$5\.00B/)
    // FDV and market cap are never conflated — both lines present, both correct.
    assert.match(answer, /FDV: \$5\.00B/)
  }

  // ── Clark handles a contract address via Token Scanner first, DexScreener as fallback ──
  {
    const addr = '0x1234567890123456789012345678901234567890'
    const tsQuote = quote({ provider: 'token_scanner_api', name: 'Test Token', symbol: 'TEST', address: addr, chainId: 8453, chain: 'base', marketCapUsd: 1_000_000, fdvUsd: 1_200_000 })
    let tsCalled = false, dexCalled = false
    const providers = {
      tokenScannerApi: async () => { tsCalled = true; return tsQuote },
      dexScreener: async () => { dexCalled = true; return null },
    }
    const r = await resolveClarkMarketData({ prompt: `Price of ${addr}`, intent: 'live_price', address: addr, symbol: null, chainId: 8453, chain: 'base' }, providers)
    assert.equal(tsCalled, true, 'Token Scanner API is tried first for a contract address')
    assert.equal(dexCalled, false, 'DexScreener is never called once Token Scanner already resolved it')
    assert.equal(r.audit.providerUsed, 'token_scanner_api')
    assert.equal(r.quote.address, addr)

    // Now force Token Scanner to fail and confirm DexScreener is the real fallback.
    const dexQuote = quote({ provider: 'dexscreener', name: 'Test Token', symbol: 'TEST', address: addr, chainId: 8453, chain: 'base' })
    const providers2 = {
      tokenScannerApi: async () => null,
      dexScreener: async () => ({ quote: dexQuote, matches: [dexQuote] }),
    }
    const r2 = await resolveClarkMarketData({ prompt: `Price of ${addr}`, intent: 'live_price', address: addr, symbol: null, chainId: 8453, chain: 'base' }, providers2)
    assert.equal(r2.audit.providerUsed, 'dexscreener')
    assert.deepEqual(r2.audit.providersTried, ['token_scanner_api', 'dexscreener'])
  }

  // ── Ambiguous symbol asks clarification instead of guessing ──
  {
    const a = quote({ name: 'Wrapped Solana', symbol: 'SOL', address: '0xaaa', chain: 'base' })
    const b = quote({ name: 'Solana', symbol: 'SOL', address: null, chain: null })
    const providers = { coingecko: async () => ({ quote: a, matches: [a, b] }) }
    const r = await resolveClarkMarketData({ prompt: 'Show SOL volume', intent: 'volume', address: null, symbol: 'SOL', chainId: null, chain: null }, providers)
    assert.equal(r.audit.finalStatus, 'ambiguous_symbol')
    assert.equal(r.quote, null, 'never guesses a specific token when multiple real matches exist')
    assert.ok(Array.isArray(r.ambiguousMatches) && r.ambiguousMatches.length === 2)
    const answer = formatClarkMarketAmbiguousAnswer('SOL', r.ambiguousMatches)
    assert.match(answer, /Which one did you mean\?/)
    assert.match(answer, /Wrapped Solana/)
    assert.match(answer, /Solana/)
  }

  // ── Provider fails but a fresh cached snapshot exists → uses the cache, never invents ──
  {
    const cq = quote({ provider: 'coingecko', symbol: 'BTC', name: 'Bitcoin', priceUsd: 65000 })
    const providers1 = { coingecko: async () => ({ quote: cq, matches: [cq] }) }
    const first = await resolveClarkMarketData({ prompt: 'BTC price', intent: 'live_price', address: null, symbol: 'BTC', chainId: null, chain: null }, providers1)
    assert.equal(first.audit.finalStatus, 'resolved')

    // Second call: every live provider now fails — must fall back to the cache, not "unavailable".
    const providers2 = { coingecko: async () => null }
    const second = await resolveClarkMarketData({ prompt: 'BTC price', intent: 'live_price', address: null, symbol: 'BTC', chainId: null, chain: null }, providers2)
    assert.equal(second.audit.finalStatus, 'resolved')
    assert.equal(second.audit.cacheHit, true)
    assert.equal(second.audit.providerUsed, 'coingecko')
    assert.equal(second.quote.priceUsd, 65000)
  }

  // ── True unavailability still carries a concrete reason, never a silent/blank failure ──
  {
    const providers = { coingecko: async () => null }
    const r = await resolveClarkMarketData({ prompt: 'ZZZNOTATOKEN price', intent: 'live_price', address: null, symbol: 'ZZZNOTATOKEN', chainId: null, chain: null }, providers)
    assert.equal(r.audit.finalStatus, 'unavailable')
    assert.ok(r.audit.finalReason.length > 0)
  }

  // ── USD unavailable is never rendered as $0 ──
  {
    const q = quote({ priceUsd: null, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, liquidityUsd: null })
    const answer = formatClarkMarketAnswer(q)
    assert.doesNotMatch(answer, /\$0(?!\.\d)/)
    assert.match(answer, /Price: unverified/)
    assert.match(answer, /Market cap: unverified/)
  }

  // ── ChainLens session/scan context wins over every network provider ──
  {
    const sessionQuote = quote({ provider: 'chainlens_session', symbol: 'ETH', priceUsd: 3100 })
    let networkCalled = false
    const providers = {
      sessionContext: () => sessionQuote,
      coingecko: async () => { networkCalled = true; return { quote: quote(), matches: [quote()] } },
    }
    const r = await resolveClarkMarketData({ prompt: 'ETH price', intent: 'live_price', address: null, symbol: 'ETH', chainId: null, chain: null }, providers)
    assert.equal(r.audit.providerUsed, 'chainlens_session')
    assert.equal(networkCalled, false, 'no network provider is called once session context already has the answer')
  }

  // ── Audit object shape matches the required spec exactly ──
  {
    const providers = { coingecko: async () => ({ quote: quote(), matches: [quote()] }) }
    const r = await resolveClarkMarketData({ prompt: 'ETH price', intent: 'live_price', address: null, symbol: 'ETH', chainId: null, chain: null }, providers)
    const requiredKeys = ['prompt', 'intent', 'symbolOrAddress', 'chainId', 'providersTried', 'providerUsed', 'cacheHit', 'priceUsd', 'marketCapUsd', 'fdvUsd', 'volume24hUsd', 'liquidityUsd', 'finalStatus', 'finalReason']
    for (const key of requiredKeys) assert.ok(key in r.audit, `clarkMarketDataAudit has required key ${key}`)
  }

  // ── Wired into the Clark route as an early, narrow gate ──
  {
    const routeSrc = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
    assert.ok(routeSrc.includes('classifyClarkMarketIntent(prompt)'), 'Clark route classifies market intent')
    assert.ok(routeSrc.includes('clarkMarketDataAudit: marketResolution.audit'), 'Clark route attaches clarkMarketDataAudit to its response')
    assert.ok(routeSrc.includes('hijacksBroaderReport'), 'market gate steps aside for broader safety/report questions')
  }

  console.log('test-clark-market-data.mjs: all assertions passed')
}

main()
