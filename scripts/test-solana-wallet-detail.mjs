// TESTS — Solana Cluster Map "click a node" wallet detail (walletDetailAnalyzer.ts +
// app/api/solana-wallet-detail/route.ts). Stubbed fetch, no network.

import assert from 'node:assert/strict'
import { fetchSolanaWalletSnapshot } from '../lib/server/solana/walletDetailAnalyzer.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const RPC = 'https://example-rpc.test'
const ADDR = 'Wallet11111111111111111111111111111111111'

// ─── Both balance and last activity resolve from real RPC responses ────────────────────────────
{
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (body.method === 'getBalance') return { ok: true, json: async () => ({ result: { value: 1_500_000_000 } }) }
    if (body.method === 'getSignaturesForAddress') return { ok: true, json: async () => ({ result: [{ signature: 'sig1', blockTime: 1700000000 }] }) }
    throw new Error(`unexpected method: ${body.method}`)
  }
  const snap = await fetchSolanaWalletSnapshot(ADDR, RPC, fetchImpl)
  check('balance resolves to real SOL amount (1.5 SOL from 1_500_000_000 lamports)', snap.balanceResolved === true && snap.balanceSol === 1.5)
  check('last activity resolves to the real signature and timestamp', snap.lastActivityResolved === true && snap.lastActivitySignature === 'sig1' && snap.lastActivityTimestamp === '2023-11-14T22:13:20.000Z')
  check('no error reason when both resolve', snap.errorReason === null)
}

// ─── No signature history => honestly unresolved, never fabricated ─────────────────────────────
{
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)
    if (body.method === 'getBalance') return { ok: true, json: async () => ({ result: { value: 0 } }) }
    if (body.method === 'getSignaturesForAddress') return { ok: true, json: async () => ({ result: [] }) }
    throw new Error(`unexpected method: ${body.method}`)
  }
  const snap = await fetchSolanaWalletSnapshot(ADDR, RPC, fetchImpl)
  check('zero balance still resolves as a real 0, not unavailable', snap.balanceResolved === true && snap.balanceSol === 0)
  check('no signature history => lastActivityResolved is false, never fabricated', snap.lastActivityResolved === false && snap.lastActivitySignature === null)
}

// ─── RPC failure degrades cleanly, never throws ─────────────────────────────────────────────────
{
  const fetchImpl = async () => { throw new Error('network down') }
  const snap = await fetchSolanaWalletSnapshot(ADDR, RPC, fetchImpl)
  check('RPC failure => both fields honestly unresolved, never a crash', snap.balanceResolved === false && snap.lastActivityResolved === false)
  check('RPC failure carries an error reason', typeof snap.errorReason === 'string' && snap.errorReason.length > 0)
}

// ─── Route source-shape checks: real address validation, real RPC config gating ────────────────
{
  const fs = await import('node:fs')
  const route = fs.readFileSync(new URL('../app/api/solana-wallet-detail/route.ts', import.meta.url), 'utf8')
  check('route gates on isSolanaChainAvailable, same contract as the mint-scan path', route.includes('isSolanaChainAvailable()'))
  check('route validates the address with the real shared validator, not a new heuristic', route.includes('isValidSolanaMintAddress(address)'))
  check('route calls the real fetchSolanaWalletSnapshot, never fabricates a response', route.includes('fetchSolanaWalletSnapshot(address, rpcUrl, fetch)'))
}

console.log(`test-solana-wallet-detail.mjs: all ${passed} assertions passed`)
