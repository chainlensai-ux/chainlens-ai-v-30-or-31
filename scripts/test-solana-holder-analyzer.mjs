// TESTS — Solana Holder Analyzer (holderAnalyzer.ts). Stubbed RPC, no network.
// Added per docs/token-scanner-audit-solana-2026-08-22.md finding #9 (no dedicated test existed)
// and verifies the BigInt precision fix from finding #4 (large u64 balances previously lost
// precision via Number() before summing).

import assert from 'node:assert/strict'
import { analyzeSolanaHolders } from '../lib/server/solana/holderAnalyzer.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const RPC = 'https://example-rpc.test'
const MINT = 'Mint1111111111111111111111111111111111111'

function fetchWithLargestAccounts(rows) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (body.method === 'getTokenLargestAccounts') return { ok: true, json: async () => ({ result: { value: rows } }) }
    if (body.method === 'getTokenAccounts') return { ok: true, json: async () => ({ result: { token_accounts: [] } }) }
    throw new Error(`unexpected method: ${body.method}`)
  }
}

// ─── Ordinary balances: percentages compute correctly ──────────────────────────────────────────
{
  const rows = [
    { address: 'A1', amount: '500000', uiAmount: 0.5 },
    { address: 'A2', amount: '300000', uiAmount: 0.3 },
    { address: 'A3', amount: '200000', uiAmount: 0.2 },
  ]
  const res = await analyzeSolanaHolders({ mintAddress: MINT, rpcUrl: RPC, fetchImpl: fetchWithLargestAccounts(rows), rawSupply: 1_000_000, rawSupplyExact: '1000000' })
  check('top1Percent computes correctly for ordinary balances', res.topAccountConcentration.top1Percent === 50)
  check('top10Percent sums all rows when fewer than 10 exist', res.topAccountConcentration.top10Percent === 100)
}

// ─── Large u64 balances beyond Number.MAX_SAFE_INTEGER: precision preserved via BigInt ──────────
{
  // A supply of 10^28 base units (e.g. a high-decimal, high-total-supply memecoin) — far beyond
  // 2^53 (~9.007e15). Number(amount) would silently lose the low-order digits before summing.
  const totalSupplyExact = '10000000000000000000000000000' // 1e28
  const topHolderExact =   '5000000000000000000000000000'  // exactly half
  const rows = [
    { address: 'Whale', amount: topHolderExact },
    { address: 'Rest1', amount: '2500000000000000000000000000' },
    { address: 'Rest2', amount: '2500000000000000000000000000' },
  ]
  const res = await analyzeSolanaHolders({ mintAddress: MINT, rpcUrl: RPC, fetchImpl: fetchWithLargestAccounts(rows), rawSupply: Number(totalSupplyExact), rawSupplyExact: totalSupplyExact })
  check('large u64 balances still resolve an exact top1Percent via BigInt (50%, not a rounding artifact)', res.topAccountConcentration.top1Percent === 50)
  check('large u64 balances still resolve an exact top10Percent (100%)', res.topAccountConcentration.top10Percent === 100)
}

// ─── rawSupplyExact preferred over the lossy rawSupply number when both are present ─────────────
{
  const rows = [{ address: 'A1', amount: '1000000000000000000' }] // 1e18
  // rawSupply (the lossy Number) intentionally wrong here — rawSupplyExact must win.
  const res = await analyzeSolanaHolders({ mintAddress: MINT, rpcUrl: RPC, fetchImpl: fetchWithLargestAccounts(rows), rawSupply: 999, rawSupplyExact: '2000000000000000000' })
  check('rawSupplyExact is used over the lossy rawSupply number', res.topAccountConcentration.top1Percent === 50)
}

// ─── No largest-accounts data: honestly unavailable, never fabricated ───────────────────────────
{
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (body.method === 'getTokenLargestAccounts') return { ok: false, json: async () => ({}) }
    if (body.method === 'getTokenAccounts') return { ok: true, json: async () => ({ result: { token_accounts: [] } }) }
    throw new Error(`unexpected method: ${body.method}`)
  }
  const res = await analyzeSolanaHolders({ mintAddress: MINT, rpcUrl: RPC, fetchImpl, rawSupply: 1000, rawSupplyExact: '1000' })
  check('RPC failure => concentration honestly null, never fabricated', res.topAccountConcentration === null)
  check('evidence gap recorded on failure', res.evidenceGaps.some((g) => g.includes('could not be read')))
}

console.log(`test-solana-holder-analyzer.mjs: all ${passed} assertions passed`)
