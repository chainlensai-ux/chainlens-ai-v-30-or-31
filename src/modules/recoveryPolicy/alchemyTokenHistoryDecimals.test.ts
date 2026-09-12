// Tests for src/modules/recoveryPolicy/utils.ts's fetchAlchemyTokenHistory decimal/amount parsing.
//
// same-tx-Base-USDC-quote-normalization follow-up task — CONFIRMED ROOT CAUSE of two real,
// production-shaped Base USDC same-tx quote legs (tx 0x52f77bb4..., 0x609a9ceb...) deriving prices
// off by exactly 10^12: `fetchAlchemyTokenHistory` (this module's own PARALLEL, self-contained
// Alchemy adapter — see the module's own header on why it never imports providerFetchWindow/
// utils.ts) never read Alchemy's real `rawContract.decimal` field, hardcoding `tokenDecimals: null`
// — normalization/utils.ts's `parseAmount` then defaults every such event to 18 decimals, correct
// for WETH/native, silently wrong for a 6-decimal token like Base USDC
// (0x833589fcd6edb6e08f4c7c32d4f71b54bda02913). Traced: a raw atomic amount of 2996415704 divided
// by 10^18 (the bug) reproduces the exact reported `quoteQuantity` 2.996415704e-9 — never a double
// /1e6, a single mis-normalization at this exact source, using the WRONG decimals constant.
//
// Mocks global.fetch with a realistic alchemy_getAssetTransfers response shape (rawContract.value/
// decimal as hex strings, exactly as Alchemy's real API returns them) — same pattern already used
// by historicalPageCoalescing.test.ts. Run with:
//   npx tsx --test src/modules/recoveryPolicy/alchemyTokenHistoryDecimals.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAlchemyTokenHistory } from './utils'
import { parseAmount } from '../normalization/utils'

const originalFetch = global.fetch
const originalAlchemyBaseKey = process.env.ALCHEMY_BASE_KEY

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

beforeEach(() => {
  process.env.ALCHEMY_BASE_KEY = 'test-alchemy-base-key'
})

afterEach(() => {
  global.fetch = originalFetch
  process.env.ALCHEMY_BASE_KEY = originalAlchemyBaseKey
})

function mockAlchemyAssetTransfers(transfers: Array<{ hash: string; from: string; to: string; asset: string; rawContractAddress: string; rawContractValueHex: string; rawContractDecimalHex?: string; blockTimestamp: string }>) {
  global.fetch = (async () => new Response(JSON.stringify({
    result: {
      transfers: transfers.map((t) => ({
        hash: t.hash,
        from: t.from,
        to: t.to,
        asset: t.asset,
        metadata: { blockTimestamp: t.blockTimestamp },
        rawContract: { address: t.rawContractAddress, value: t.rawContractValueHex, decimal: t.rawContractDecimalHex },
      })),
    },
  }), { status: 200 })) as unknown as typeof fetch
}

describe('fetchAlchemyTokenHistory — decimals/amount parsing (confirmed root cause of the Base USDC same-tx quote corruption)', () => {
  it('HARD ASSERTION (confirmed root cause): reads the real rawContract.decimal field — a Base USDC transfer\'s tokenDecimals must be 6, never default to 18', async () => {
    // Real-shaped Alchemy response: raw hex value 0x2db3f7 = 2996471 (an arbitrary raw integer;
    // decimal hex "0x6" = 6 decimals — Base USDC's real decimals).
    mockAlchemyAssetTransfers([{
      hash: '0xabc', from: '0xwallet', to: '0xpool', asset: 'USDC',
      rawContractAddress: BASE_USDC, rawContractValueHex: '0x2db3f7', rawContractDecimalHex: '0x6',
      blockTimestamp: '2024-01-01T00:00:00Z',
    }])
    // fetchAlchemyTokenHistory issues two calls (fromAddress + toAddress) — the mock answers both
    // identically, so the same transfer is collected twice; only the per-event parsing is under test.
    const events = await fetchAlchemyTokenHistory('base', '0xwallet', BASE_USDC)
    assert.ok(events.length > 0)
    assert.equal(events[0].tokenDecimals, 6, 'tokenDecimals must be read from rawContract.decimal, never silently default to 18')
  })

  it('HARD ASSERTION (confirmed root cause, exact reproduction): a raw amount of 2996415704 at the WRONG (defaulted 18) decimals reproduces the exact corrupted quoteQuantity 2.996415704e-9 seen in production — proving this is the single mis-normalization source, never a double /1e6', () => {
    // This is the exact arithmetic proof, independent of any network mock: parseAmount (the SAME
    // function normalizeEvents calls) applied to the confirmed bug's own inputs (raw amount,
    // decimals defaulted to 18 because tokenDecimals was null) reproduces the reported number
    // bit-for-bit.
    const buggyAmount = parseAmount('2996415704', null)
    assert.equal(buggyAmount, 2996415704 / 1e18)
    assert.ok(Math.abs(buggyAmount! - 2.996415704e-9) < 1e-18, 'must reproduce the exact reported corrupted quoteQuantity')
    // The CORRECT normalization (decimals=6, Base USDC's real decimals) gives a plausible ~$2996 trade.
    const correctAmount = parseAmount('2996415704', 6)
    assert.equal(correctAmount, 2996.415704)
  })

  it('a transfer whose rawContract.decimal is missing falls back to null (never a fabricated guess), matching this module\'s own honest-null convention', async () => {
    mockAlchemyAssetTransfers([{
      hash: '0xabc', from: '0xwallet', to: '0xpool', asset: 'USDC',
      rawContractAddress: BASE_USDC, rawContractValueHex: '0x2db3f7',
      blockTimestamp: '2024-01-01T00:00:00Z',
    }])
    const events = await fetchAlchemyTokenHistory('base', '0xwallet', BASE_USDC)
    assert.equal(events[0].tokenDecimals, null)
  })

  it('amountRaw is normalized to a plain decimal string (matching GoldRush\'s own format), never left as Alchemy\'s raw hex — required for cross-provider dedup', async () => {
    mockAlchemyAssetTransfers([{
      hash: '0xabc', from: '0xwallet', to: '0xpool', asset: 'USDC',
      rawContractAddress: BASE_USDC, rawContractValueHex: '0x2db3f7', rawContractDecimalHex: '0x6',
      blockTimestamp: '2024-01-01T00:00:00Z',
    }])
    const events = await fetchAlchemyTokenHistory('base', '0xwallet', BASE_USDC)
    assert.equal(events[0].amountRaw, String(0x2db3f7))
  })
})
