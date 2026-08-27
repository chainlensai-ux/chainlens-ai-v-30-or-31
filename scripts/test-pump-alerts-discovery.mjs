import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  evaluatePumpCandidate,
  rankPumpCandidate,
  isMajorStableWrappedOrLp,
  mergeNormalizedCandidate,
  tokenAgeDaysFromPairCreatedAtMs,
  parsePairCreatedAtMs,
  sanitizeMarketCapUsd,
  PUMP_ALERT_MAX_CAP_USD,
  PUMP_ALERT_MIN_LIQUIDITY_USD,
  PUMP_ALERT_MIN_VOLUME_24H_USD,
  PUMP_ALERT_MIN_24H_CHANGE_PCT,
  PUMP_ALERT_MIN_6H_CHANGE_PCT,
  PUMP_ALERT_MIN_1H_CHANGE_PCT,
  PUMP_ALERT_TARGET_RESULTS,
  PUMP_ALERT_MAX_RAW_CANDIDATES,
  PUMP_ALERT_REQUIRE_EXACT_7D,
} from '../app/api/pump-alerts/route.ts'

function candidate(overrides = {}) {
  return {
    chainSlug: 'base', chainId: 8453, tokenAddress: '0xabc0000000000000000000000000000000000a',
    symbol: 'MOON', name: 'Moon Token',
    priceUsd: 0.002, marketCapUsd: 1_000_000, fdvUsd: 1_200_000,
    liquidityUsd: 50_000, volume24hUsd: 100_000,
    priceChange24hPct: 0, priceChange6hPct: 0, priceChange1hPct: 0,
    pairAddress: '0xpool000000000000000000000000000000000a',
    pairCreatedAtMs: null,
    source: 'geckoterminal',
    ...overrides,
  }
}
