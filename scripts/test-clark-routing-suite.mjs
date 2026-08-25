const tests = [
  'test-clark-actions.mjs',
  'test-clark-analyst-e2e-routing.mjs',
  'test-clark-app-context.mjs',
  'test-clark-base-market-routing.mjs',
  'test-clark-basic-intent.mjs',
  'test-clark-deep-scan-address-routing.mjs',
  'test-clark-deployer-routing.mjs',
  'test-clark-deployer-lookup.mjs',
  'test-clark-followup-commands.mjs',
  'test-clark-history.mjs',
  'test-clark-intent.mjs',
  'test-clark-market-metric-routing.mjs',
  'test-clark-market-persistence.mjs',
  'test-clark-pump-intent.mjs',
  'test-pump-alerts-discovery.mjs',
  'test-pump-7d-fallback.mjs',
  'test-pump-snapshots.mjs',
  'test-pump-intelligence-report.mjs',
  'test-clark-context-memory.mjs',
  'test-clark-radar-whale-toolcalls.mjs',
  'test-clark-risk-intent.mjs',
  'test-clark-safety-address-routing.mjs',
  'test-clark-token-core.mjs',
  'test-clark-v2-wallet-projection.mjs',
  'test-wallet-clark-pnl-read.mjs',
  'test-clark-execution.mjs',
]

for (const test of tests) await import(`./${test}`)

console.log(`Clark routing suite passed (${tests.length} files)`)
