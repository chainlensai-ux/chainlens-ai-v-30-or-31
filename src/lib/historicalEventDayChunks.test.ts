import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  stitchHistoryDayChunks, dayIndexKey, dayChunkKey, MAX_EVENTS_PER_DAY_CHUNK,
  type DayChunkKv, type ChainStitchInput,
} from './historicalEventDayChunks'
import type { RawProviderEvent } from '../modules/providerFetchWindow/types'

const WALLET = '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811'
const DAY = 24 * 60 * 60 * 1000
const D = (day: number, hour = 12) => Date.UTC(2026, 9, day, hour)
const CONFIGURED_START = Date.UTC(2026, 6, 26) // 90 days before late October

function memoryKv(): DayChunkKv & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T,>(key: string) => (store.has(key) ? structuredClone(store.get(key)) as T : null),
    set: async (key: string, value: unknown) => { store.set(key, structuredClone(value)); return 'OK' },
  }
}

let seq = 0
function ev(ms: number, overrides: Partial<RawProviderEvent> = {}): RawProviderEvent {
  seq += 1
  return {
    provider: 'alchemy', chain: 'base', txHash: `0x${seq.toString(16).padStart(64, '0')}`, timestamp: new Date(ms).toISOString(),
    fromAddress: WALLET, toAddress: '0xrouter', contract: '0xtoken', symbol: 'TKN', amountRaw: '1000', tokenDecimals: 18, ...overrides,
  }
}

function input(events: RawProviderEvent[], freshStartMs: number, providerOk = true): ChainStitchInput {
  return { chain: 'base', freshEvents: events, freshStartMs, providerOk }
}

const run = (kv: DayChunkKv | null, inputs: ChainStitchInput[], scanMs: number, maxTotalEvents = 100_000) =>
  stitchHistoryDayChunks(kv, { wallet: WALLET, chains: inputs, scanMs, configuredStartMs: CONFIGURED_START, maxTotalEvents, ttlSeconds: 60 })

describe('stitchHistoryDayChunks', () => {
  it('first scan stitches nothing and stores each whole day it read (never today)', async () => {
    const kv = memoryKv()
    const events = [ev(D(18)), ev(D(19)), ev(D(19, 20)), ev(D(24, 6))]
    const result = await run(kv, [input(events, Date.UTC(2026, 9, 18))], D(24, 9))
    assert.equal(result.olderEvents.length, 0)
    assert.equal(result.startByChain.get('base'), Date.UTC(2026, 9, 18))
    const index = kv.store.get(dayIndexKey(WALLET, 'base')) as { days: Record<string, number> }
    assert.deepEqual(index.days, { '2026-10-18': 1, '2026-10-19': 2, '2026-10-20': 0, '2026-10-21': 0, '2026-10-22': 0, '2026-10-23': 0 })
    assert.ok(!kv.store.has(dayChunkKey(WALLET, 'base', '2026-10-24')), 'today is incomplete and never stored')
  })

  it('a later scan whose page cap starts later extends back through the stored days', async () => {
    const kv = memoryKv()
    const day18 = ev(D(18)), day19 = ev(D(19))
    await run(kv, [input([day18, day19, ev(D(20))], Date.UTC(2026, 9, 18))], D(21, 9))
    // Two days later the cap only reaches Oct 20.
    const result = await run(kv, [input([ev(D(20)), ev(D(22))], Date.UTC(2026, 9, 20))], D(23, 9))
    assert.equal(result.startByChain.get('base'), Date.UTC(2026, 9, 18))
    assert.deepEqual(result.olderEvents.map((e) => e.txHash).sort(), [day18.txHash, day19.txHash].sort())
    assert.equal(result.audit[0].daysStitched, 2)
    assert.equal(result.audit[0].stopReason, 'no_stored_day')
  })

  it('stops at the first missing day — the stitched window is always contiguous', async () => {
    const kv = memoryKv()
    await run(kv, [input([ev(D(15))], Date.UTC(2026, 9, 15))], D(16, 9)) // stores Oct 15
    await run(kv, [input([ev(D(17))], Date.UTC(2026, 9, 17))], D(18, 9)) // stores Oct 17 (Oct 16 never read)
    const result = await run(kv, [input([ev(D(18))], Date.UTC(2026, 9, 18))], D(19, 9))
    assert.equal(result.startByChain.get('base'), Date.UTC(2026, 9, 17))
    assert.equal(result.audit[0].daysStitched, 1)
  })

  it('respects the event budget (fresh events count against it)', async () => {
    const kv = memoryKv()
    await run(kv, [input([ev(D(17)), ev(D(17, 13)), ev(D(18)), ev(D(18, 13))], Date.UTC(2026, 9, 17))], D(19, 9))
    const result = await run(kv, [input([ev(D(19))], Date.UTC(2026, 9, 19))], D(20, 9), 3)
    assert.equal(result.audit[0].stopReason, 'event_budget')
    assert.equal(result.audit[0].daysStitched, 1, 'Oct 18 fits (1 fresh + 2), Oct 17 does not')
    assert.equal(result.startByChain.get('base'), Date.UTC(2026, 9, 18))
  })

  it('stores nothing when the chain providers did not answer fully', async () => {
    const kv = memoryKv()
    await run(kv, [input([ev(D(18))], Date.UTC(2026, 9, 18), false)], D(20, 9))
    assert.equal(kv.store.size, 0)
  })

  it('a corrupted chunk is dropped from the index and never stitched', async () => {
    const kv = memoryKv()
    await run(kv, [input([ev(D(18))], Date.UTC(2026, 9, 18))], D(19, 9))
    kv.store.set(dayChunkKey(WALLET, 'base', '2026-10-18'), { v: 1, day: '2026-10-18', events: [['not-a-hash']] })
    const result = await run(kv, [input([ev(D(19))], Date.UTC(2026, 9, 19))], D(20, 9))
    assert.equal(result.olderEvents.length, 0)
    assert.equal(result.audit[0].stopReason, 'chunk_unreadable')
    const index = kv.store.get(dayIndexKey(WALLET, 'base')) as { days: Record<string, number> }
    assert.ok(!('2026-10-18' in index.days))
  })

  it('a day too large for one KV value is not stored (so stitching stops there)', async () => {
    const kv = memoryKv()
    const big = Array.from({ length: MAX_EVENTS_PER_DAY_CHUNK + 1 }, () => ev(D(18)))
    const result = await run(kv, [input(big, Date.UTC(2026, 9, 18))], D(19, 9))
    assert.equal(result.audit[0].daysSkippedTooLarge, 1)
    assert.ok(!kv.store.has(dayChunkKey(WALLET, 'base', '2026-10-18')))
  })

  it('never stitches past the configured window', async () => {
    const kv = memoryKv()
    const start = CONFIGURED_START + DAY
    await run(kv, [input([ev(start - DAY + 3600_000)], start - DAY)], start + 3600_000)
    const result = await run(kv, [input([ev(start + 7200_000)], start)], start + 2 * DAY)
    assert.equal(result.startByChain.get('base'), start - DAY)
    assert.equal(result.audit[0].stopReason, 'configured_window_reached')
  })

  it('without a KV it is a no-op that keeps the fresh start', async () => {
    const result = await run(null, [input([ev(D(18))], Date.UTC(2026, 9, 18))], D(19, 9))
    assert.equal(result.startByChain.get('base'), Date.UTC(2026, 9, 18))
    assert.equal(result.audit[0].stopReason, 'disabled')
  })
})
