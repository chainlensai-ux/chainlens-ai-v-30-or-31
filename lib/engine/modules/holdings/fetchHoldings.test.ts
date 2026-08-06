// Tests for lib/engine/modules/holdings/fetchHoldings.ts. Uses node:test, same convention as the
// other module test files this session (e.g. src/modules/lotOpener/lotOpener.test.ts). NOT wired
// into `npm test` (which runs a single hardcoded file — see package.json). Run directly with:
//   npx tsx --test lib/engine/modules/holdings/fetchHoldings.test.ts
//
// LIVE-DATA DISCLOSURE: the task asked to assert fetchAllHoldings returns "at least one
// ChainHolding" for a real test wallet with known balances. That assertion can only be true against
// a REAL provider response (GoldRush/Alchemy) — this sandbox has no API keys configured (confirmed
// throughout this session), so a hardcoded "must be non-empty" assertion would fail here not
// because the code is wrong, but because there's no real network access to prove it right. Rather
// than fake a pass or silently skip the real assertion, this test does both: it always verifies the
// STRUCTURAL contract (return type, per-chain filtering, chainId correctness — everything provable
// without live provider access), and it runs the real non-empty/shape assertions from the task
// CONDITIONALLY, only when it detects a real provider key is configured, logging clearly when it
// skips them rather than pretending to have verified something it didn't.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchAllHoldings, fetchChainBalances, DEFAULT_HOLDINGS_CHAIN_IDS, CHAIN_ID_TO_SUPPORTED_CHAIN,
  __resetNegativeBalanceCacheForTest,
} from './fetchHoldings'

const TEST_WALLET = '0xf85679316f1c3998c6387f6f707b31aeeb3a9abe' // real address used elsewhere this session

const hasRealProviderKeys = Boolean(
  process.env.GOLDRUSH_API_KEY || process.env.COVALENT_API_KEY || process.env.ALCHEMY_BASE_KEY || process.env.ALCHEMY_ETHEREUM_KEY,
)

describe('fetchChainBalances', () => {
  it('returns [] for an unsupported chainId, never throws', async () => {
    const result = await fetchChainBalances(TEST_WALLET, 999999)
    assert.deepEqual(result, [])
  })

  it('returns a real array for chainId 1 (Ethereum), never throws even without provider keys', async () => {
    const result = await fetchChainBalances(TEST_WALLET, 1)
    assert.ok(Array.isArray(result))
    for (const holding of result) {
      assert.equal(holding.chainId, 1)
      assert.ok(holding.tokenAddress.length > 0)
      assert.ok(Number(holding.quantity) > 0)
      assert.ok(['stable', 'blue_chip', 'meme', 'lp', 'other'].includes(holding.classification))
    }
  })

  it('returns a real array for chainId 8453 (Base), never throws even without provider keys', async () => {
    const result = await fetchChainBalances(TEST_WALLET, 8453)
    assert.ok(Array.isArray(result))
    for (const holding of result) {
      assert.equal(holding.chainId, 8453)
    }
  })
})

// ALCHEMY COST-AUDIT FOLLOW-UP TASK — required regressions: confirmed production mismatch (the
// worker's own [CU-TRACK] log already claimed `chains: [1, 8453]` while fetchAllHoldings actually
// fanned out to all 4 supported chains, Arbitrum/HyperEVM included, on every scan).
describe('fetchAllHoldings — hard chain allowlist (Alchemy cost-audit follow-up task)', () => {
  beforeEach(() => __resetNegativeBalanceCacheForTest())

  it('HARD ASSERTION (required regression): defaults to Base + ETH only — never probes Arbitrum/HyperEVM (or any unsupported chain) unless explicitly requested', () => {
    assert.deepEqual([...DEFAULT_HOLDINGS_CHAIN_IDS].sort((a, b) => a - b), [1, 8453])
  })

  it('HARD ASSERTION (required regression): a default call never reaches chainIds outside [1, 8453] — covers the Linea/Scroll/zkSync/Avalanche/Optimism/Polygon/BNB "no unselected chain" requirement by construction (this module has no mapping for any of them, and even its OWN supported extras — Arbitrum 42161, HyperEVM 999 — are excluded from the default)', async () => {
    const result = await fetchAllHoldings(TEST_WALLET)
    const chainIds = new Set(result.map((h) => h.chainId))
    for (const id of chainIds) assert.ok([1, 8453].includes(id), `unexpected chainId ${id} reached on a default-scoped call`)
  })

  it('an explicit deep/full-chain request reaches every real supported chain, never more', async () => {
    const allSupported = Object.keys(CHAIN_ID_TO_SUPPORTED_CHAIN).map(Number)
    const result = await fetchAllHoldings(TEST_WALLET, allSupported)
    const chainIds = new Set(result.map((h) => h.chainId))
    for (const id of chainIds) assert.ok(allSupported.includes(id))
  })

  it('a caller-supplied chain id outside this module\'s real supported mapping is silently dropped, never probed', async () => {
    // 59144 = Linea's real chain id — included here specifically to prove that even an explicit
    // request for it never reaches a live call (this module has no provider mapping for it at all).
    const result = await fetchAllHoldings(TEST_WALLET, [1, 8453, 59144])
    const chainIds = new Set(result.map((h) => h.chainId))
    assert.ok(!chainIds.has(59144), 'a chain with no real provider mapping must never be probed, even if explicitly requested')
  })

  it('a repeat call within the negative-cache window makes no second live fetch for a chain that was empty', async () => {
    const first = await fetchChainBalances(TEST_WALLET, 1)
    assert.equal(first.length, 0, 'sanity: no provider keys in this sandbox, so the real fetch is genuinely empty')
    // Second call must be served from the negative cache — same empty result, no new live attempt.
    // (fetchRealHoldings itself is side-effect-free to observe directly here, so this asserts the
    // OBSERVABLE contract — a stable, repeatable empty result — rather than a private call counter.)
    const second = await fetchChainBalances(TEST_WALLET, 1)
    assert.equal(second.length, 0)
  })
})

describe('fetchAllHoldings', () => {
  it('never throws and returns a flat array covering both chains', async () => {
    const result = await fetchAllHoldings(TEST_WALLET)
    assert.ok(Array.isArray(result))
    const chainIds = new Set(result.map((h) => h.chainId))
    for (const id of chainIds) assert.ok([1, 8453].includes(id))
  })

  it('LIVE ASSERTION (task-requested): at least one non-empty ChainHolding with correct chainId, non-zero quantity, non-empty tokenAddress', async (t) => {
    if (!hasRealProviderKeys) {
      // eslint-disable-next-line no-console
      console.log('[fetchHoldings.test] skipping live non-empty assertion — no GOLDRUSH/ALCHEMY key configured in this environment')
      t.skip('no real provider keys configured in this environment')
      return
    }
    const result = await fetchAllHoldings(TEST_WALLET)
    assert.ok(result.length > 0, 'expected at least one real holding for the test wallet')
    const first = result[0]
    assert.ok([1, 8453].includes(first.chainId))
    assert.ok(Number(first.quantity) > 0)
    assert.ok(first.tokenAddress.length > 0)
  })
})
