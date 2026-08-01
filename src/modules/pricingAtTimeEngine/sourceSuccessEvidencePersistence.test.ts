// TESTS — pricingAtTimeEngine: durable source-success evidence across serverless workers.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  loadPersistedEvidence,
  flushEvidenceDelta,
  decodeEvidenceHashes,
  planTokenEviction,
  assertPersistableLevelKey,
  isTokenLevelKey,
  buildEvidenceSummary,
  emptyLoadedEvidence,
  processInstanceId,
  AGGREGATE_HASH_KEY,
  TOKEN_HASH_KEY,
  TOKEN_EVIDENCE_TTL_MS,
  AGGREGATE_EVIDENCE_TTL_MS,
  PERSISTED_COUNTER_FIELDS,
  LAST_UPDATED_FIELD,
  type EvidenceKvLike,
  type EvidencePipelineLike,
} from './sourceSuccessEvidencePersistence'
import {
  recordPricingAttemptOutcome,
  resetSourceSuccessEvidence,
  snapshotEvidenceDelta,
  seedPersistedEvidence,
  snapshotSourceSuccessEvidence,
  estimateSourceSuccessProbability,
  evidenceRecordedThisProcess,
  DEFAULT_UNSEEN_SUCCESS_PROBABILITY,
} from './sourceSuccessEvidence'

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FLAG = 'HISTORICAL_PRICING_EVIDENCE_PERSISTENCE_ENABLED'
const original = process.env[FLAG]

// ---------------------------------------------------------------------------------------------
// A fake KV that records every command, so tests can assert on exactly what would be serialized.
// ---------------------------------------------------------------------------------------------

type Command = { op: string; args: unknown[] }

function fakeKv(options: {
  store?: { aggregate?: Record<string, unknown>; token?: Record<string, unknown> }
  failWith?: Error
  hangForever?: boolean
} = {}): { kv: EvidenceKvLike; commands: Command[] } {
  const commands: Command[] = []
  const pipeline = (): EvidencePipelineLike => {
    const queued: Command[] = []
    const self: EvidencePipelineLike = {
      hgetall(key) { queued.push({ op: 'hgetall', args: [key] }); return self },
      hincrby(key, field, increment) { queued.push({ op: 'hincrby', args: [key, field, increment] }); return self },
      hset(key, value) { queued.push({ op: 'hset', args: [key, value] }); return self },
      hdel(key, ...fields) { queued.push({ op: 'hdel', args: [key, ...fields] }); return self },
      expire(key, seconds) { queued.push({ op: 'expire', args: [key, seconds] }); return self },
      async exec() {
        commands.push(...queued)
        if (options.hangForever) return new Promise<unknown[]>(() => {})
        if (options.failWith) throw options.failWith
        return queued.map((c) => {
          if (c.op !== 'hgetall') return 1
          const key = c.args[0]
          if (key === AGGREGATE_HASH_KEY) return options.store?.aggregate ?? null
          if (key === TOKEN_HASH_KEY) return options.store?.token ?? null
          return null
        })
      },
    }
    return self
  }
  return { kv: { pipeline }, commands }
}

function counterField(levelKey: string, field: string): string {
  return `${levelKey}#${field}`
}

beforeEach(() => {
  resetSourceSuccessEvidence()
  process.env[FLAG] = 'true'
})

afterEach(() => {
  resetSourceSuccessEvidence()
  if (original === undefined) delete process.env[FLAG]
  else process.env[FLAG] = original
})

// ---------------------------------------------------------------------------------------------
// Cold-process load
// ---------------------------------------------------------------------------------------------

test('a cold process loads prior aggregate evidence and immediately ranks with it', () => {
  // Fresh process: nothing observed locally, so the estimate is exactly the default prior.
  assert.equal(
    estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), {
      chain: 'base', token: TOKEN, source: 'geckoterminal', assetClass: 'other', requirementType: 'entry',
    }),
    DEFAULT_UNSEEN_SUCCESS_PROBABILITY,
  )

  // Evidence a previous worker persisted.
  seedPersistedEvidence(new Map([['s=geckoterminal', { attempts: 40, successes: 2, hardFailures: 30 }]]))

  const after = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), {
    chain: 'base', token: TOKEN, source: 'geckoterminal', assetClass: 'other', requirementType: 'entry',
  })
  assert.ok(after < DEFAULT_UNSEEN_SUCCESS_PROBABILITY,
    `a cold process must start warm from persisted evidence, got ${after}`)
})

test('loadPersistedEvidence issues exactly ONE read round-trip, pipelining both hashes', async () => {
  const { kv, commands } = fakeKv({ store: { aggregate: { [counterField('s=goldrush', 'attempts')]: 5 } } })
  const loaded = await loadPersistedEvidence({ kv, now: 1_000_000 })

  assert.deepEqual(commands.map((c) => c.op), ['hgetall', 'hgetall'], 'both hashes in one pipeline')
  assert.equal(loaded.aggregateKeysLoaded, 1)
  assert.equal(loaded.usedDefaultPriors, false)
})

test('seeding never pollutes the delta — loaded baseline is not written back', () => {
  seedPersistedEvidence(new Map([['s=goldrush', { attempts: 100, successes: 50, hardFailures: 0 }]]))
  assert.equal(snapshotEvidenceDelta().size, 0,
    'writing back loaded evidence would double-count what another worker already stored')

  recordPricingAttemptOutcome({
    chain: 'base', token: TOKEN, source: 'goldrush', assetClass: 'other', requirementType: 'entry', ok: true, reason: null,
  })
  assert.equal(snapshotEvidenceDelta().get('s=goldrush')?.attempts, 1, 'only this process\'s own observation')
})

// ---------------------------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------------------------

test('unavailable persistence falls back to default priors and never throws', async () => {
  const { kv } = fakeKv({ failWith: new Error('ECONNREFUSED') })
  const loaded = await loadPersistedEvidence({ kv })
  assert.equal(loaded.usedDefaultPriors, true)
  assert.equal(loaded.levelCounts.size, 0)
  assert.equal(loaded.timedOut, false)

  assert.equal(
    estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), {
      chain: 'base', token: TOKEN, source: 'geckoterminal', assetClass: 'other', requirementType: 'entry',
    }),
    DEFAULT_UNSEEN_SUCCESS_PROBABILITY,
    'an unreachable KV must leave the scan on exactly the 0.5 default prior',
  )
})

test('a hung KV read times out strictly and reports readTimedOut, without throwing', async () => {
  const { kv } = fakeKv({ hangForever: true })
  const started = Date.now()
  const loaded = await loadPersistedEvidence({ kv, timeoutMs: 50 })
  assert.equal(loaded.timedOut, true)
  assert.equal(loaded.usedDefaultPriors, true)
  assert.ok(Date.now() - started < 2000, 'the timeout must actually bound the wait')
})

test('a hung KV write times out strictly and reports writeTimedOut, without throwing', async () => {
  const { kv } = fakeKv({ hangForever: true })
  const delta = new Map([['s=goldrush', { attempts: 1, successes: 1, hardFailures: 0 }]])
  const result = await flushEvidenceDelta(delta, { kv, timeoutMs: 50 })
  assert.equal(result.timedOut, true)
  assert.equal(result.written, false)
})

test('with persistence disabled, neither load nor flush touches KV at all', async () => {
  process.env[FLAG] = 'false'
  const { kv, commands } = fakeKv()
  const loaded = await loadPersistedEvidence({ kv })
  const flushed = await flushEvidenceDelta(new Map([['s=goldrush', { attempts: 1, successes: 1, hardFailures: 0 }]]), { kv })
  assert.equal(commands.length, 0)
  assert.equal(loaded.usedDefaultPriors, true)
  assert.equal(flushed.written, false)
})

// ---------------------------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------------------------

test('concurrent deltas merge safely — counters are HINCRBY deltas, never read-modify-write', async () => {
  const { kv, commands } = fakeKv()
  const delta = new Map([['s=goldrush', { attempts: 3, successes: 2, hardFailures: 1 }]])
  await flushEvidenceDelta(delta, { kv, now: 1_000 })

  const writes = commands.filter((c) => c.op === 'hincrby')
  assert.equal(writes.length, 3, 'one increment per counter field')
  for (const w of writes) {
    assert.equal(w.args[0], AGGREGATE_HASH_KEY)
    assert.ok(typeof w.args[2] === 'number' && (w.args[2] as number) > 0)
  }
  assert.equal(commands.some((c) => c.op === 'hset' && c.args[0] === AGGREGATE_HASH_KEY), false,
    'a whole-value hset on a counter would let one worker clobber another\'s counts')
})

test('two workers flushing the same key both have their counts applied', async () => {
  // Simulates the server side: HINCRBY is additive, so applying both workers' commands in ANY order
  // yields the same total.
  const applied = new Map<string, number>()
  function apply(commands: Command[]): void {
    for (const c of commands) {
      if (c.op !== 'hincrby') continue
      const field = String(c.args[1])
      applied.set(field, (applied.get(field) ?? 0) + (c.args[2] as number))
    }
  }

  const a = fakeKv()
  const b = fakeKv()
  await flushEvidenceDelta(new Map([['s=goldrush', { attempts: 4, successes: 3, hardFailures: 0 }]]), { kv: a.kv })
  await flushEvidenceDelta(new Map([['s=goldrush', { attempts: 6, successes: 1, hardFailures: 2 }]]), { kv: b.kv })

  apply(b.commands)
  apply(a.commands)
  assert.equal(applied.get(counterField('s=goldrush', 'attempts')), 10, 'no count may be lost')
  assert.equal(applied.get(counterField('s=goldrush', 'successes')), 4)
  assert.equal(applied.get(counterField('s=goldrush', 'hardFailures')), 2)
})

test('flush issues exactly ONE batched write round-trip', async () => {
  const { kv } = fakeKv()
  let execCount = 0
  const counting: EvidenceKvLike = {
    pipeline() {
      const p = kv.pipeline()
      const originalExec = p.exec.bind(p)
      p.exec = async () => { execCount += 1; return originalExec() }
      return p
    },
  }
  const delta = new Map([
    ['s=goldrush', { attempts: 3, successes: 2, hardFailures: 1 }],
    ['s=goldrush|ch=base|t=' + TOKEN, { attempts: 3, successes: 2, hardFailures: 1 }],
    ['s=dexscreener|c=other', { attempts: 1, successes: 0, hardFailures: 1 }],
  ])
  await flushEvidenceDelta(delta, { kv: counting })
  assert.equal(execCount, 1)
})

// ---------------------------------------------------------------------------------------------
// Serialization safety
// ---------------------------------------------------------------------------------------------

test('no wallet, tx hash, amount, PnL or lot-id field can be serialized', async () => {
  const { kv, commands } = fakeKv()

  // Every one of these is a shape the schema must refuse outright.
  const forbidden = new Map([
    ['w=0x1111111111111111111111111111111111111111', { attempts: 1, successes: 1, hardFailures: 0 }],
    ['s=goldrush|tx=0x' + 'a'.repeat(64), { attempts: 1, successes: 1, hardFailures: 0 }],
    // A tx hash (64 hex chars) smuggled into the token slot — refused by the 40-char token pattern.
    ['s=goldrush|ch=base|t=0x' + 'b'.repeat(64), { attempts: 1, successes: 1, hardFailures: 0 }],
    ['s=goldrush|amount=1234', { attempts: 1, successes: 1, hardFailures: 0 }],
    ['s=goldrush|pnl=-42.5', { attempts: 1, successes: 1, hardFailures: 0 }],
    ['s=goldrush|lot=lot-17', { attempts: 1, successes: 1, hardFailures: 0 }],
    ['lot-17', { attempts: 1, successes: 1, hardFailures: 0 }],
  ])
  for (const key of forbidden.keys()) {
    assert.equal(assertPersistableLevelKey(key), false, `key must be refused by the grammar: ${key}`)
  }

  await flushEvidenceDelta(forbidden, { kv })
  assert.equal(commands.filter((c) => c.op === 'hincrby').length, 0,
    'not one forbidden key may reach the write path')
})

test('only the enumerated counter fields and lastUpdatedAt are ever written', async () => {
  const { kv, commands } = fakeKv()
  await flushEvidenceDelta(
    new Map([['s=goldrush|ch=base|t=' + TOKEN, { attempts: 2, successes: 1, hardFailures: 1 }]]),
    { kv, now: 5_000 },
  )

  const allowed = new Set<string>([...PERSISTED_COUNTER_FIELDS, LAST_UPDATED_FIELD])
  for (const c of commands) {
    if (c.op === 'hincrby') {
      const suffix = String(c.args[1]).split('#').pop()!
      assert.ok(allowed.has(suffix), `unexpected persisted field: ${suffix}`)
      assert.ok(Number.isInteger(c.args[2]), 'counters must be integers, never amounts or prices')
    }
    if (c.op === 'hset') {
      for (const field of Object.keys(c.args[1] as Record<string, unknown>)) {
        assert.equal(field.split('#').pop(), LAST_UPDATED_FIELD)
      }
    }
  }
})

test('the real recorded delta only ever produces grammar-valid keys', () => {
  recordPricingAttemptOutcome({
    chain: 'base', token: TOKEN, source: 'geckoterminal',
    assetClass: 'other', requirementType: 'entry', ok: false, reason: 'no_pool',
  })
  const delta = snapshotEvidenceDelta()
  assert.ok(delta.size > 0)
  for (const key of delta.keys()) {
    assert.equal(assertPersistableLevelKey(key), true, `real recorder produced an unpersistable key: ${key}`)
  }
})

// ---------------------------------------------------------------------------------------------
// TTL and retention
// ---------------------------------------------------------------------------------------------

test('expired token-level evidence is ignored while fresh token evidence is kept', () => {
  const now = 10_000_000_000
  const freshKey = `s=goldrush|ch=base|t=${TOKEN}`
  const staleKey = 's=goldrush|ch=base|t=0xcccccccccccccccccccccccccccccccccccccccc'

  const decoded = decodeEvidenceHashes(null, {
    [counterField(freshKey, 'attempts')]: 10,
    [counterField(freshKey, LAST_UPDATED_FIELD)]: now - 1000,
    [counterField(staleKey, 'attempts')]: 10,
    [counterField(staleKey, LAST_UPDATED_FIELD)]: now - TOKEN_EVIDENCE_TTL_MS - 1,
  }, now)

  assert.ok(decoded.levelCounts.has(freshKey), 'fresh token evidence must survive')
  assert.equal(decoded.levelCounts.has(staleKey), false, 'stale token evidence must be ignored')
  assert.equal(decoded.tokenKeysLoaded, 1)
})

test('token evidence with no lastUpdatedAt at all is ignored rather than assumed fresh', () => {
  const key = `s=goldrush|ch=base|t=${TOKEN}`
  const decoded = decodeEvidenceHashes(null, { [counterField(key, 'attempts')]: 10 }, 10_000_000_000)
  assert.equal(decoded.levelCounts.size, 0)
})

test('broader source/class evidence is retained regardless of token-level TTL', () => {
  const now = 10_000_000_000
  const staleToken = `s=goldrush|ch=base|t=${TOKEN}`
  const decoded = decodeEvidenceHashes(
    {
      [counterField('s=goldrush', 'attempts')]: 500,
      [counterField('s=goldrush', 'successes')]: 300,
      [counterField('s=goldrush|c=other', 'attempts')]: 200,
    },
    {
      [counterField(staleToken, 'attempts')]: 10,
      [counterField(staleToken, LAST_UPDATED_FIELD)]: now - TOKEN_EVIDENCE_TTL_MS - 1,
    },
    now,
  )

  assert.equal(decoded.levelCounts.get('s=goldrush')?.attempts, 500,
    'broad evidence carries no token TTL and must survive')
  assert.equal(decoded.levelCounts.get('s=goldrush|c=other')?.attempts, 200)
  assert.equal(decoded.levelCounts.has(staleToken), false)
  assert.equal(decoded.aggregateKeysLoaded, 2)
})

test('broad evidence is retained far longer than token evidence', async () => {
  const { kv, commands } = fakeKv()
  await flushEvidenceDelta(
    new Map([['s=goldrush|ch=base|t=' + TOKEN, { attempts: 1, successes: 1, hardFailures: 0 }]]),
    { kv },
  )
  const expires = new Map(commands.filter((c) => c.op === 'expire').map((c) => [c.args[0] as string, c.args[1] as number]))
  assert.equal(expires.get(TOKEN_HASH_KEY), Math.floor(TOKEN_EVIDENCE_TTL_MS / 1000))
  assert.equal(expires.get(AGGREGATE_HASH_KEY), Math.floor(AGGREGATE_EVIDENCE_TTL_MS / 1000))
  assert.ok(expires.get(AGGREGATE_HASH_KEY)! > expires.get(TOKEN_HASH_KEY)!)
})

test('malformed stored payloads are discarded, never coerced into fake counts', () => {
  const decoded = decodeEvidenceHashes({
    [counterField('s=goldrush', 'attempts')]: 'not-a-number',
    [counterField('s=goldrush', 'successes')]: -5,
    'no-hash-separator': 12,
    [counterField('s=goldrush', 'someOtherField')]: 99,
  }, null, 1_000)
  const counts = decoded.levelCounts.get('s=goldrush')
  assert.equal(counts?.attempts, 0, 'an unparseable value contributes nothing')
  assert.equal(counts?.successes, 0, 'a negative count is refused, never used')
})

// ---------------------------------------------------------------------------------------------
// Deterministic eviction
// ---------------------------------------------------------------------------------------------

test('token-level keys are capped with deterministic oldest-first eviction', () => {
  const existing = new Map<string, number>([
    ['s=goldrush|ch=base|t=0x' + '1'.repeat(40), 100],
    ['s=goldrush|ch=base|t=0x' + '2'.repeat(40), 300],
    ['s=goldrush|ch=base|t=0x' + '3'.repeat(40), 200],
  ])
  const evicted = planTokenEviction(existing, [], 400, 2)
  assert.deepEqual(evicted, ['s=goldrush|ch=base|t=0x' + '1'.repeat(40)], 'oldest lastUpdatedAt goes first')

  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(planTokenEviction(existing, [], 400, 2), evicted, 'eviction must be deterministic')
  }
})

test('eviction ties are broken by level key, never randomly', () => {
  const a = 's=goldrush|ch=base|t=0x' + 'a'.repeat(40)
  const b = 's=goldrush|ch=base|t=0x' + 'b'.repeat(40)
  const existing = new Map<string, number>([[b, 100], [a, 100]])
  assert.deepEqual(planTokenEviction(existing, [], 200, 1), [a])
})

test('incoming keys count toward the cap and are treated as freshly updated', () => {
  const existing = new Map<string, number>([['s=goldrush|ch=base|t=0x' + '1'.repeat(40), 100]])
  const incoming = ['s=goldrush|ch=base|t=0x' + '2'.repeat(40)]
  assert.deepEqual(planTokenEviction(existing, incoming, 500, 1), ['s=goldrush|ch=base|t=0x' + '1'.repeat(40)],
    'the just-written key is the freshest and must survive over an old one')
})

test('no eviction happens while under the cap', () => {
  const existing = new Map<string, number>([['s=goldrush|ch=base|t=0x' + '1'.repeat(40), 100]])
  assert.deepEqual(planTokenEviction(existing, [], 500, 5000), [])
})

test('eviction is batched into the same write, never a second round trip', async () => {
  const { kv, commands } = fakeKv()
  const existing = new Map<string, number>([['s=goldrush|ch=base|t=0x' + '9'.repeat(40), 1]])
  await flushEvidenceDelta(
    new Map([['s=goldrush|ch=base|t=' + TOKEN, { attempts: 1, successes: 1, hardFailures: 0 }]]),
    { kv, now: 5_000, existingTokenKeys: existing, maxTokenKeys: 1 },
  )
  const hdels = commands.filter((c) => c.op === 'hdel')
  assert.equal(hdels.length, 1, 'a single batched hdel alongside the increments')
  assert.equal(hdels[0].args[0], TOKEN_HASH_KEY)
})

// ---------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------

test('estimates stay independent of record order once evidence is persisted and reloaded', () => {
  const outcomes = [
    { ok: true, reason: null as string | null },
    { ok: false, reason: 'no_pool' as string | null },
    { ok: false, reason: null as string | null },
    { ok: true, reason: null as string | null },
  ]
  const probe = { chain: 'base' as const, token: TOKEN, source: 'goldrush' as const, assetClass: 'other' as const, requirementType: 'entry' as const }

  function runInOrder(list: typeof outcomes): number {
    resetSourceSuccessEvidence()
    for (const o of list) {
      recordPricingAttemptOutcome({
        chain: 'base', token: TOKEN, source: 'goldrush', assetClass: 'other', requirementType: 'entry', ...o,
      })
    }
    // Round-trip the delta through the persistence encoding, exactly as a flush + reload would.
    const delta = snapshotEvidenceDelta()
    resetSourceSuccessEvidence()
    seedPersistedEvidence(delta)
    return estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probe)
  }

  const forward = runInOrder(outcomes)
  const reversed = runInOrder([...outcomes].reverse())
  assert.equal(forward, reversed)
})

test('a flush-then-reload cycle reproduces the pre-flush estimate exactly', () => {
  const probe = { chain: 'base' as const, token: TOKEN, source: 'goldrush' as const, assetClass: 'other' as const, requirementType: 'entry' as const }
  for (let i = 0; i < 7; i += 1) {
    recordPricingAttemptOutcome({
      chain: 'base', token: TOKEN, source: 'goldrush', assetClass: 'other', requirementType: 'entry',
      ok: i % 3 === 0, reason: i % 3 === 0 ? null : 'no_pool',
    })
  }
  const before = estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probe)

  const delta = snapshotEvidenceDelta()
  resetSourceSuccessEvidence()
  seedPersistedEvidence(delta)

  assert.equal(estimateSourceSuccessProbability(snapshotSourceSuccessEvidence(), probe), before,
    'persistence must be lossless for the counts the estimator actually uses')
})

// ---------------------------------------------------------------------------------------------
// Diagnostic
// ---------------------------------------------------------------------------------------------

test('the summary reports every required field', () => {
  const summary = buildEvidenceSummary({
    loaded: emptyLoadedEvidence(),
    flush: { written: false, fieldsWritten: 0, evictedTokenKeys: 0, timedOut: false },
    evidenceRecordedThisScan: evidenceRecordedThisProcess(),
    processInstanceId: processInstanceId(),
  })
  for (const field of [
    'persistenceEnabled', 'evidenceLoadedBeforeScan', 'evidenceRecordedThisScan',
    'aggregateKeysLoaded', 'tokenKeysLoaded', 'readTimedOut', 'writeTimedOut',
    'usedDefaultPriors', 'processInstanceId',
  ]) {
    assert.ok(field in summary, `missing required diagnostic field: ${field}`)
  }
  assert.equal(summary.persistenceEnabled, true)
  assert.equal(summary.evidenceLoadedBeforeScan, false)
  assert.ok(summary.processInstanceId.length > 0)
})

test('isTokenLevelKey distinguishes token-scoped keys from broad ones', () => {
  assert.equal(isTokenLevelKey(`s=goldrush|ch=base|t=${TOKEN}`), true)
  assert.equal(isTokenLevelKey('s=goldrush|c=other'), false)
  assert.equal(isTokenLevelKey('s=goldrush'), false)
})
