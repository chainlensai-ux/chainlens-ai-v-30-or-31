// Tests for canonical token decimals + once-only parseAmount.
//
// Run with:
//   npx tsx --test src/modules/normalization/canonicalDecimals.test.ts src/modules/normalization/index.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASE_USDC_ADDRESS,
  EIGHTEEN_VS_SIX_SCALE,
  canonicalTokenDecimals,
  hexAmountToIntegerString,
  resolveTokenDecimals,
} from './canonicalDecimals'
import { parseAmount } from './utils'
import { normalizeEvents } from './index'
import type { RawProviderEvent } from '../providerFetchWindow/types'

const WALLET = '0x111111111111111111111111111111111111111a'
const OTHER = '0x333333333333333333333333333333333333333c'
const AEON = '0x444444444444444444444444444444444444444d'

function rawUsdc(overrides: Partial<RawProviderEvent> = {}): RawProviderEvent {
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: '0xquote1',
    timestamp: '2024-01-01T00:00:00.000Z',
    fromAddress: OTHER,
    toAddress: WALLET,
    contract: BASE_USDC_ADDRESS,
    symbol: 'USDC',
    amountRaw: '2996415',
    tokenDecimals: 18,
    ...overrides,
  }
}

describe('canonical decimals — Base USDC invariant', () => {
  it('Base USDC 0x833589…2913 is decimals=6 even when the provider reports 18 or null', () => {
    assert.equal(canonicalTokenDecimals('base', BASE_USDC_ADDRESS), 6)
    assert.equal(resolveTokenDecimals({ chain: 'base', token: BASE_USDC_ADDRESS, providerDecimals: 18 }).decimals, 6)
    assert.equal(resolveTokenDecimals({ chain: 'base', token: BASE_USDC_ADDRESS, providerDecimals: 18 }).source, 'canonical')
    assert.equal(resolveTokenDecimals({ chain: 'base', token: BASE_USDC_ADDRESS, providerDecimals: 18 }).providerDisagreedWithCanonical, true)
    assert.equal(resolveTokenDecimals({ chain: 'base', token: BASE_USDC_ADDRESS, providerDecimals: null }).decimals, 6)
    assert.equal(resolveTokenDecimals({ chain: 'base', token: BASE_USDC_ADDRESS, providerDecimals: null }).source, 'canonical')
  })

  it('unknown tokens still use provider decimals, then fallback 18', () => {
    assert.equal(resolveTokenDecimals({ chain: 'base', token: AEON, providerDecimals: 18 }).decimals, 18)
    assert.equal(resolveTokenDecimals({ chain: 'base', token: AEON, providerDecimals: 18 }).source, 'provider')
    assert.equal(resolveTokenDecimals({ chain: 'base', token: AEON, providerDecimals: null }).decimals, 18)
    assert.equal(resolveTokenDecimals({ chain: 'base', token: AEON, providerDecimals: null }).source, 'fallback_18')
  })
})

describe('parseAmount — normalize exactly once', () => {
  it('raw integer 2,996,415 with 6 decimals becomes 2.996415, never 2.996415e-9 / 2.996415e-12', () => {
    assert.equal(parseAmount('2996415', 6), 2.996415)
    assert.notEqual(parseAmount('2996415', 6), 2.996415e-9)
    assert.notEqual(parseAmount('2996415', 6), 2.996415e-12)
  })

  it('already-normalized 2.996415 is NOT divided again', () => {
    assert.equal(parseAmount('2.996415', 6), 2.996415)
    assert.equal(parseAmount('2.996415e0', 6), 2.996415)
    assert.equal(parseAmount('2.996415704e-9', 18), 2.996415704e-9)
  })

  it('production-shaped Base USDC raw 2996415704 at 6 decimals is 2996.415704, not the 18-decimal poison 2.996415704e-9', () => {
    const correct = parseAmount('2996415704', 6)
    const poison = parseAmount('2996415704', 18)
    assert.ok(correct != null && Math.abs(correct - 2996.415704) < 1e-9)
    assert.ok(poison != null && Math.abs(poison - 2.996415704e-9) < 1e-20)
    assert.ok(Math.abs((correct! / poison!) - EIGHTEEN_VS_SIX_SCALE) / EIGHTEEN_VS_SIX_SCALE < 1e-9)
  })

  it('Alchemy hex raw of 2996415704 converts to that integer before the 6-decimal divide', () => {
    const hex = `0x${BigInt('2996415704').toString(16)}`
    assert.equal(hexAmountToIntegerString(hex), '2996415704')
    assert.ok(Math.abs((parseAmount(hex, 6) ?? 0) - 2996.415704) < 1e-9)
  })
})

describe('normalizeEvents — first (and only) Base USDC normalize uses canonical 6', () => {
  it('providerDecimals=18 on Base USDC is overridden; raw 2996415 → 2.996415 stored with tokenDecimals=6', () => {
    const { normalizedEvents, normalizationErrors } = normalizeEvents([rawUsdc()], WALLET)
    assert.equal(normalizationErrors.length, 0)
    assert.equal(normalizedEvents.length, 1)
    assert.equal(normalizedEvents[0].tokenDecimals, 6)
    assert.equal(normalizedEvents[0].amount, 2.996415)
    assert.equal(normalizedEvents[0].amountRaw, '2996415')
  })

  it('production-shaped raw 2996415704 with missing provider decimals becomes 2996.415704, never 2.996415704e-9', () => {
    const { normalizedEvents } = normalizeEvents([rawUsdc({ amountRaw: '2996415704', tokenDecimals: null })], WALLET)
    assert.equal(normalizedEvents[0].tokenDecimals, 6)
    assert.ok(Math.abs(normalizedEvents[0].amount - 2996.415704) < 1e-9)
    assert.ok(normalizedEvents[0].amount > 1, 'must be human USDC units, not the 18-decimal e-9 poison')
  })

  it('Alchemy hex amountRaw on Base USDC is converted then divided by 6 once', () => {
    const hex = `0x${BigInt('2996415704').toString(16)}`
    const { normalizedEvents } = normalizeEvents([rawUsdc({ provider: 'alchemy', amountRaw: hex, tokenDecimals: null })], WALLET)
    assert.equal(normalizedEvents[0].amountRaw, '2996415704')
    assert.equal(normalizedEvents[0].tokenDecimals, 6)
    assert.ok(Math.abs(normalizedEvents[0].amount - 2996.415704) < 1e-9)
  })

  it('already-normalized scientific amountRaw is not divided again', () => {
    const { normalizedEvents } = normalizeEvents([rawUsdc({ amountRaw: '2.996415', tokenDecimals: 6 })], WALLET)
    assert.equal(normalizedEvents[0].amount, 2.996415)
  })

  it('stage trace: first bad stage of the live e-9 number is provider_normalized with decimals=18, not a second 10^6', () => {
    const raw = '2996415704'
    const providerNormalizedWrong = parseAmount(raw, 18)
    const providerNormalizedCanonical = parseAmount(raw, 6)
    assert.ok(providerNormalizedWrong != null && Math.abs(providerNormalizedWrong - 2.996415704e-9) < 1e-20)
    assert.ok(providerNormalizedCanonical != null && Math.abs(providerNormalizedCanonical - 2996.415704) < 1e-9)
    // A second 10^6 on the already-canonical amount would be ~0.002996, which is NOT the live e-9.
    const doubleSix = providerNormalizedCanonical! / 1e6
    assert.ok(Math.abs(doubleSix - 0.002996415704) < 1e-12)
    assert.notEqual(doubleSix, providerNormalizedWrong)
  })
})
