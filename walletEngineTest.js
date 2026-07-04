#!/usr/bin/env node
// walletEngineTest.js — manual test harness for the new Base-capable engine routes:
// /api/transactions, /api/pnl, /api/wallet-profile.
//
// DISCLOSED DEVIATIONS FROM THE LITERAL SPEC (verified against the real route files before writing
// this — app/api/{transactions,pnl,wallet-profile}/route.ts):
//
// 1. METHOD: the spec asked for GET with query params (?walletAddress=...&chains=base). All three
//    real routes only export POST and read {walletAddress, chains} from a JSON body — there is no
//    GET handler on any of them. This harness calls them with POST + a JSON body instead; a plain
//    GET would hit Next's default 405 for an unimplemented method, not real data.
//
// 2. FIELD NAMES that don't exist on the real response, replaced with what's actually there:
//    - /api/pnl: there is no `realized.summary.totalRealizedPnlUsd` — the real field on
//      RealizedPnlSummary (src/modules/realizedPnl/pnlSummary.ts) is `totalRealizedPnl` (no "Usd"
//      suffix). There is also no top-level `unresolvedHoldings` array — it's nested per chain at
//      `unrealized.perChain[i].unresolvedHoldings`; this harness logs the sum of those lengths.
//    - /api/transactions: TradeEntry (lib/engines/tradeTimelineEngineV2.ts) has `tokenAddress`, not
//      `token` — logged as tokenAddress.
//    - /api/wallet-profile: PortfolioSummary's TokenListEntry (src/modules/portfolio/types.ts) has
//      `amount`, not `balance`, and has NO `costBasisUsd`/`pnlUsd` field at all — a portfolio token
//      is a current holding, not a PnL record. Real per-token cost basis / realized-or-unrealized PnL
//      lives separately, keyed by chain + tokenAddress (not symbol), inside
//      `perChain[i].unrealizedPnl.tokens` / `perChain[i].realizedPnl` in that same response. This
//      harness logs both: the real portfolio fields, and a best-effort cross-reference against
//      perChain[i].unrealizedPnl.tokens by contract address for the same 3 tokens, clearly labeled.
//
// Uses only Node 18+ native `fetch` — no dependencies required. dotenv is loaded opportunistically
// (via require, in a try/catch) if it happens to be installed; the script works fine without it as
// long as the env vars below are set some other way (shell export, CI secret, etc.) or the hardcoded
// defaults are acceptable for a quick manual run.

try { require('dotenv').config() } catch { /* dotenv not installed — fine, env vars may come from elsewhere */ }

const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '0xf85679316f1c3998c6387f6f707b31aeeb3a9abe'
const BASE_URL = (process.env.BASE_URL || 'https://your-deployment-url-here').replace(/\/$/, '')
const CHAINS = ['base']

if (typeof fetch !== 'function') {
  console.error('This script requires Node 18+ (native fetch). Upgrade Node, or add node-fetch and require it here.')
  process.exit(1)
}

async function callRoute(path) {
  const url = `${BASE_URL}${path}`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: WALLET_ADDRESS, chains: CHAINS }),
    })
  } catch (err) {
    console.error(`[${path}] network error: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    // non-JSON body — leave body null, status is still reported below
  }

  if (!res.ok) {
    console.error(`[${path}] HTTP ${res.status}`)
    if (body) console.error(`[${path}] error body:`, JSON.stringify(body, null, 2))
    return null
  }

  return body
}

function logTransactions(data) {
  console.log('\n=== /api/transactions ===')
  if (!data) return
  console.log('chainsAttempted:', data.chainsAttempted)
  console.log('chainsUnsupported:', data.chainsUnsupported)
  const transactions = Array.isArray(data.transactions) ? data.transactions : []
  console.log('transactions.length:', transactions.length)
  console.log('first 3 transactions:')
  for (const tx of transactions.slice(0, 3)) {
    // real TradeEntry field is tokenAddress, not "token" — see file header disclosure
    console.log(`  tokenAddress=${tx.tokenAddress} type=${tx.type} timestamp=${tx.timestamp}`)
  }
}

function logPnl(data) {
  console.log('\n=== /api/pnl ===')
  if (!data) return
  // real field is totalRealizedPnl, not totalRealizedPnlUsd — see file header disclosure
  console.log('realized.summary.totalRealizedPnl:', data.realized?.summary?.totalRealizedPnl)
  console.log('unrealized.totalUnrealizedPnlUsd:', data.unrealized?.totalUnrealizedPnlUsd)
  const perChain = Array.isArray(data.unrealized?.perChain) ? data.unrealized.perChain : []
  const totalUnresolvedHoldings = perChain.reduce((sum, c) => sum + (c.unresolvedHoldings?.length ?? 0), 0)
  console.log('unresolvedHoldings.length (summed across all chains — no single top-level array exists):', totalUnresolvedHoldings)
  console.log('perChain[0].result.tokens (first 3):')
  for (const t of (perChain[0]?.result?.tokens ?? []).slice(0, 3)) {
    console.log(`  tokenAddress=${t.tokenAddress} amount=${t.amount} costBasisUsd=${t.costBasisUsd} currentValueUsd=${t.currentValueUsd} unrealizedPnlUsd=${t.unrealizedPnlUsd} confidence=${t.confidence}`)
  }
}

function logWalletProfile(data) {
  console.log('\n=== /api/wallet-profile ===')
  if (!data) return
  const portfolio = data.portfolio ?? {}
  console.log('portfolio.totalValueUsd:', portfolio.totalValueUsd)
  const tokens = Array.isArray(portfolio.tokens) ? portfolio.tokens : []
  console.log('portfolio.tokens.length:', tokens.length)

  // Cross-reference for cost basis / PnL: portfolio.tokens itself has no such fields (see file
  // header disclosure) — real per-token cost basis/PnL lives in perChain[i].unrealizedPnl.tokens,
  // keyed by contract address.
  const unrealizedTokensByContract = new Map()
  for (const chainResult of data.perChain ?? []) {
    for (const t of chainResult.unrealizedPnl?.tokens ?? []) {
      unrealizedTokensByContract.set(t.tokenAddress?.toLowerCase(), t)
    }
  }

  console.log('first 3 tokens (symbol, balance, valueUsd — real portfolio fields; costBasisUsd/pnlUsd cross-referenced from perChain[i].unrealizedPnl.tokens where available, else "n/a"):')
  for (const t of tokens.slice(0, 3)) {
    const match = unrealizedTokensByContract.get(t.contract?.toLowerCase())
    const costBasisUsd = match ? match.costBasisUsd : 'n/a (no matching open FIFO lot / not in perChain results)'
    const pnlUsd = match ? match.unrealizedPnlUsd : 'n/a (no matching open FIFO lot / not in perChain results)'
    console.log(`  symbol=${t.symbol} balance=${t.amount} valueUsd=${t.valueUsd} costBasisUsd=${costBasisUsd} pnlUsd=${pnlUsd}`)
  }
}

async function main() {
  console.log(`Testing wallet ${WALLET_ADDRESS} against ${BASE_URL} (chains=${CHAINS.join(',')})`)

  const [transactions, pnl, walletProfile] = await Promise.all([
    callRoute('/api/transactions'),
    callRoute('/api/pnl'),
    callRoute('/api/wallet-profile'),
  ])

  logTransactions(transactions)
  logPnl(pnl)
  logWalletProfile(walletProfile)

  const anyFailed = transactions === null || pnl === null || walletProfile === null
  if (anyFailed) {
    console.error('\nOne or more routes failed — see errors above.')
    process.exit(1)
  }
  console.log('\nAll 3 routes returned 200 OK.')
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
