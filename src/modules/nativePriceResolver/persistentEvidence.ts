import { kv as vercelKv } from '@vercel/kv'
import type { NativePriceSourceId } from './index'
import { ALLOWLISTED_ETH_USD_POOLS } from './geckoTerminalEthOhlcv'

export const NATIVE_PRICE_METHODOLOGY_VERSION = 'native-eth-utc-day-v1'
const DAY_MS = 86_400_000
const READ_TIMEOUT_MS = 800
const WRITE_TIMEOUT_MS = 1_500

export type VerifiedNativePriceRecord = {
  version: 1
  asset: 'ETH'
  bucketStartMs: number
  priceUsd: number
  source: NativePriceSourceId
  confidence: 'verified'
  poolAddress: string | null
  candleTimestampMs: number | null
  acceptedAt: number
  methodologyVersion: typeof NATIVE_PRICE_METHODOLOGY_VERSION
}

type NativePriceKv = Pick<typeof vercelKv, 'get' | 'set'>
let kvOverrideForTest: NativePriceKv | null = null

export function __setNativePriceKvForTest(client: NativePriceKv | null): void {
  kvOverrideForTest = client
}

export function nativePricePersistenceConfigured(): boolean {
  return kvOverrideForTest !== null || Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

export function nativePricePersistenceKey(bucketStartMs: number): string {
  return `v1:verified-native-price:eth:${bucketStartMs}`
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('native_price_kv_timeout')), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

const VERIFIED_SOURCES: ReadonlySet<string> = new Set([
  'goldrush_historical',
  'geckoterminal_eth_ohlcv',
  'coingecko_native_coin_history',
  'coingecko_weth_contract_history',
])

export function validateNativePriceRecord(raw: unknown, bucketStartMs: number, nowMs: number): VerifiedNativePriceRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || r.asset !== 'ETH' || r.confidence !== 'verified' ||
      r.methodologyVersion !== NATIVE_PRICE_METHODOLOGY_VERSION || r.bucketStartMs !== bucketStartMs ||
      !Number.isSafeInteger(bucketStartMs) || bucketStartMs <= 0 || bucketStartMs % DAY_MS !== 0 ||
      bucketStartMs + DAY_MS > nowMs || typeof r.priceUsd !== 'number' || !Number.isFinite(r.priceUsd) || r.priceUsd <= 0 ||
      typeof r.source !== 'string' || !VERIFIED_SOURCES.has(r.source) ||
      typeof r.acceptedAt !== 'number' || !Number.isFinite(r.acceptedAt) || r.acceptedAt < bucketStartMs + DAY_MS || r.acceptedAt > nowMs) return null
  if (r.source === 'geckoterminal_eth_ohlcv') {
    if (typeof r.poolAddress !== 'string' ||
        !ALLOWLISTED_ETH_USD_POOLS.some((pool) => pool.poolAddress.toLowerCase() === (r.poolAddress as string).toLowerCase()) ||
        r.candleTimestampMs !== bucketStartMs) return null
  } else if (r.poolAddress !== null || r.candleTimestampMs !== null) return null
  return r as VerifiedNativePriceRecord
}

export async function readVerifiedNativePrice(bucketStartMs: number, nowMs: number): Promise<{ record: VerifiedNativePriceRecord | null; reason: string | null }> {
  if (!nativePricePersistenceConfigured()) return { record: null, reason: 'kv_not_configured' }
  try {
    const raw = await bounded((kvOverrideForTest ?? vercelKv).get<unknown>(nativePricePersistenceKey(bucketStartMs)), READ_TIMEOUT_MS)
    if (raw === null) return { record: null, reason: 'record_absent' }
    const record = validateNativePriceRecord(raw, bucketStartMs, nowMs)
    return { record, reason: record ? null : 'invalid_persisted_record' }
  } catch {
    return { record: null, reason: 'persistent_lookup_failed' }
  }
}

// Redis SET NX is atomic across Vercel workers. No TTL: historical accepted evidence must survive
// deployments and transient provider outages. An existing record is never overwritten.
export async function writeVerifiedNativePrice(record: VerifiedNativePriceRecord, nowMs: number): Promise<{
  succeeded: boolean; authoritative: VerifiedNativePriceRecord | null; contradiction: boolean; reason: string | null
}> {
  if (!validateNativePriceRecord(record, record.bucketStartMs, nowMs)) return { succeeded: false, authoritative: null, contradiction: false, reason: 'invalid_historical_evidence' }
  if (!nativePricePersistenceConfigured()) return { succeeded: false, authoritative: null, contradiction: false, reason: 'kv_not_configured' }
  try {
    const result = await bounded((kvOverrideForTest ?? vercelKv).set(nativePricePersistenceKey(record.bucketStartMs), record, { nx: true }), WRITE_TIMEOUT_MS)
    if (result === 'OK') return { succeeded: true, authoritative: record, contradiction: false, reason: null }
    const existing = await readVerifiedNativePrice(record.bucketStartMs, nowMs)
    if (!existing.record) return { succeeded: false, authoritative: null, contradiction: false, reason: existing.reason ?? 'existing_record_unreadable' }
    const contradiction = Math.abs(record.priceUsd - existing.record.priceUsd) / existing.record.priceUsd > 0.01
    if (contradiction) console.warn('[native-price-contradiction-audit]', {
      bucketStartMs: record.bucketStartMs, existingPriceUsd: existing.record.priceUsd,
      newPriceUsd: record.priceUsd, existingSource: existing.record.source, newSource: record.source,
    })
    return { succeeded: false, authoritative: existing.record, contradiction, reason: contradiction ? 'accepted_price_contradiction' : 'record_already_exists' }
  } catch {
    return { succeeded: false, authoritative: null, contradiction: false, reason: 'persistent_write_failed' }
  }
}
