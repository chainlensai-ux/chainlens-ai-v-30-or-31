// TESTS — Solana Dev Intelligence Phase 1: Supply Control, Watch Plan, Supply Timeline.
// Pure unit tests against the real analyzer modules (no network, no RPC stubs needed — these
// modules only transform already-gathered evidence).

import assert from 'node:assert/strict'
import { buildSolanaSupplyControl } from '../lib/server/solana/supplyControlAnalyzer.ts'
import { buildSolanaWatchPlan } from '../lib/server/solana/watchPlanAnalyzer.ts'
import { buildSolanaSupplyTimeline } from '../lib/server/solana/supplyTimelineAnalyzer.ts'
import { parseSolanaTokenExtensions, explainSolanaTokenExtension } from '../lib/server/solana/tokenExtensions.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const baseMint = { ok: true, tokenProgram: 'spl-token', decimals: 6, totalSupply: 1_000_000, rawSupply: 1_000_000_000_000, mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true, rawExtensions: null, evidenceGaps: [] }

// ─── Supply Control: revoked mint authority => fixed supply, no inflation ──────────────────────
{
  const sc = buildSolanaSupplyControl(baseMint)
  check('revoked mint authority => inflationPossible false', sc.inflationPossible === false)
  check('revoked mint authority => supply permanently fixed', sc.supplyPermanentlyFixed === true)
  check('maxSupply equals currentSupply when fixed', sc.maxSupply === sc.currentSupply && sc.maxSupply === 1_000_000)
  check('reason cites the real revoked-authority fact', /revoked/i.test(sc.inflationReason))
  check('classic spl-token has no extensions, with an explicit reason', sc.extensionExplanations.length === 1 && /classic/i.test(sc.extensionExplanations[0]))
}

// ─── Supply Control: active mint authority => inflation possible, not fixed ────────────────────
{
  const mint = { ...baseMint, mintAuthority: 'Auth1111111111111111111111111111111111111' }
  const sc = buildSolanaSupplyControl(mint)
  check('active mint authority => inflationPossible true', sc.inflationPossible === true)
  check('active mint authority => not permanently fixed', sc.supplyPermanentlyFixed === false)
  check('maxSupply is null when not fixed (no cap to report)', sc.maxSupply === null)
  check('reason cites the real active authority address', sc.inflationReason.includes('Auth1111111111111111111111111111111111111'))
}

// ─── Supply Control: authority read failed => unknown, never guessed ───────────────────────────
{
  const mint = { ...baseMint, authorityReadSucceeded: false, mintAuthority: null }
  const sc = buildSolanaSupplyControl(mint)
  check('failed authority read => inflationPossible is null (unknown), never false', sc.inflationPossible === null)
  check('failed authority read => supplyPermanentlyFixed is null, never guessed true/false', sc.supplyPermanentlyFixed === null)
}

// ─── Token-2022 extensions: transferFeeConfig and permanentDelegate parsed and explained ────────
{
  const rawExt = [
    { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 250 } } },
    { extension: 'permanentDelegate', state: { delegate: 'Deleg1111111111111111111111111111111111111' } },
  ]
  const mint = { ...baseMint, tokenProgram: 'spl-token-2022', rawExtensions: rawExt }
  const sc = buildSolanaSupplyControl(mint)
  check('two extensions parsed', sc.extensions.length === 2)
  check('transfer fee % computed from real basis points (250bps = 2.50%)', sc.extensionExplanations.some(e => e.includes('2.50%')))
  check('permanent delegate explanation cites the real delegate address', sc.extensionExplanations.some(e => e.includes('Deleg1111111111111111111111111111111111111')))
  const parsed = parseSolanaTokenExtensions(rawExt)
  check('parseSolanaTokenExtensions is independently correct', parsed.length === 2 && parsed[0].type === 'transferFeeConfig')
  check('explainSolanaTokenExtension never throws on malformed state', typeof explainSolanaTokenExtension({ type: 'unknownExt', label: 'unknownExt', state: null }) === 'string')
}

// ─── Malformed / absent extensions never fabricated ─────────────────────────────────────────────
{
  check('non-array extensions => empty list, never a guess', parseSolanaTokenExtensions('garbage').length === 0)
  check('null extensions => empty list', parseSolanaTokenExtensions(null).length === 0)
  check('array with malformed entries => malformed entries dropped, not fabricated', parseSolanaTokenExtensions([{ notAnExtension: true }, { extension: 'nonTransferable' }]).length === 1)
}

// ─── Watch Plan: every item is evidence-cited, empty list when nothing to flag ─────────────────
{
  const sc = buildSolanaSupplyControl(baseMint)
  const plan = buildSolanaWatchPlan({ supplyControl: sc, top1Percent: null, top10Percent: null, marketData: null, poolProgram: { resolved: false, poolAddress: null, owner: null, label: null, errorReason: null, verdict: 'unverified', migratedFromPumpFun: null }, deepCreator: null })
  check('no active risk signals => empty watch plan, never padded with generic advice', plan.length === 0)
}
{
  const mint = { ...baseMint, mintAuthority: 'Auth2222222222222222222222222222222222222' }
  const sc = buildSolanaSupplyControl(mint)
  const plan = buildSolanaWatchPlan({
    supplyControl: sc, top1Percent: 35.5, top10Percent: 60,
    marketData: { priceUsd: 1, liquidityUsd: 5000, volume24hUsd: 1000, fdvUsd: null, marketCapUsd: null, primaryPoolAddress: 'Pool111111111111111111111111111111111111', primaryDexLabel: 'Raydium', tokenName: null, tokenSymbol: null, pairAgeLabel: '10d', txns24h: { buys: null, sells: null }, socials: { website: null, twitter: null, telegram: null, discord: null, reddit: null } },
    poolProgram: { resolved: true, poolAddress: 'Pool111111111111111111111111111111111111', owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'PumpSwap AMM', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: true },
    deepCreator: { creatorTrace: { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'sig1', earliestTimestamp: '2024-01-01T00:00:00.000Z', likelyCreatorWallet: 'Creator11111111111111111111111111111111111', transactionSource: 'PUMP_FUN' }, errorReason: null }, evidenceGaps: [] },
  })
  check('mint authority active => watch item present, cites real address', plan.some(p => p.reason.includes('Auth2222222222222222222222222222222222222')))
  check('high top1 concentration => watch item present with real percent', plan.some(p => p.reason.includes('35.50%')))
  check('low liquidity => watch item present with real dollar figure', plan.some(p => p.reason.includes('$5,000')))
  check('pumpswap migration => watch item present', plan.some(p => p.item.includes('PumpSwap')))
  check('deep creator wallet => watch item present with real address', plan.some(p => p.reason.includes('Creator11111111111111111111111111111111111')))
}

// ─── Supply Timeline: honest gaps when deep creator not run, real event when it is ─────────────
{
  const tl = buildSolanaSupplyTimeline({ mint: baseMint, poolProgram: { resolved: false, poolAddress: null, owner: null, label: null, errorReason: null, verdict: 'unverified', migratedFromPumpFun: null }, marketData: null, deepCreator: null })
  check('no deep creator => explicit gap explaining why mint creation timestamp is unavailable', tl.reconstructionGaps.some(g => /Deep Creator Check/.test(g)))
  check('no pool => explicit gap explaining why launch/migration timing is unavailable', tl.reconstructionGaps.some(g => /pool could be verified/.test(g)))
  check('authority change history gap always present (Solana has no change log)', tl.reconstructionGaps.some(g => /no built-in log/.test(g)))
  check('current authority state still rendered as an event even with no history', tl.events.some(e => e.label.includes('Mint authority')))
}
{
  const dc = { creatorTrace: { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'sig1', earliestTimestamp: '2024-06-15T12:00:00.000Z', likelyCreatorWallet: 'Creator22222222222222222222222222222222222', transactionSource: 'PUMP_FUN' }, errorReason: null }, evidenceGaps: [] }
  const tl = buildSolanaSupplyTimeline({ mint: baseMint, poolProgram: { resolved: false, poolAddress: null, owner: null, label: null, errorReason: null, verdict: 'unverified', migratedFromPumpFun: null }, marketData: null, deepCreator: dc })
  check('deep creator success => real timestamped event, no fabrication', tl.events.some(e => e.timestamp === '2024-06-15T12:00:00.000Z'))
  check('mint creation gap is NOT present once deep creator resolved it', !tl.reconstructionGaps.some(g => /Deep Creator Check.*not run/.test(g)))
}

console.log(`test-solana-supply-control.mjs: all ${passed} assertions passed`)
