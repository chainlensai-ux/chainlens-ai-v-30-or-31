// TESTS — Solana Dev Intelligence engine: the full Cluster Map intelligence graph
// (creator + two-hop funding + authorities + pool + top holders + LP vaults + owner resolution +
// recent-launch sample + real confidence/risk engines). Stubs fetchImpl so real logic runs with
// zero network access, no API keys.

import assert from 'node:assert/strict'
import { analyzeSolanaCluster } from '../lib/server/solana/clusterAnalyzer.ts'
import { fetchHeliusWalletFundingTrace, fetchHeliusCreatorRecentLaunches } from '../lib/server/solanaProviders.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

process.env.ENABLE_HELIUS_SOLANA = 'true'
process.env.HELIUS_API_KEY = 'test-key'

const MINT = 'Mint1111111111111111111111111111111111111'
const CREATOR = 'Creator111111111111111111111111111111111'
const FUNDER = 'Funder111111111111111111111111111111111'
const FUNDER2 = 'Funder211111111111111111111111111111111'
const POOL = 'Pool111111111111111111111111111111111111'
const RPC = 'https://stub-rpc.test'

const NO_POOL = { resolved: false, poolAddress: null, owner: null, label: null, errorReason: null, verdict: 'unverified', migratedFromPumpFun: null }
const PUMPSWAP_POOL = { resolved: true, poolAddress: POOL, owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'PumpSwap AMM', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: true }

function resolvedCreatorTrace(overrides = {}) {
  return { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'mint_sig', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: CREATOR, transactionSource: 'PUMP_FUN' }, errorReason: null, ...overrides }
}

// Rich, address-keyed stub: signature pages per wallet, enhanced parses per signature set,
// getMultipleAccounts owners per ATA.
function richStub({ sigPagesByAddress = {}, enhancedByFirstSig = {}, ataOwners = {} }) {
  return async (url, opts) => {
    if (typeof url === 'string' && url.includes('mainnet.helius-rpc.com')) {
      const body = JSON.parse(opts.body)
      if (body.method === 'getSignaturesForAddress') {
        const addr = body.params[0]
        const pages = sigPagesByAddress[addr] ?? []
        // one page per call, consumed in order
        const page = pages.shift() ?? []
        return { ok: true, json: async () => ({ result: page }) }
      }
      throw new Error(`unexpected helius rpc method: ${body.method}`)
    }
    if (typeof url === 'string' && url.includes('api.helius.xyz/v0/transactions')) {
      const body = JSON.parse(opts.body)
      const firstSig = body.transactions[0]
      const parsed = enhancedByFirstSig[firstSig]
      if (!parsed) throw new Error(`no enhanced stub for signature: ${firstSig}`)
      return { ok: true, json: async () => parsed }
    }
    if (typeof url === 'string' && url === RPC) {
      const body = JSON.parse(opts.body)
      if (body.method === 'getMultipleAccounts') {
        const addrs = body.params[0]
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: addrs.map((a) => (ataOwners[a] ? { data: { parsed: { info: { owner: ataOwners[a] } } } } : null)) } }) }
      }
      throw new Error(`unexpected rpc method: ${body.method}`)
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

// ─── No creator wallet AND no other evidence => honest empty graph, unknown risk ───────────────
{
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT,
    creatorTrace: { called: true, success: false, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: null, earliestTimestamp: null, likelyCreatorWallet: null, transactionSource: null }, errorReason: 'no_signature_history_found' },
    mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: false, poolProgram: NO_POOL,
    fetchImpl: async () => { throw new Error('should never be called') },
  })
  check('deep check ran => attempted is true even when nothing resolved', cm.attempted === true)
  check('no creator => creatorResolved false', cm.creatorResolved === false)
  check('nothing resolved => honest "no verified relationships" message, never "not supported"', cm.summary === 'No verified wallet relationships found.')
  check('nothing resolved => evidenceCount 0, confidence none', cm.evidenceCount === 0 && cm.clusterConfidence === 'none')
  check('under 2 real risk signals => risk is genuinely unknown, with the reason naming the missing signals', cm.riskLevel === 'unknown' && /signals/i.test(cm.riskReason))
  check('unresolved relationships are disclosed with concrete reasons (update authority, labels, cross-mint)', cm.unresolvedRelationships.length >= 3 && cm.unresolvedRelationships.every((u) => u.reason.length > 20))
}

// ─── No creator, but authorities + pool + holders exist => a real graph is still built ─────────
{
  const fetchImpl = richStub({ ataOwners: { Ata111111111111111111111111111111111111: 'Whale11111111111111111111111111111111111' } })
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT,
    creatorTrace: { called: true, success: false, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: false, resolved: { earliestSignature: null, earliestTimestamp: null, likelyCreatorWallet: null, transactionSource: null }, errorReason: 'x' },
    mintAuthority: 'MintAuth11111111111111111111111111111111', freezeAuthority: null, authorityReadSucceeded: true,
    poolProgram: PUMPSWAP_POOL, fetchImpl, rpcUrl: RPC,
    topAccounts: [{ rank: 1, address: 'Ata111111111111111111111111111111111111', amountRaw: '100', percentOfSupply: 12 }],
  })
  check('authorities/pool/holders build a real graph even without a creator wallet', cm.nodes.some((n) => n.role === 'mint_authority') && cm.nodes.some((n) => n.role === 'lp_pool') && cm.nodes.some((n) => n.role === 'top_holder'))
  check('evidence exists without a creator => evidenceCount > 0, never forced to zero', cm.evidenceCount > 0)
  check('confidence factors explain the missing creator honestly', cm.confidenceFactors.some((f) => /no creator wallet resolved/i.test(f)))
}

// ─── The full graph: creator + 2 funding hops + authorities + pool + holders + vault + launches ─
function fullGraphStub() {
  return richStub({
    sigPagesByAddress: {
      // creator: funding-trace pagination (1 page, reaches genesis) THEN recent-launches page (newest-first)
      [CREATOR]: [
        [{ signature: 'creator_earliest', blockTime: 1690000000 }],
        [{ signature: 'launch_tx_1' }, { signature: 'launch_tx_2' }, { signature: 'launch_tx_3' }, { signature: 'other_tx' }],
      ],
      // hop-2 trace on the funder
      [FUNDER]: [[{ signature: 'funder_earliest', blockTime: 1680000000 }]],
    },
    enhancedByFirstSig: {
      creator_earliest: [{ nativeTransfers: [{ fromUserAccount: FUNDER, toUserAccount: CREATOR, amount: 2_000_000_000 }] }],
      funder_earliest: [{ nativeTransfers: [{ fromUserAccount: FUNDER2, toUserAccount: FUNDER, amount: 5_000_000_000 }] }],
      launch_tx_1: [
        { signature: 'launch_tx_1', type: 'TOKEN_MINT', source: 'PUMP_FUN', timestamp: 1691000000, tokenTransfers: [{ mint: 'PriorMint1111111111111111111111111111111' }] },
        { signature: 'launch_tx_2', type: 'CREATE', source: 'PUMP_FUN', timestamp: 1691000100, tokenTransfers: [{ mint: 'PriorMint2111111111111111111111111111111' }] },
        { signature: 'launch_tx_3', type: 'TOKEN_MINT', source: 'PUMP_FUN', timestamp: 1691000200, tokenTransfers: [{ mint: MINT }] }, // the scanned mint's own creation — must be excluded
        { signature: 'other_tx', type: 'SWAP', source: 'RAYDIUM', timestamp: 1691000300 },
      ],
    },
    ataOwners: {
      VaultAta11111111111111111111111111111111: POOL,      // pool-owned => real LP vault
      WhaleAta11111111111111111111111111111111: 'Whale11111111111111111111111111111111111',
      CreatorAta111111111111111111111111111111: CREATOR,   // creator insider holding
      OrphanAta1111111111111111111111111111111: undefined, // owner unresolvable
    },
  })
}
const fullTopAccounts = [
  { rank: 1, address: 'VaultAta11111111111111111111111111111111', amountRaw: '500', percentOfSupply: 50 },
  { rank: 2, address: 'WhaleAta11111111111111111111111111111111', amountRaw: '80', percentOfSupply: 8 },
  { rank: 3, address: 'CreatorAta111111111111111111111111111111', amountRaw: '60', percentOfSupply: 6 },
  { rank: 4, address: 'OrphanAta1111111111111111111111111111111', amountRaw: '10', percentOfSupply: 1 },
]
{
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT, creatorTrace: resolvedCreatorTrace(),
    mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true,
    poolProgram: PUMPSWAP_POOL, fetchImpl: fullGraphStub(), rpcUrl: RPC, topAccounts: fullTopAccounts,
  })
  check('the full graph commonly exceeds 10 nodes when evidence exists', cm.nodes.length >= 10)
  check('two real funding hops resolved: funder2 -> funder -> creator', cm.fundingPath[0] === FUNDER2 && cm.fundingPath[1] === FUNDER && cm.fundingPath[2] === CREATOR && cm.fundingDepth === 2)
  check('pool-owned token account becomes an LP-vault node, never a whale', cm.nodes.some((n) => n.role === 'lp_vault') && cm.edges.some((e) => e.relationship === 'vault_of'))
  check('the 50% vault account is EXCLUDED from vault-adjusted concentration', cm.vaultAdjustedTop1Percent != null && cm.vaultAdjustedTop1Percent < 50)
  check('a creator-owned top account merges into the creator node as a verified insider holding (no duplicate node)', cm.nodes.filter((n) => n.address === CREATOR).length === 1 && cm.nodes.find((n) => n.address === CREATOR).evidence.some((e) => /ALSO holds/i.test(e)))
  check('creator insider holding >=5% raises an elevated risk factor', cm.riskFactors.some((f) => /insider holding/i.test(f)))
  check('unresolvable-owner account is shown by its account address with the honest reason', cm.nodes.some((n) => n.role === 'top_holder' && /could not be resolved/i.test(n.evidence.join(' '))))
  check('prior-launch nodes come from the recent sample with sample-scoped evidence', cm.nodes.filter((n) => n.role === 'prior_mint').length === 2 && cm.nodes.filter((n) => n.role === 'prior_mint').every((n) => /sample/i.test(n.evidence.join(' '))))
  check('the scanned mint\'s own creation event is never counted as a prior launch', !cm.nodes.some((n) => n.role === 'prior_mint' && n.address === MINT))
  check('prior_launch edges connect the creator to each prior mint', cm.edges.filter((e) => e.relationship === 'prior_launch' && e.from === CREATOR).length === 2)
  check('holds_supply edges carry the real percent evidence', cm.edges.some((e) => e.relationship === 'holds_supply' && /8\.00%/.test(e.evidence)))
  check('confidence is high: 8+ relationships, genesis reached, owner resolution + vault agreement', cm.clusterConfidence === 'high')
  check('confidence factors cite the real cross-provider vault agreement', cm.confidenceFactors.some((f) => /cross-provider/i.test(f)))
  check('healthy funding + revoked authorities + vault-adjusted concentration => risk factors include standard reads', cm.riskFactors.some((f) => /revoked/i.test(f)))
  check('every node has at least one real evidence string', cm.nodes.every((n) => n.evidence.length > 0 && n.evidence.every((e) => typeof e === 'string' && e.length > 0)))
  check('every edge id is unique', new Set(cm.edges.map((e) => e.id)).size === cm.edges.length)

  // ── supplyPercent, DISCLOSED: added so the Dev tab's bubblemap can size a bubble by a wallet's
  // REAL share of supply instead of a decorative constant. The honesty rule this must hold to is
  // that null means "not applicable or not measured", never "holds zero" — a bubble sized off a
  // fabricated 0 would silently assert a fact the scan never established.
  const vaultNode = cm.nodes.find((n) => n.role === 'lp_vault')
  const whaleNode = cm.nodes.find((n) => n.address === 'WhaleAta11111111111111111111111111111111' || (n.role === 'top_holder' && n.supplyPercent === 8))
  check('the LP vault node carries its real measured share (50%), matching its own evidence text', vaultNode.supplyPercent === 50)
  check('a top-holder node carries its real measured share (8%)', whaleNode != null && whaleNode.supplyPercent === 8)
  check('the creator node, which entered the graph before its holdings were known, is back-filled with its real 6% share', cm.nodes.find((n) => n.address === CREATOR).supplyPercent === 6)
  check('the scanned mint itself has a NULL share — it holds none of its own supply, and null is never rendered as 0%', cm.nodes.find((n) => n.role === 'mint').supplyPercent === null)
  check('prior-launch nodes (a different token entirely) carry null, not a fabricated share of THIS supply', cm.nodes.filter((n) => n.role === 'prior_mint').every((n) => n.supplyPercent === null))
  check('no node ever reports a negative share', cm.nodes.every((n) => n.supplyPercent === null || n.supplyPercent >= 0))
  check('every node defines supplyPercent explicitly — a missing field would size a bubble off undefined', cm.nodes.every((n) => 'supplyPercent' in n))
  check('a measured share always agrees with the percent cited in that node\'s own evidence', cm.nodes.filter((n) => n.supplyPercent != null).every((n) => n.evidence.join(' ').includes(`${n.supplyPercent.toFixed(2)}%`)))
}

// ─── Serial-launch pattern (3+ launch events in sample) => elevated, sample-scoped wording ──────
{
  const stub = richStub({
    sigPagesByAddress: {
      [CREATOR]: [
        [{ signature: 'creator_earliest', blockTime: 1690000000 }],
        [{ signature: 'launch_a' }],
      ],
      [FUNDER]: [[]],
    },
    enhancedByFirstSig: {
      creator_earliest: [{ nativeTransfers: [{ fromUserAccount: FUNDER, toUserAccount: CREATOR, amount: 2_000_000_000 }] }],
      launch_a: [
        { signature: 'la', type: 'TOKEN_MINT', source: 'PUMP_FUN', timestamp: 1, tokenTransfers: [{ mint: 'PM111111111111111111111111111111111111111' }] },
        { signature: 'lb', type: 'TOKEN_MINT', source: 'PUMP_FUN', timestamp: 2, tokenTransfers: [{ mint: 'PM211111111111111111111111111111111111111' }] },
        { signature: 'lc', type: 'CREATE', source: 'PUMP_FUN', timestamp: 3, tokenTransfers: [{ mint: 'PM311111111111111111111111111111111111111' }] },
      ],
    },
  })
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT, creatorTrace: resolvedCreatorTrace(),
    mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true,
    poolProgram: NO_POOL, fetchImpl: stub,
  })
  check('3+ launch-shaped events => elevated serial-launch risk factor, sample-scoped wording', cm.riskLevel === 'elevated' && cm.riskFactors.some((f) => /serial-launch/i.test(f) && /sample/i.test(f)))
}

// ─── Fresh/low SOL funding => elevated risk, real evidence-cited reason ─────────────────────────
{
  const stub = richStub({
    sigPagesByAddress: { [CREATOR]: [[{ signature: 'creator_earliest', blockTime: 1690000000 }], [] ] },
    enhancedByFirstSig: { creator_earliest: [{ nativeTransfers: [{ fromUserAccount: FUNDER, toUserAccount: CREATOR, amount: 10_000_000 }] }] },
  })
  // hop2 trace on FUNDER will find no history (empty page)
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT, creatorTrace: resolvedCreatorTrace({ resolved: { ...resolvedCreatorTrace().resolved, transactionSource: null } }),
    mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true,
    poolProgram: NO_POOL, fetchImpl: stub,
  })
  check('0.01 SOL funding is below the 0.05 threshold => elevated risk', cm.riskLevel === 'elevated')
  check('elevated risk reason cites the real SOL amount', cm.riskReason.includes('0.0100 SOL'))
  check('creator wallet node risk mirrors the elevated funding-pattern read', cm.nodes.find((n) => n.role === 'creator_wallet').risk === 'elevated')
  check('funding wallet node itself is flagged elevated too (rent-level funding amount)', cm.nodes.find((n) => n.role === 'funding_wallet').risk === 'elevated')
}

// ─── Funding trace fails cleanly => fee-payer edge only, honest partial, no fabricated funder ───
{
  const stub = richStub({ sigPagesByAddress: { [CREATOR]: [[], []] } })
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT, creatorTrace: resolvedCreatorTrace(),
    mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true,
    poolProgram: NO_POOL, fetchImpl: stub,
  })
  check('funding trace found no history => only the fee-payer edge, never fabricated', cm.evidenceCount === 1 && !cm.nodes.some((n) => n.role === 'funding_wallet'))
  check('thin evidence => clusterConfidence low, not none (the fee-payer edge is real)', cm.clusterConfidence === 'low')
  check('fundingDepth 0 with no verified hop', cm.fundingDepth === 0)
}

// ─── Shared authority: the creator still holding mint authority merges into ONE node ────────────
{
  const stub = richStub({ sigPagesByAddress: { [CREATOR]: [[], []] } })
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT, creatorTrace: resolvedCreatorTrace(),
    mintAuthority: CREATOR, freezeAuthority: CREATOR, authorityReadSucceeded: true,
    poolProgram: NO_POOL, fetchImpl: stub,
  })
  check('creator === mint authority === freeze authority merges into one node (address equality, never a duplicate)', cm.nodes.filter((n) => n.address === CREATOR).length === 1)
  check('the merged node carries the SHARED ROLE evidence for both authorities', cm.nodes.find((n) => n.address === CREATOR).evidence.filter((e) => /SHARED ROLE/.test(e)).length === 2)
  check('both authority edges still connect the merged node to the mint', cm.edges.some((e) => e.relationship === 'mint_authority' && e.from === CREATOR) && cm.edges.some((e) => e.relationship === 'freeze_authority' && e.from === CREATOR))
  check('a merged elevated role escalates the node risk', cm.nodes.find((n) => n.address === CREATOR).risk === 'elevated')
  check('active authorities => elevated cluster risk', cm.riskLevel === 'elevated')
}

// ─── Revoked authorities / unresolved pool / no holder data never fabricate nodes ───────────────
{
  const stub = richStub({ sigPagesByAddress: { [CREATOR]: [[], []] } })
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT, creatorTrace: resolvedCreatorTrace(),
    mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true,
    poolProgram: NO_POOL, fetchImpl: stub,
  })
  check('revoked authorities => no authority nodes fabricated', !cm.nodes.some((n) => n.role === 'mint_authority' || n.role === 'freeze_authority'))
  check('unresolved pool => no lp_pool node fabricated', !cm.nodes.some((n) => n.role === 'lp_pool'))
  check('no topAccounts passed => no holder/vault nodes fabricated', !cm.nodes.some((n) => n.role === 'top_holder' || n.role === 'lp_vault'))
  check('no holder data => vaultAdjustedTop1Percent stays null, never a fabricated 0', cm.vaultAdjustedTop1Percent === null)
}

// ─── Owner-resolution RPC failure degrades honestly (account addresses shown, disclosed) ────────
{
  const stub = async (url, opts) => {
    if (typeof url === 'string' && url.includes('mainnet.helius-rpc.com')) return { ok: true, json: async () => ({ result: [] }) }
    if (typeof url === 'string' && url === RPC) return { ok: false, status: 500, json: async () => ({}) }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const cm = await analyzeSolanaCluster({
    mintAddress: MINT, creatorTrace: resolvedCreatorTrace(),
    mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true,
    poolProgram: NO_POOL, fetchImpl: stub, rpcUrl: RPC,
    topAccounts: [{ rank: 1, address: 'AtaX11111111111111111111111111111111111', amountRaw: '10', percentOfSupply: 3 }],
  })
  check('owner-read failure => holder node shows the account address with the failure disclosed', cm.nodes.some((n) => n.role === 'top_holder' && /owner read failed/i.test(n.evidence.join(' '))))
  check('owner-read failure is reported in ownerResolution', cm.ownerResolution.attempted === true && cm.ownerResolution.errorReason != null)
  check('confidence factors disclose the failed owner resolution', cm.confidenceFactors.some((f) => /owner resolution failed/i.test(f)))
}

// ─── fetchHeliusCreatorRecentLaunches: provider-level honesty ───────────────────────────────────
{
  delete process.env.ENABLE_HELIUS_SOLANA
  const r = await fetchHeliusCreatorRecentLaunches(CREATOR, MINT, async () => { throw new Error('never') })
  check('disabled Helius => recent launches called:false, never throws', r.called === false && r.success === false)
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  const r2 = await fetchHeliusCreatorRecentLaunches(CREATOR, MINT, async (url) => {
    if (url.includes('mainnet.helius-rpc.com')) return { ok: true, json: async () => ({ result: [] }) }
    throw new Error('should not parse with no signatures')
  })
  check('no signatures => success with zero events, sampleOnly permanently true', r2.success === true && r2.events.length === 0 && r2.sampleOnly === true)
}

// ─── fetchHeliusWalletFundingTrace: disabled provider degrades cleanly ──────────────────────────
{
  delete process.env.ENABLE_HELIUS_SOLANA
  const r = await fetchHeliusWalletFundingTrace(CREATOR, async () => { throw new Error('should never be called') })
  check('disabled Helius => called:false, never throws', r.called === false && r.success === false)
  process.env.ENABLE_HELIUS_SOLANA = 'true'
}

console.log(`test-solana-cluster-map.mjs: all ${passed} assertions passed`)
