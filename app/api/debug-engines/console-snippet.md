# Browser-console snippet for /api/debug-engines, /api/pnl, /api/transactions, /api/wallet-profile, /api/token-scan

Not a runtime file — reference only, kept alongside the route for discoverability. Paste into the
browser console on any page served by this app (same-origin `fetch`, no auth header added here since
none of these routes currently require one — see each route's own file for its own gating).

```js
async function debugAllEngines({
  walletAddress = '0x0000000000000000000000000000000000dead',
  chains = ['base'],
} = {}) {
  const post = (path, body) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (res) => ({ path, status: res.status, body: await res.json().catch(() => null) }))

  const results = await Promise.all([
    post('/api/debug-engines', { walletAddress, chains }),
    post('/api/pnl', { walletAddress, chains }),
    post('/api/transactions', { walletAddress, chains }),
    post('/api/wallet-profile', { walletAddress, chains }),
    post('/api/token-scan', { chain: chains[0], tokenAddress: '0x4200000000000000000000000000000000000006', timestamp: 1700000000 }),
  ])

  for (const r of results) {
    console.log(`\n=== ${r.path} (HTTP ${r.status}) ===`)
    console.log(r.body)
  }
  return results
}

// Usage:
// debugAllEngines({ walletAddress: '0xYOUR_WALLET', chains: ['base', 'eth'] })
debugAllEngines()
```

Notes:
- `/api/debug-engines` returns `404` when `NODE_ENV === 'production'` (see that route's own header) —
  this snippet's `/api/debug-engines` call is expected to fail with a clear 404 body in production,
  not silently succeed with fake data.
- `/api/token-scan`'s sample call above uses Base's real canonical WETH address directly, matching
  what `/api/debug-engines`'s own `sampleHistoricalPrice` field does internally for `chains[0]`.
