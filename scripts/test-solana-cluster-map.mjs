// TESTS — Solana Dev Intelligence Phase 2: Cluster Map / Linked Wallets (Deep Cluster Check).
// Stubs fetchImpl so real logic runs with zero network access, no API keys.

import assert from 'node:assert/strict'
import { analyzeSolanaCluster } from '../lib/server/solana/clusterAnalyzer.ts'
import { fetchHeliusWalletFundingTrace } from '../lib/server/solanaProviders.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

process.env.ENABLE_HELIUS_SOLANA = 'true'
process.env.HELIUS_API_KEY = 'test-key'

const MINT = 'Mint1111111111111111111111111111111111111'
const CREATOR = 'Creator111111111111111111111111111111111'
const FUNDER = 'Funder111111111111111111111111111111111'

function stubFetch({ sigPages, enhanced }) {
  let sigCallCount = 0
  return async (url, opts) => {
    if (url.includes('mainnet.helius-rpc.com')) {
      const body = JSON.parse(opts.body)
      const page = sigPages[sigCallCount] ?? []
      sigCallCount++
      return { ok: true, json: async () => ({ result: page }) }
    }
    if (url.includes('api.helius.xyz/v0/transactions')) {
      return { ok: true, json: async () => [enhanced] }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

// ─── No creator wallet resolved => attempted:false, honest "no relationships" message ──────────
{
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT,
    creatorTrace: { called: true, success: false, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: null, earliestTimestamp: null, likelyCreatorWallet: null, transactionSource: null }, errorReason: 'no_signature_history_found' },
    fetchImpl: async () => { throw new Error('should never be called') },
  })
  check('no creator wallet => attempted is false', cm.attempted === false)
  check('no creator wallet => honest "no verified relationships" message, never "not supported"', cm.summary === 'No verified wallet relationships found.')
  check('no creator wallet => evidenceCount is 0', cm.evidenceCount === 0)
}

// ─── Funding wallet resolved => real 2-node graph, evidence-cited edges ────────────────────────
{
  const fetchImpl = stubFetch({
    sigPages: [[{ signature: 'funder_sig', blockTime: 1690000000 }]],
    enhanced: { nativeTransfers: [{ fromUserAccount: FUNDER, toUserAccount: CREATOR, amount: 2_000_000_000 }] },
  })
  const creatorTrace = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'mint_sig', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: CREATOR, transactionSource: 'PUMP_FUN' }, errorReason: null }
  const cm = await analyzeSolanaCluster({ mintAddress: MINT, creatorTrace, fetchImpl })
  check('funding wallet resolved => attempted true', cm.attempted === true)
  check('funding wallet resolved => evidenceCount is 2 (fee payer + funding hop)', cm.evidenceCount === 2)
  check('funding wallet resolved => 2 edges: funding_wallet and shared_fee_payer', cm.edges.some(e => e.relationship === 'funding_wallet') && cm.edges.some(e => e.relationship === 'shared_fee_payer'))
  check('funding path is real, ordered funder -> creator', cm.fundingPath[0] === FUNDER && cm.fundingPath[1] === CREATOR)
  check('funding amount (2 SOL) is well above the fresh-burner threshold => standard risk', cm.riskLevel === 'standard')
  check('summary cites the real evidence count', cm.summary.includes('2 verified relationships'))
}

// ─── Fresh/low SOL funding => elevated risk, real evidence-cited reason ─────────────────────────
{
  const fetchImpl = stubFetch({
    sigPages: [[{ signature: 'funder_sig2', blockTime: 1690000000 }]],
    enhanced: { nativeTransfers: [{ fromUserAccount: FUNDER, toUserAccount: CREATOR, amount: 10_000_000 }] }, // 0.01 SOL
  })
  const creatorTrace = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'mint_sig2', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: CREATOR, transactionSource: null }, errorReason: null }
  const cm = await analyzeSolanaCluster({ mintAddress: MINT, creatorTrace, fetchImpl })
  check('0.01 SOL funding is below the 0.05 threshold => elevated risk', cm.riskLevel === 'elevated')
  check('elevated risk reason cites the real SOL amount', cm.riskReason.includes('0.0100 SOL'))
}

// ─── Funding trace fails cleanly => still returns the fee-payer edge, honest partial result ────
{
  const fetchImpl = async (url) => {
    if (url.includes('mainnet.helius-rpc.com')) return { ok: true, json: async () => ({ result: [] }) }
    throw new Error('should not reach Enhanced Transactions with no signature history')
  }
  const creatorTrace = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'mint_sig3', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: CREATOR, transactionSource: null }, errorReason: null }
  const cm = await analyzeSolanaCluster({ mintAddress: MINT, creatorTrace, fetchImpl })
  check('funding trace found no history => evidenceCount stays 1 (just the fee-payer edge), never fabricated', cm.evidenceCount === 1)
  check('funding trace found no history => clusterConfidence is low, not none (the fee-payer edge is still real evidence)', cm.clusterConfidence === 'low')
  check('funding trace found no history => risk level is unknown, never guessed', cm.riskLevel === 'unknown')
}

// ─── fetchHeliusWalletFundingTrace: disabled provider degrades cleanly ──────────────────────────
{
  delete process.env.ENABLE_HELIUS_SOLANA
  const r = await fetchHeliusWalletFundingTrace(CREATOR, async () => { throw new Error('should never be called') })
  check('disabled Helius => called:false, never throws', r.called === false && r.success === false)
  process.env.ENABLE_HELIUS_SOLANA = 'true'
}

console.log(`test-solana-cluster-map.mjs: all ${passed} assertions passed`)
