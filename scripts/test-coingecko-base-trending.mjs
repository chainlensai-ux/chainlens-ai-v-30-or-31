// TESTS — lib/server/coingeckoBaseTrending.ts (Clark "what's pumping" real-data-source follow-up).
// Every RPC/HTTP call is served by an injected fetch stub — no network access, no API key.

import assert from 'node:assert/strict'
import { fetchCoinGeckoBaseTrending } from '../lib/server/coingeckoBaseTrending.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

// ─── Successful response maps real fields, never fabricates a contract address ─────────────────
{
  const stub = async () => ({
    ok: true,
    json: async () => ([
      { symbol: 'brett', name: 'Brett', current_price: 0.05, price_change_percentage_24h: 12.3, total_volume: 5_000_000, market_cap: 400_000_000 },
      { symbol: 'aero', name: 'Aerodrome', current_price: 1.2, price_change_percentage_24h: -3.1, total_volume: 2_000_000, market_cap: 300_000_000 },
    ]),
  })
  const r = await fetchCoinGeckoBaseTrending(stub)
  check('successful response resolves ok:true', r.ok === true)
  check('symbol is uppercased', r.rows[0].symbol === 'BRETT')
  check('real price/change/volume/marketCap map correctly', r.rows[0].priceUsd === 0.05 && r.rows[0].change24h === 12.3 && r.rows[0].volume24hUsd === 5_000_000 && r.rows[0].marketCapUsd === 400_000_000)
  check('contract is never fabricated — CoinGecko markets endpoint has no per-chain address', r.rows[0].contract === null)
  check('second row maps independently', r.rows[1].symbol === 'AERO' && r.rows[1].change24h === -3.1)
}

// ─── HTTP failure degrades cleanly, never throws ────────────────────────────────────────────────
{
  const stub = async () => ({ ok: false, status: 429 })
  const r = await fetchCoinGeckoBaseTrending(stub)
  check('HTTP failure resolves ok:false with a clean reason', r.ok === false && r.reason === 'coingecko_http_429')
}

// ─── Empty category (real response, zero rows) degrades cleanly — never a crash ────────────────
{
  const stub = async () => ({ ok: true, json: async () => ([]) })
  const r = await fetchCoinGeckoBaseTrending(stub)
  check('empty category resolves ok:false, not an empty success', r.ok === false && r.reason === 'coingecko_empty_category')
}

// ─── Unexpected shape (not an array) degrades cleanly ───────────────────────────────────────────
{
  const stub = async () => ({ ok: true, json: async () => ({ error: 'not found' }) })
  const r = await fetchCoinGeckoBaseTrending(stub)
  check('unexpected shape resolves ok:false, never a crash', r.ok === false && r.reason === 'coingecko_unexpected_shape')
}

// ─── Network exception degrades cleanly ─────────────────────────────────────────────────────────
{
  const stub = async () => { throw new Error('network down') }
  const r = await fetchCoinGeckoBaseTrending(stub)
  check('network exception resolves ok:false, never throws to the caller', r.ok === false && r.reason === 'coingecko_unreachable')
}

// ─── A row with neither symbol nor name is dropped, never guessed ──────────────────────────────
{
  const stub = async () => ({ ok: true, json: async () => ([{ current_price: 1 }, { symbol: 'ok', name: 'OK', current_price: 1 }]) })
  const r = await fetchCoinGeckoBaseTrending(stub)
  check('a row with no symbol/name is dropped rather than guessed', r.ok === true && r.rows.length === 1 && r.rows[0].symbol === 'OK')
}

console.log(`test-coingecko-base-trending.mjs: all ${passed} assertions passed`)
