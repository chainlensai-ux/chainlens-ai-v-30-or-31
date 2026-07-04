# Browser-console snippet for /api/debug-engines, /api/pnl, /api/transactions, /api/wallet-profile, /api/token-scan

Not a runtime file — reference only, kept alongside the route for discoverability. Paste into the
browser console on any page served by this app (same-origin `fetch`).

**UNVERIFIABLE-CLAIM DISCLOSURE:** the task that produced this update supplied a specific wallet
address (`testWalletWithTrades` below) asserting it "is known to contain buys, sells, rotations,
partial closes, USD-denominated swaps." This session has no way to verify that claim — it cannot
query GoldRush/Alchemy from this environment to confirm the address's real transaction history. The
address is used below exactly as given (it is syntactically a valid 40-hex-character address), but
treat its described trade history as an unverified assumption from the request, not a confirmed fact
— if a real Deep Scan against it comes back with no sells/rotations, that means the address doesn't
actually have the claimed history, not that the routes are broken.

`/api/debug-engines`'s admin override: when `NODE_ENV=production`, the route now requires header
`x-chainlens-admin` to match server env var `CHAINLENS_ADMIN_KEY` (see that route's own file header).
This snippet always sends the header — harmless in development since the route runs regardless of
the header there once `NODE_ENV !== 'production'`, and required for it to run at all if the console
is ever pointed at a production deployment. The literal key value must come from wherever your own
deployment secrets are configured; this snippet does not hardcode one.

```js
async function debugAllEngines({
  walletAddress = testWalletWithTrades,
  chains = ['base'],
  adminKey = null, // set to your real CHAINLENS_ADMIN_KEY value if testing against production
} = {}) {
  // See file header: unverified claim from the request, not confirmed against real GoldRush data.
  const testWalletWithTrades = '0x8e5fbf5b4e0d3c5b4c2c4b7f3a7f8d9c1e2f3a4b'

  // Valid historical timestamp (2023-03-28T00:00:00Z) — real, well within GoldRush/Coingecko/
  // on-chain-DEX historical coverage, unlike an arbitrary/future/pre-genesis timestamp would be.
  const historicalTimestamp = 1680000000

  const post = (path, body, extraHeaders = {}) =>
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    }).then(async (res) => ({ path, status: res.status, body: await res.json().catch(() => null) }))

  const debugEnginesHeaders = adminKey ? { 'x-chainlens-admin': adminKey } : {}

  const results = await Promise.all([
    post('/api/debug-engines', { walletAddress, chains }, debugEnginesHeaders),
    post('/api/pnl', { walletAddress, chains }),
    post('/api/transactions', { walletAddress, chains }),
    post('/api/wallet-profile', { walletAddress, chains }),
    post('/api/token-scan', {
      chain: chains[0],
      tokenAddress: '0x4200000000000000000000000000000000000006', // real canonical WETH, Base/Optimism
      timestamp: historicalTimestamp,
    }),
  ])

  for (const r of results) {
    console.log(`\n=== ${r.path} (HTTP ${r.status}) ===`)
    console.log(r.body)
  }
  return results
}

// Usage:
//   debugAllEngines()                                            // dev, default wallet/chain
//   debugAllEngines({ chains: ['base', 'eth'] })                 // dev, multiple chains
//   debugAllEngines({ adminKey: 'YOUR_CHAINLENS_ADMIN_KEY' })    // production, admin-unlocked debug-engines
debugAllEngines()
```

Notes:
- `/api/debug-engines` still returns `404` in production if `adminKey` is omitted or wrong — that is
  the intended fail-closed behavior, not a bug in this snippet.
- `1680000000` replaces the earlier `1700000000` sample timestamp per this task's request; both are
  real, valid historical Unix timestamps — this is a like-for-like swap, not a bug fix to a broken one.
