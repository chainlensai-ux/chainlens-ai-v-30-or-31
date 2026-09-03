// Clark canonical-asset market intent — ETH/BTC price must never become a Solana token search.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkMarketIntent,
  isCanonicalMajorAsset,
  shouldShowCanonicalAmbiguity,
  matchCanonicalAsset,
  formatClarkLiveMarketAnswer,
  formatClarkLiveMarketUnavailable,
  formatClarkPumpingAnswer,
  formatClarkPumpingNeedToken,
  pumpingSnapshotFromTokenEvidence,
  pumpingAnswerHasNaSpam,
  fetchClarkCanonicalMarket,
  buildClarkIntentAudit,
} from '../lib/server/clarkMarketIntent.ts'
import { classifyClarkPrompt } from '../lib/server/clarkRouting.ts'
import { classifyClarkBasicIntent, buildClarkDirectAnswer } from '../lib/server/clarkBasicIntent.ts'

const ADDR = '0x' + 'a'.repeat(40)
let passed = 0
function check(label, cond) {
  assert.ok(cond, label)
  passed++
}

// ── 1. ETH/BTC/SOL price routes to live_price, never token_scan ───────────
{
  for (const q of ['what is eth price', 'what is ETH price?', "what's eth price", 'eth price', 'price of eth']) {
    const m = classifyClarkMarketIntent(q)
    check(`"${q}" → live_price`, m.detectedIntent === 'live_price')
    check(`"${q}" matches ETH`, m.canonicalAssetMatched === 'ETH')
    check(`"${q}" classifyClarkPrompt live_market`, classifyClarkPrompt(q).intent === 'live_market')
    check(`"${q}" is not token_scan`, classifyClarkPrompt(q).intent !== 'token_scan')
    check(`"${q}" basic intent does not swallow as chat`, classifyClarkBasicIntent(q) === 'unsupported_request')
    check(`"${q}" no generic direct answer`, buildClarkDirectAnswer(classifyClarkBasicIntent(q), q) == null)
  }
}

{
  const m = classifyClarkMarketIntent('what is btc price')
  check('btc price → live_price', m.detectedIntent === 'live_price')
  check('btc price matches BTC', m.canonicalAssetMatched === 'BTC')
  check('btc price classifyClarkPrompt live_market', classifyClarkPrompt('what is btc price').intent === 'live_market')
}

{
  const m = classifyClarkMarketIntent('like just normal eth')
  check('normal eth → live_price', m.detectedIntent === 'live_price')
  check('normal eth is Ethereum', m.canonicalAssetMatched === 'ETH')
  check('normal eth not token_scan', classifyClarkPrompt('like just normal eth').intent === 'live_market')
}

{
  const m = classifyClarkMarketIntent('market cap of sol')
  check('market cap of sol → market_cap', m.detectedIntent === 'market_cap')
  check('sol matches SOL', m.canonicalAssetMatched === 'SOL')
  check('classifyClarkPrompt live_market', classifyClarkPrompt('market cap of sol').intent === 'live_market')
}

{
  check('volume of bnb is volume', classifyClarkMarketIntent('volume of bnb').detectedIntent === 'volume')
  check('doge price is live_price', classifyClarkMarketIntent('doge price').detectedIntent === 'live_price')
  check('xrp price is live_price', classifyClarkMarketIntent('xrp price').detectedIntent === 'live_price')
  check('pepe price is live_price', classifyClarkMarketIntent('pepe price').detectedIntent === 'live_price')
}

// ── 2. Scan / slash commands still route to scanners ──────────────────────
{
  const scan = `scan ${ADDR}`
  check('scan 0x → token_scan (market intent)', classifyClarkMarketIntent(scan).detectedIntent === 'token_scan')
  check('scan 0x classifyClarkPrompt token_scan', classifyClarkPrompt(scan).intent === 'token_scan')
  check('/token 0x is token_scan', classifyClarkPrompt(`/token ${ADDR}`).intent === 'token_scan')
  check('/lp 0x is liquidity_scan', classifyClarkPrompt(`/lp ${ADDR}`).intent === 'liquidity_scan')
  check('/wallet 0x is wallet_scan', classifyClarkPrompt(`/wallet 0x${'b'.repeat(40)}`).intent === 'wallet_scan')
}

// ── 3. "why is this pumping?" uses active token or asks for one ───────────
{
  const m = classifyClarkMarketIntent('why is this pumping?')
  check('why is this pumping → pumping', m.detectedIntent === 'pumping')
  check('no address on this-pumping', m.address == null)
}

{
  const m = classifyClarkMarketIntent(`why is this pumping? ${ADDR}`)
  check('why is [contract] pumping keeps address', m.detectedIntent === 'pumping' && m.address === ADDR)
}

{
  const m = classifyClarkMarketIntent('why is this pumping?', { hasActiveToken: true })
  check('active context flagged', m.audit.activeContextUsed === true)
  check('provider route active_token_context', m.audit.providerRoute === 'active_token_context')
}

{
  const ask = formatClarkPumpingNeedToken()
  check('no-token pumping asks for contract/ticker', /Which token\? Send the contract address or ticker\./.test(ask))
  check('no-token ask has no n/a spam', pumpingAnswerHasNaSpam(ask) === false)
}

{
  const snap = pumpingSnapshotFromTokenEvidence({
    symbol: 'PEPE',
    address: ADDR,
    market: { price: 0.000012, change24h: 42.2, volume24h: 12_400_000, liquidity: 2_100_000, marketCap: 80_000_000 },
    holders: { top10: 44, holderCount: 1204 },
    buys24h: 812,
    sells24h: 401,
    source: 'active token context (Token Scanner state)',
  })
  const text = formatClarkPumpingAnswer(snap)
  check('pumping answer names token', /PEPE is up 42\.2% in 24h/.test(text))
  check('pumping answer has volume', /Volume 24h:/.test(text))
  check('pumping answer has liquidity', /Liquidity:/.test(text))
  check('pumping answer has buys/sells', /812 \/ 401/.test(text))
  check('pumping answer has holders', /Top-10 holders: 44\.0%/.test(text))
  check('no Momentum Score n/a', pumpingAnswerHasNaSpam(text) === false)
  check('no Holders n/a', !/Holders n\/a/i.test(text))
  check('missing whale/FOMO listed honestly', /Missing:.*whale\/FOMO/.test(text))
}

{
  const empty = pumpingSnapshotFromTokenEvidence({ symbol: 'X', market: {} })
  const text = formatClarkPumpingAnswer(empty)
  check('empty pumping still no n/a/100', pumpingAnswerHasNaSpam(text) === false)
  check('empty pumping lists missing', /Missing:/.test(text))
}

// ── 4. Unknown / non-canonical symbols stay out of live_market ────────────
{
  check('unknown ticker is not live_market', classifyClarkPrompt('what is blarp price').intent !== 'live_market')
  check('pepe coin (no price word) stays token_scan', classifyClarkPrompt('pepe coin').intent === 'token_scan')
  check('what is fdv is not live_market', classifyClarkPrompt('what is fdv').intent !== 'live_market')
  check('what is ethereum (no price) is not live_market', classifyClarkPrompt('what is ethereum').intent !== 'live_market')
}

// ── 5. Canonical assets never show random multi-match lists ───────────────
{
  for (const t of ['ETH', 'BTC', 'SOL', 'BNB', 'XRP', 'DOGE', 'PEPE']) {
    check(`${t} is canonical`, isCanonicalMajorAsset(t) === true)
    check(`${t} suppresses random matches`, shouldShowCanonicalAmbiguity(t, `${t} price`) === false)
  }
  check('AERO is not canonical', isCanonicalMajorAsset('AERO') === false)
  check('AERO may show matches', shouldShowCanonicalAmbiguity('AERO', 'scan AERO') === true)
  check('ETH on solana may show matches', shouldShowCanonicalAmbiguity('ETH', 'ETH on solana') === true)
  check('ETH pair search may show matches', shouldShowCanonicalAmbiguity('ETH', 'ETH pair search') === true)
}

// ── 6. Live market formatter is short and does not invent prices ──────────
{
  const snap = {
    ticker: 'ETH',
    name: 'Ethereum',
    priceUsd: 3412.1,
    change24h: 2.4,
    marketCapUsd: 410_200_000_000,
    volume24hUsd: 18_400_000_000,
    lastUpdatedIso: new Date(Date.now() - 12_000).toISOString(),
    source: 'coingecko',
  }
  const text = formatClarkLiveMarketAnswer(snap, 'live_price')
  check('price line', /ETH is \$3,412\.10, up 2\.4% in 24h/.test(text))
  check('market cap line', /Market cap: \$410\.20B/.test(text))
  check('volume line', /24h volume: \$18\.40B/.test(text))
  check('source line', /Source: live market data, updated \d+s ago/.test(text))
  check('not a long essay', text.split('\n').length <= 6)
  check('no Solana token list', !/multiple|solana token|matches/i.test(text))
}

{
  const sol = formatClarkLiveMarketAnswer({
    ticker: 'SOL', name: 'Solana', priceUsd: 142, change24h: -1.2,
    marketCapUsd: 68_000_000_000, volume24hUsd: 3_200_000_000,
    lastUpdatedIso: new Date().toISOString(), source: 'coingecko',
  }, 'market_cap')
  check('sol market cap lead', /SOL market cap is \$68\.00B/.test(sol))
}

{
  const miss = formatClarkLiveMarketUnavailable(matchCanonicalAsset('ETH'), 'CoinGecko HTTP 429')
  check('unavailable does not invent $', !/\$\d/.test(miss))
  check('unavailable names reason', /CoinGecko HTTP 429/.test(miss))
  check('unavailable refuses to guess', /will not guess/i.test(miss))
}

{
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [{ current_price: 2500, price_change_percentage_24h: 1.5, market_cap: 300e9, total_volume: 10e9, last_updated: new Date().toISOString() }],
  })
  const got = await fetchClarkCanonicalMarket(matchCanonicalAsset('ETH'), fakeFetch)
  check('coingecko fetch ok', got.ok === true)
  check('coingecko price used', got.ok && got.snapshot.priceUsd === 2500)
  check('source is coingecko', got.ok && got.snapshot.source === 'coingecko')
}

{
  const failFetch = async () => ({ ok: false, status: 500, json: async () => null })
  const got = await fetchClarkCanonicalMarket(matchCanonicalAsset('BTC'), failFetch)
  check('failed provider does not invent', got.ok === false)
}

// ── 7. Audit shape ────────────────────────────────────────────────────────
{
  const audit = buildClarkIntentAudit({
    prompt: 'what is eth price',
    detectedIntent: 'live_price',
    canonicalAssetMatched: 'ETH',
    providerRoute: 'coingecko',
    providerUsed: 'coingecko',
    finalAnswerType: 'live_price',
  })
  for (const k of ['prompt', 'normalizedPrompt', 'detectedIntent', 'canonicalAssetMatched', 'activeContextUsed', 'addressDetected', 'chainHint', 'providerRoute', 'providerUsed', 'ambiguityReason', 'finalAnswerType', 'failureReason']) {
    check(`audit has ${k}`, Object.prototype.hasOwnProperty.call(audit, k))
  }
}

// ── 8. route.ts actually intercepts before token_resolve / basic chat ─────
{
  const src = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
  check('route imports classifyClarkMarketIntent', /classifyClarkMarketIntent/.test(src))
  check('route calls answerClarkMarketOrPumping', /await answerClarkMarketOrPumping/.test(src))
  check('route formats live market answers', /formatClarkLiveMarketAnswer/.test(src))
  check('route asks for token on pumping with no context', /formatClarkPumpingNeedToken/.test(src))
  check('canonical multi-match is suppressed', /shouldShowCanonicalAmbiguity/.test(src))
  const callAt = src.indexOf('await answerClarkMarketOrPumping')
  const entityGateAt = src.indexOf('TOKEN-VS-WALLET MISROUTING FIX, DISCLOSED (reported live: token-specific questions')
  check('market intercept runs before the entity-gate RPC', callAt > -1 && entityGateAt > callAt)
  check('origin live-market gate still present', /classifyClarkMarketIntent\(prompt\)/.test(src))
}

{
  const { resolveClarkMarketData } = await import('../lib/server/clarkMarketData.ts')
  let dexCalled = false
  let cgCalled = false
  const ethQuote = {
    provider: 'coingecko', name: 'Ethereum', symbol: 'ETH', address: null, chainId: null, chain: null,
    priceUsd: 3200, change24hPct: 1, marketCapUsd: 1, fdvUsd: null, volume24hUsd: 1, liquidityUsd: null, fetchedAt: Date.now(),
  }
  const r = await resolveClarkMarketData(
    { prompt: 'what is eth price', intent: 'live_price', address: null, symbol: 'ETH', chainId: null, chain: null },
    {
      dexScreener: async () => { dexCalled = true; return { quote: { ...ethQuote, provider: 'dexscreener', name: 'Random Solana ETH' }, matches: [{ ...ethQuote, name: 'Random Solana ETH' }, ethQuote] } },
      coingecko: async () => { cgCalled = true; return { quote: ethQuote, matches: [ethQuote] } },
    },
  )
  check('canonical ETH does not search DexScreener', dexCalled === false)
  check('canonical ETH uses CoinGecko', cgCalled === true && r.audit.providerUsed === 'coingecko')
  check('canonical ETH is not an ambiguous Solana list', r.audit.finalStatus === 'resolved')
}

console.log(`test-clark-market-intent.mjs: all ${passed} assertions passed`)
