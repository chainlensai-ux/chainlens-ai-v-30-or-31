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

const NO_POOL = { resolved: false, poolAddress: null, owner: null, label: null, errorReason: null, verdict: 'unverified', migratedFromPumpFun: null }

// ─── No creator wallet resolved => attempted:false, honest "no relationships" message ──────────
{
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT,
    creatorTrace: { called: true, success: false, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: null, earliestTimestamp: null, likelyCreatorWallet: null, transactionSource: null }, errorReason: 'no_signature_history_found' },
    mintAuthority: null, freezeAuthority: null, poolProgram: NO_POOL,
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
  const cm = await analyzeSolanaCluster({ mintAddress: MINT, creatorTrace, mintAuthority: null, freezeAuthority: null, poolProgram: NO_POOL, fetchImpl })
  check('funding wallet resolved => attempted true', cm.attempted === true)
  check('funding wallet resolved => evidenceCount is 2 (fee payer + funding hop)', cm.evidenceCount === 2)
  check('funding wallet resolved => 2 edges: funding_wallet and shared_fee_payer', cm.edges.some(e => e.relationship === 'funding_wallet') && cm.edges.some(e => e.relationship === 'shared_fee_payer'))
  check('funding path is real, ordered funder -> creator', cm.fundingPath[0] === FUNDER && cm.fundingPath[1] === CREATOR)
  check('funding depth is 1 real hop', cm.fundingDepth === 1)
  check('funding amount (2 SOL) is well above the fresh-burner threshold => standard risk', cm.riskLevel === 'standard')
  check('summary cites the real evidence count', cm.summary.includes('2 verified relationships'))
  check('node graph includes a mint node, a creator_wallet node, and a funding_wallet node', ['mint', 'creator_wallet', 'funding_wallet'].every(role => cm.nodes.some(n => n.role === role)))
  check('mint node is confidence high, risk neutral (not a risk subject itself)', cm.nodes.find(n => n.role === 'mint').confidence === 'high' && cm.nodes.find(n => n.role === 'mint').risk === 'neutral')
  check('creator wallet confidence is high (genesis reached + recognized PUMP_FUN source)', cm.nodes.find(n => n.role === 'creator_wallet').confidence === 'high')
  check('every node has at least one real evidence string, never empty', cm.nodes.every(n => n.evidence.length > 0 && n.evidence.every(e => typeof e === 'string' && e.length > 0)))
  check('every edge has a stable, unique id', new Set(cm.edges.map(e => e.id)).size === cm.edges.length)
}

// ─── Fresh/low SOL funding => elevated risk, real evidence-cited reason ─────────────────────────
{
  const fetchImpl = stubFetch({
    sigPages: [[{ signature: 'funder_sig2', blockTime: 1690000000 }]],
    enhanced: { nativeTransfers: [{ fromUserAccount: FUNDER, toUserAccount: CREATOR, amount: 10_000_000 }] }, // 0.01 SOL
  })
  const creatorTrace = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'mint_sig2', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: CREATOR, transactionSource: null }, errorReason: null }
  const cm = await analyzeSolanaCluster({ mintAddress: MINT, creatorTrace, mintAuthority: null, freezeAuthority: null, poolProgram: NO_POOL, fetchImpl })
  check('0.01 SOL funding is below the 0.05 threshold => elevated risk', cm.riskLevel === 'elevated')
  check('elevated risk reason cites the real SOL amount', cm.riskReason.includes('0.0100 SOL'))
  check('creator wallet node risk mirrors the elevated funding-pattern read', cm.nodes.find(n => n.role === 'creator_wallet').risk === 'elevated')
  check('funding wallet node itself is flagged elevated too (rent-level funding amount)', cm.nodes.find(n => n.role === 'funding_wallet').risk === 'elevated')
}

// ─── Funding trace fails cleanly => still returns the fee-payer edge, honest partial result ────
{
  const fetchImpl = async (url) => {
    if (url.includes('mainnet.helius-rpc.com')) return { ok: true, json: async () => ({ result: [] }) }
    throw new Error('should not reach Enhanced Transactions with no signature history')
  }
  const creatorTrace = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'mint_sig3', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: CREATOR, transactionSource: null }, errorReason: null }
  const cm = await analyzeSolanaCluster({ mintAddress: MINT, creatorTrace, mintAuthority: null, freezeAuthority: null, poolProgram: NO_POOL, fetchImpl })
  check('funding trace found no history => evidenceCount stays 1 (just the fee-payer edge), never fabricated', cm.evidenceCount === 1)
  check('funding trace found no history => clusterConfidence is low, not none (the fee-payer edge is still real evidence)', cm.clusterConfidence === 'low')
  check('funding trace found no history => risk level is unknown, never guessed', cm.riskLevel === 'unknown')
  check('funding trace found no history => fundingDepth is 0 (no verified hop)', cm.fundingDepth === 0)
  check('funding trace found no history => no funding_wallet node was fabricated', !cm.nodes.some(n => n.role === 'funding_wallet'))
}

// ─── Mint authority + freeze authority + LP pool nodes: real, on-chain-verified evidence ────────
{
  const fetchImpl = async () => { throw new Error('should not be called — no funding trace requested in this case') }
  const creatorTrace = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: false, resolved: { earliestSignature: 'mint_sig4', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: null, transactionSource: null }, errorReason: null }
  const cmNoCreator = await analyzeSolanaCluster({ mintAddress: MINT, creatorTrace, mintAuthority: 'MintAuth11111111111111111111111111111111', freezeAuthority: 'FreezeAuth111111111111111111111111111111', poolProgram: { resolved: true, poolAddress: 'Pool111111111111111111111111111111111111', owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'PumpSwap AMM', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: true }, fetchImpl })
  // No creator wallet resolved => attempted:false by design (see the "no creator wallet" case above) —
  // authority/pool nodes are only added on the attempted:true path, so confirm that combination here
  // with a resolved creator wallet instead.
  const fetchImplWithFunding = async (url) => {
    if (url.includes('mainnet.helius-rpc.com')) return { ok: true, json: async () => ({ result: [] }) }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const creatorTraceResolved = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'mint_sig5', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: CREATOR, transactionSource: 'PUMP_FUN' }, errorReason: null }
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT, creatorTrace: creatorTraceResolved,
    mintAuthority: 'MintAuth11111111111111111111111111111111', freezeAuthority: 'FreezeAuth111111111111111111111111111111',
    poolProgram: { resolved: true, poolAddress: 'Pool111111111111111111111111111111111111', owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'PumpSwap AMM', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: true },
    fetchImpl: fetchImplWithFunding,
  })
  check('active mint authority => a real mint_authority node is added, elevated risk', cm.nodes.some(n => n.role === 'mint_authority' && n.address === 'MintAuth11111111111111111111111111111111' && n.risk === 'elevated'))
  check('active freeze authority => a real freeze_authority node is added, elevated risk', cm.nodes.some(n => n.role === 'freeze_authority' && n.address === 'FreezeAuth111111111111111111111111111111' && n.risk === 'elevated'))
  check('resolved pool => a real lp_pool node is added with the verified label', cm.nodes.some(n => n.role === 'lp_pool' && n.label === 'PumpSwap AMM'))
  check('PumpSwap migration => a real pumpfun_migration edge is added', cm.edges.some(e => e.relationship === 'pumpfun_migration'))
  check('active mint/freeze authority elevates overall cluster risk even without a resolved funding hop', cm.riskLevel === 'elevated')
  check('cmNoCreator (unresolved creator wallet) never fabricates any node', cmNoCreator.attempted === false && cmNoCreator.nodes.length === 0)
}

// ─── Revoked authorities and unrecognized pool program never fabricate nodes ────────────────────
{
  const fetchImpl = async (url) => {
    if (url.includes('mainnet.helius-rpc.com')) return { ok: true, json: async () => ({ result: [] }) }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const creatorTrace = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'mint_sig6', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: CREATOR, transactionSource: null }, errorReason: null }
  const cm = await analyzeSolanaCluster({ mintAddress: MINT, creatorTrace, mintAuthority: null, freezeAuthority: null, poolProgram: NO_POOL, fetchImpl })
  check('revoked authorities => no mint_authority/freeze_authority nodes fabricated', !cm.nodes.some(n => n.role === 'mint_authority' || n.role === 'freeze_authority'))
  check('unresolved pool => no lp_pool node fabricated', !cm.nodes.some(n => n.role === 'lp_pool'))
}

// ─── fetchHeliusWalletFundingTrace: disabled provider degrades cleanly ──────────────────────────
{
  delete process.env.ENABLE_HELIUS_SOLANA
  const r = await fetchHeliusWalletFundingTrace(CREATOR, async () => { throw new Error('should never be called') })
  check('disabled Helius => called:false, never throws', r.called === false && r.success === false)
  process.env.ENABLE_HELIUS_SOLANA = 'true'
}

console.log(`test-solana-cluster-map.mjs: all ${passed} assertions passed`)
