// CONFIRMED BUG, DISCLOSED (see collapseRapidRepeats' own header in route.ts): the whale-alerts feed
// pipeline sorts rows by USD value and then by interest score BEFORE calling collapseRapidRepeats,
// even though that function's own original comment assumed newest-first (occurred_at desc) input.
// The old asymmetric time check silently merged temporally-unrelated alerts (same wallet+token+side,
// days apart) into one row whenever a scrambled order put the newer row after the older one — a real,
// distinct whale alert dropped from the feed and miscounted as a "repeat."

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collapseRapidRepeats } from './route'

function row(overrides: Record<string, unknown>) {
  return {
    wallet_address: '0xWALLET',
    token_symbol: 'AERO',
    side: 'buy',
    ...overrides,
  }
}

describe('collapseRapidRepeats', () => {
  it('does not collapse two real alerts for the same wallet+token+side that are days apart, even when the array is not chronologically ordered', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const now = new Date().toISOString()

    // Scrambled order: the OLDER alert appears first in the array, the NEWER one second — exactly
    // what the real pipeline produces after its USD-value/interest-score sorts.
    const rows = [row({ occurred_at: tenDaysAgo }), row({ occurred_at: now })]

    const result = collapseRapidRepeats(rows)

    assert.equal(result.length, 2, 'two temporally-unrelated alerts must both survive, never merged into one')
    assert.equal(result[0].repeats, 1)
    assert.equal(result[1].repeats, 1)
  })

  it('still collapses two real repeats within the 5-minute window, regardless of array order', () => {
    const base = Date.now()
    const t0 = new Date(base).toISOString()
    const t2min = new Date(base + 2 * 60 * 1000).toISOString()

    // Reverse-chronological within the window (older second) — the documented "normal" case.
    const chronological = collapseRapidRepeats([row({ occurred_at: t2min }), row({ occurred_at: t0 })])
    assert.equal(chronological.length, 1)
    assert.equal(chronological[0].repeats, 2)

    // Scrambled (newer second) — must behave identically now that the check is symmetric.
    const scrambled = collapseRapidRepeats([row({ occurred_at: t0 }), row({ occurred_at: t2min })])
    assert.equal(scrambled.length, 1)
    assert.equal(scrambled[0].repeats, 2)
  })

  it('keeps rows for different wallets/tokens/sides distinct regardless of timestamp', () => {
    const now = new Date().toISOString()
    const rows = [
      row({ occurred_at: now, wallet_address: '0xA' }),
      row({ occurred_at: now, wallet_address: '0xB' }),
      row({ occurred_at: now, token_symbol: 'USDC' }),
      row({ occurred_at: now, side: 'sell' }),
    ]
    const result = collapseRapidRepeats(rows)
    assert.equal(result.length, 4)
    assert.ok(result.every(r => r.repeats === 1))
  })
})
