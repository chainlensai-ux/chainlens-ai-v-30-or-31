// ROBINHOOD WALLET SCANNER PHASE 3 — LIVE VERIFICATION SCRIPT, DISCLOSED.
//
// WHY THIS EXISTS: the task asked for live/staging verification of Phase 3 (real Uniswap V4 swap
// decoding + gated PnL) against a real Robinhood RPC and real wallets. This sandbox has neither —
// no ALCHEMY_ROBINHOOD_RPC_URL/ENABLE_ROBINHOOD_CHAIN configured here, and this session's egress
// proxy denies CONNECT to robinhoodchain.blockscout.com and any other host outside its allowlist
// (confirmed: 403 connect_rejected — see the agent-proxy status output cited in this task's report).
// There is no way to reach a live/staging Robinhood RPC, Alchemy, or GoldRush from this environment.
//
// What WAS verified live from this sandbox instead (see the task's chat report for the full
// transcript): a real, unmocked GET /api/wallet-scan/robinhood round trip through the actual
// Next.js production route, in two real states —
//   1. Robinhood Chain not configured at all: every field honestly reports "not_configured",
//      pnlStatus "disabled", verifiedSwapCount 0, swapDecodeStatus "built_no_verified_swaps".
//   2. Robinhood Chain "configured" with an invalid Alchemy RPC URL / GoldRush key (the closest
//      approximation of a real provider failure reachable here): every field honestly reports
//      "unavailable" with a real reason string, never a fake balance/swap/PnL.
// Both are real, non-fabricated HTTP round trips through the shipped Phase 3 code — not unit tests.
//
// This script is the remaining piece: run it from an environment that DOES have a real, working
// ALCHEMY_ROBINHOOD_RPC_URL and GOLDRUSH_API_KEY (staging or prod), against real wallet addresses
// with known Robinhood Chain activity, to complete checks 2-4 from the task. It performs NO scoring
// of its own and computes NOTHING — it only calls the real route and prints back exactly what the
// route itself decided, so it can never launder a fake "verified" result.
//
// Usage:
//   ROBINHOOD_LIVE_VERIFY_BASE_URL=https://staging.chainlens.example \
//   ROBINHOOD_LIVE_VERIFY_TOKEN=<a real bearer token for a Pro/Elite account, or omit if the
//     deployment has BETA_ALL_ELITE=true and still requires a token to hit that branch> \
//   ROBINHOOD_LIVE_VERIFY_WALLETS=0xabc...,0xdef...,0x123... \
//     node scripts/robinhood-phase3-live-verify.mjs
//
// Wallet addresses are read from ROBINHOOD_LIVE_VERIFY_WALLETS (comma-separated) or CLI args.

const baseUrl = (process.env.ROBINHOOD_LIVE_VERIFY_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const token = process.env.ROBINHOOD_LIVE_VERIFY_TOKEN ?? ''
const wallets = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : (process.env.ROBINHOOD_LIVE_VERIFY_WALLETS ?? '').split(','))
  .map((w) => w.trim())
  .filter(Boolean)

if (wallets.length === 0) {
  console.error('No wallets provided. Set ROBINHOOD_LIVE_VERIFY_WALLETS=0x...,0x... or pass addresses as CLI args.')
  process.exit(1)
}
if (wallets.length > 10) {
  console.error(`Refusing to run against ${wallets.length} wallets in one pass — keep it to the 3-5 the task asked for (bounded, deliberate sample).`)
  process.exit(1)
}

function summarizeSwapAudit(a) {
  return {
    txHash: a.txHash,
    decodedSwap: a.decodedSwap,
    confidence: a.confidence,
    tokenIn: a.tokenIn,
    tokenOut: a.tokenOut,
    quoteLeg: a.quoteLeg,
    priceEvidence: a.priceEvidence,
    rejectedReason: a.rejectedReason,
  }
}

async function verifyWallet(address) {
  const url = `${baseUrl}/api/wallet-scan/robinhood?address=${encodeURIComponent(address)}`
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    return { wallet: address, providerError: `request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.ok) {
    return { wallet: address, providerError: json?.error?.message ?? `HTTP ${res.status}` }
  }

  const { activity, pnl, robinhoodWalletScannerAudit: audit } = json

  // DECODED-SWAP SAMPLES, DISCLOSED: printed straight from the real per-log audit array the route
  // already returns (activity.swapDecodeAudits) — never recomputed or reinterpreted here.
  const decodedSamples = (activity?.swapDecodeAudits ?? []).filter((a) => a.decodedSwap).map(summarizeSwapAudit)
  const missingPriceEvidence = (activity?.swapDecodeAudits ?? [])
    .filter((a) => a.decodedSwap && a.priceEvidence === false)
    .map(summarizeSwapAudit)

  return {
    wallet: address,
    routeStatus: json.ok === true ? 'ok' : 'not_ok',
    chainId: json.chainId,
    // PROVIDER STATUS/ERRORS, DISCLOSED: holdings.status/activity.status are the route's own real,
    // measured outcome for each leg (never guessed here) — reason fields are the real provider-level
    // cause (e.g. 'http_error', 'rate_limited', 'no_data', 'rpc_timeout') the route itself recorded.
    holdingsStatus: json.holdings?.status,
    activityStatus: activity?.status,
    nativeBalanceStatus: audit?.nativeBalanceStatus,
    tokenBalanceStatus: audit?.tokenBalanceStatus,
    pricingStatus: audit?.pricingStatus,
    providerErrors: [json.holdings?.reason, activity?.reason].filter(Boolean),
    verifiedSwapCount: activity?.verifiedSwapCount ?? 0,
    skippedSwapLogs: activity?.skippedSwapLogs ?? 0,
    swapDecodeStatus: audit?.swapDecodeStatus,
    pnlStatus: pnl?.status,
    pnlMessage: pnl?.message,
    disabledPnlReason: audit?.disabledPnlReason ?? null,
    realizedPnlUsd: pnl?.realizedPnlUsd ?? null,
    matchedLotsCount: pnl?.matchedLotsCount ?? null,
    decodedSwapSamples: decodedSamples.slice(0, 5),
    missingPriceEvidence: missingPriceEvidence.slice(0, 5),
    wrongChainCacheRejected: json.holdings?.wrongChainCacheRejected || activity?.wrongChainCacheRejected || false,
  }
}

async function run() {
  console.log(`Robinhood Phase 3 live verification — base URL: ${baseUrl}`)
  console.log(`Wallets: ${wallets.join(', ')}`)
  console.log('')

  const results = []
  for (const address of wallets) {
    // Sequential, not parallel — a deliberate, bounded live check, not a load test against a real
    // deployment's rate limiter (the route's own createRateLimiter is 10 req/60s per IP).
    const result = await verifyWallet(address)
    results.push(result)
    console.log(JSON.stringify(result, null, 2))
    console.log('---')
  }

  console.log('')
  console.log('SUMMARY')
  for (const r of results) {
    if (r.providerError) {
      console.log(`  ${r.wallet}: PROVIDER ERROR — ${r.providerError}`)
      continue
    }
    console.log(`  ${r.wallet}: verifiedSwapCount=${r.verifiedSwapCount} skippedSwapLogs=${r.skippedSwapLogs} swapDecodeStatus=${r.swapDecodeStatus} pnlStatus=${r.pnlStatus}${r.pnlStatus !== 'verified' ? ` reason="${r.disabledPnlReason}"` : ` realizedPnlUsd=${r.realizedPnlUsd}`}`)
  }

  const anyProviderError = results.some((r) => r.providerError)
  const anyVerified = results.some((r) => r.pnlStatus === 'verified' || r.pnlStatus === 'partial')
  console.log('')
  console.log(anyVerified
    ? 'At least one wallet produced verified/partial PnL — confirm above that every such wallet has real decodedSwapSamples with priceEvidence:true on both legs before trusting it.'
    : 'No wallet in this sample produced verified/partial PnL. Per the hard rules, this is the CORRECT honest outcome unless you independently know one of these wallets has real, decodable Robinhood DEX activity — it is not itself evidence of a bug.')
  if (anyProviderError) {
    console.log('One or more wallets hit a provider error — check RPC/GoldRush credentials and connectivity before drawing conclusions from the rest.')
  }
}

run().catch((err) => { console.error(err); process.exit(1) })
