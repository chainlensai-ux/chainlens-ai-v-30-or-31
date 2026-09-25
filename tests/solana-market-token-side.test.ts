// Solana Market Pulse token-side correctness. DexScreener reports priceUsd / fdv / marketCap /
// info (socials) for a pair's BASE token and counts txns buys/sells from the base token's side.
// When the scanned mint is the QUOTE token, those values belong to the paired token and must never
// be shown as the mint's own. Liquidity / volume / pair age are pool-level and stay valid either way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSolanaMarket, resolveSolanaPairSide } from '../lib/server/solana/marketAnalyzer.ts'
import { scanSolanaTokenBeta } from '../lib/server/solanaTokenScannerBeta.ts'

const MEME = 'MemeMint1111111111111111111111111111111111pump'
const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

type Pair = Record<string, unknown>
function pair(o: { addr: string; base: string; quote: string; priceUsd?: string; fdv?: number; marketCap?: number; liq: number; vol: number; buys?: number; sells?: number; twitter?: string }): Pair {
  return {
    chainId: 'solana', pairAddress: o.addr, dexId: 'raydium',
    baseToken: { address: o.base, name: o.base === MEME ? 'Meme' : o.base === SOL ? 'Wrapped SOL' : 'USD Coin', symbol: o.base === MEME ? 'MEME' : o.base === SOL ? 'SOL' : 'USDC' },
    quoteToken: { address: o.quote, name: o.quote === MEME ? 'Meme' : o.quote === SOL ? 'Wrapped SOL' : 'USD Coin', symbol: o.quote === MEME ? 'MEME' : o.quote === SOL ? 'SOL' : 'USDC' },
    priceUsd: o.priceUsd, fdv: o.fdv, marketCap: o.marketCap,
    liquidity: { usd: o.liq }, volume: { h24: o.vol },
    txns: { h24: { buys: o.buys ?? 10, sells: o.sells ?? 4 } },
    pairCreatedAt: Date.now() - 3 * 86_400_000,
    info: o.twitter ? { socials: [{ type: 'twitter', url: o.twitter }] } : undefined,
  }
}
function dex(pairs: Pair[]) {
  return (async () => ({ ok: true, json: async () => ({ pairs }) })) as unknown as Parameters<typeof analyzeSolanaMarket>[1]
}

test('resolveSolanaPairSide: exact, case-sensitive mint identity', () => {
  const p = pair({ addr: 'P', base: MEME, quote: SOL, liq: 1, vol: 1 })
  assert.equal(resolveSolanaPairSide(p, MEME), 'base')
  assert.equal(resolveSolanaPairSide(p, SOL), 'quote')
  assert.equal(resolveSolanaPairSide(p, MEME.toLowerCase()), null, 'a case-folded mint is a different base58 address')
  assert.equal(resolveSolanaPairSide({ chainId: 'solana' }, MEME), null, 'pair without sides proves nothing')
})

test('mint = base of selected pool: existing price/FDV/market cap/socials/txns preserved', async () => {
  const m = await analyzeSolanaMarket(MEME, dex([pair({ addr: 'P1', base: MEME, quote: SOL, priceUsd: '0.0005016', fdv: 501_600, marketCap: 480_000, liq: 90_000, vol: 40_000, buys: 120, sells: 80, twitter: 'https://x.com/meme' })]))
  const d = m.data!
  assert.equal(d.priceUsd, 0.0005016)
  assert.equal(d.fdvUsd, 501_600)
  assert.equal(d.marketCapUsd, 480_000)
  assert.equal(d.socials.twitter, 'https://x.com/meme')
  assert.deepEqual(d.txns24h, { buys: 120, sells: 80 })
  assert.equal(d.primaryPoolTokenSide, 'base')
  assert.deepEqual(d.priceEvidence, { status: 'selected_pool_base_side', pairAddress: 'P1', reason: null })
})

test('mint = quote with no base-side pool: pair price/FDV/MC/socials are NOT exposed, pool metrics kept', async () => {
  // SOL/MEME pool, MEME is quote: priceUsd/fdv/marketCap/info are SOL's.
  const m = await analyzeSolanaMarket(MEME, dex([pair({ addr: 'P1', base: SOL, quote: MEME, priceUsd: '171.23', fdv: 90_000_000_000, marketCap: 80_000_000_000, liq: 90_000, vol: 40_000, buys: 120, sells: 80, twitter: 'https://x.com/solana' })]))
  const d = m.data!
  assert.equal(d.priceUsd, null, 'SOL price must never become the MEME price')
  assert.equal(d.fdvUsd, null)
  assert.equal(d.marketCapUsd, null)
  assert.equal(d.socials.twitter, null, "the paired token's socials are not the mint's")
  assert.equal(d.priceEvidence?.status, 'unavailable_quote_side')
  assert.match(d.priceEvidence?.reason ?? '', /quote token/)
  // Pool-level metrics are side-independent.
  assert.equal(d.liquidityUsd, 90_000)
  assert.equal(d.volume24hUsd, 40_000)
  assert.equal(d.pairAgeDays, 3)
  // A pair "buy" (quote -> base) is a SELL of the quote-side mint.
  assert.deepEqual(d.txns24h, { buys: 80, sells: 120 })
  // Identity still comes from the correct (quote) side.
  assert.equal(d.tokenSymbol, 'MEME')
  // Chart keeps pricing the mint itself.
  assert.equal(d.primaryPoolTokenSide, 'quote')
})

test('mint = quote of deepest pool but base of another pool: that pool supplies the mint price', async () => {
  const m = await analyzeSolanaMarket(MEME, dex([
    pair({ addr: 'DEEP', base: SOL, quote: MEME, priceUsd: '171.23', fdv: 9e10, marketCap: 8e10, liq: 200_000, vol: 50_000 }),
    pair({ addr: 'ALT', base: MEME, quote: USDC, priceUsd: '0.00051', fdv: 510_000, marketCap: 470_000, liq: 20_000, vol: 5_000, twitter: 'https://x.com/meme' }),
  ]))
  const d = m.data!
  assert.equal(d.priceUsd, 0.00051)
  assert.equal(d.fdvUsd, 510_000)
  assert.equal(d.marketCapUsd, 470_000)
  assert.equal(d.socials.twitter, 'https://x.com/meme')
  assert.deepEqual(d.priceEvidence, { status: 'alternate_pool_base_side', pairAddress: 'ALT', reason: null })
  // Selected pool (and chart/pool-level fields) is still the deepest one.
  assert.equal(d.primaryPoolAddress, 'DEEP')
  assert.equal(d.primaryPoolTokenSide, 'quote')
  assert.equal(d.liquidityUsd, 220_000)
})

test('side unknown (pair omits sides / neither side matches): nothing is attributed, never fabricated', async () => {
  const m = await analyzeSolanaMarket(MEME, dex([{ chainId: 'solana', pairAddress: 'P', dexId: 'x', priceUsd: '1', fdv: 5, marketCap: 5, liquidity: { usd: 1000 }, volume: { h24: 1 }, txns: { h24: { buys: 3, sells: 1 } } }]))
  const d = m.data!
  assert.equal(d.priceUsd, null)
  assert.equal(d.fdvUsd, null)
  assert.equal(d.marketCapUsd, null)
  assert.deepEqual(d.txns24h, { buys: null, sells: null })
  assert.equal(d.priceEvidence?.status, 'unavailable_side_unknown')
  assert.equal(d.primaryPoolTokenSide, null)
  assert.equal(d.liquidityUsd, 1000)
})

test('case-folded match no longer counts: a lowercase lookalike mint is not the scanned mint', async () => {
  const m = await analyzeSolanaMarket(MEME, dex([pair({ addr: 'P', base: MEME.toLowerCase(), quote: SOL, priceUsd: '9', liq: 1, vol: 1 })]))
  assert.equal(m.data!.priceUsd, null)
  assert.equal(m.data!.tokenName, null)
})

test('base-side pool that returns no price stays unavailable (not_returned), never 0 or NaN', async () => {
  const m = await analyzeSolanaMarket(MEME, dex([pair({ addr: 'P', base: MEME, quote: SOL, priceUsd: 'abc', liq: 1, vol: 1 })]))
  assert.equal(m.data!.priceUsd, null)
  assert.equal(m.data!.priceEvidence?.status, 'not_returned')
})

// ── End to end through the scan pipeline (API payload the Market Pulse UI reads) ──────────────
const HEALTHY_MINT = { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6, mintAuthority: null, freezeAuthority: null } } } } }
const HEALTHY_SUPPLY = { value: { amount: '1000000', decimals: 6, uiAmount: 1000000 } }
const HEALTHY_LARGEST = { value: [{ amount: '400000' }, { amount: '100000' }, { amount: '50000' }] }

function scanStub(pairs: Pair[], urls: string[]) {
  return (async (url: string, init?: { body?: string }) => {
    urls.push(String(url))
    if (String(url).includes('dexscreener')) return { ok: true, json: async () => ({ pairs }) }
    if (String(url).includes('geckoterminal')) return { ok: false, status: 404, json: async () => ({}) }
    const body = JSON.parse(init?.body ?? '{}') as { method?: string }
    const results: Record<string, unknown> = { getAccountInfo: HEALTHY_MINT, getTokenSupply: HEALTHY_SUPPLY, getTokenLargestAccounts: HEALTHY_LARGEST }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[body.method ?? ''] ?? null }) }
  }) as unknown as NonNullable<Parameters<typeof scanSolanaTokenBeta>[1]>['fetchImpl']
}

test('scan payload: quote-side mint never carries the pair price; chart still requests token=quote', async () => {
  process.env.ENABLE_SOLANA_BETA = 'true'
  const urls: string[] = []
  const r = await scanSolanaTokenBeta(MEME, { rpcUrl: 'https://stub', fetchImpl: scanStub([pair({ addr: 'POOLQ', base: SOL, quote: MEME, priceUsd: '171.23', fdv: 9e10, marketCap: 8e10, liq: 90_000, vol: 40_000 })], urls) })
  assert.ok(!('status' in r && (r as { status?: string }).status === 'error'))
  const s = r as Awaited<ReturnType<typeof scanSolanaTokenBeta>> & { marketData: { priceUsd: number | null; marketCapUsd: number | null; fdvUsd: number | null; liquidityUsd: number | null }; solanaProviderWiringAudit: { mergedResult: { price: number | null; marketCap: number | null }; providerCalls: { dexScreener: { resolved: { price: number | null; marketCap: number | null } } } }; solanaEvidenceGaps: string[] }
  assert.equal(s.marketData.priceUsd, null)
  assert.equal(s.marketData.marketCapUsd, null)
  assert.equal(s.marketData.fdvUsd, null)
  assert.equal(s.marketData.liquidityUsd, 90_000)
  const audit = s.solanaProviderWiringAudit
  assert.notEqual(audit.mergedResult.price, 171.23, 'wrong-side price must not leak into the merged payload')
  assert.equal(audit.mergedResult.marketCap, null)
  assert.equal(audit.providerCalls.dexScreener.resolved.price, null)
  assert.ok(s.solanaEvidenceGaps.some((g) => /quote token/.test(g)))
  const gt = urls.filter((u) => u.includes('geckoterminal'))
  assert.equal(gt.length, 1, 'still exactly one candle request')
  assert.match(gt[0], /\/pools\/POOLQ\/ohlcv\/minute\?aggregate=15&limit=672&currency=usd&token=quote/)
  assert.equal(urls.filter((u) => u.includes('dexscreener')).length, 1, 'no extra market call')
})
