// Tests for app/api/_shared/v1Detector.ts. NOT wired into `npm test`. Run directly with:
//   npx tsx --test app/api/_shared/v1Detector.test.ts
//
// Module holds shared in-memory state (matching its own real design), so this only asserts the
// one-directional transition (false -> true) rather than resetting between cases.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { markV1Triggered, wasV1Triggered } from './v1Detector'

describe('v1Detector', () => {
  it('wasV1Triggered flips to true after markV1Triggered and stays true', () => {
    markV1Triggered('test-context')
    assert.equal(wasV1Triggered(), true)
    assert.equal(wasV1Triggered(), true, 'calling wasV1Triggered again must not reset state')
  })
})
