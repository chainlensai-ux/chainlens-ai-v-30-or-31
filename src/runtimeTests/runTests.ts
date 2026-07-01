// Runtime test harness — CLI entry point.
//
// Usage: node --experimental-strip-types src/runtimeTests/runTests.ts
//    or: npx tsx src/runtimeTests/runTests.ts
//
// Runs every wallet test case end-to-end, prints a pass/fail summary, and prints detailed
// per-check failure logs for anything that didn't pass. Exits with a non-zero code when any
// wallet test fails, so this is safe to wire into CI.

import { runAllWalletTests, type WalletTestOutcome } from './index'

function printFailureDetail(outcome: WalletTestOutcome): void {
  console.log(`\n✗ ${outcome.name} FAILED`)
  for (const [checkName, result] of Object.entries(outcome.checks)) {
    if (result.pass) continue
    console.log(`  [${checkName}]`)
    for (const failure of result.failures) {
      console.log(`    - ${failure}`)
    }
  }
}

async function main(): Promise<void> {
  console.log('ChainLens 90-Day Intelligence Engine — Runtime Test Harness\n')
  const summary = await runAllWalletTests()

  console.log('\n============================================================')
  console.log(`Results: ${summary.passedCount}/${summary.totalWallets} passed`)
  console.log('============================================================')

  for (const outcome of summary.results) {
    const marker = outcome.pass ? '✓' : '✗'
    console.log(`${marker} ${outcome.name} (${outcome.usedSyntheticPath ? 'synthetic' : 'live'}, ${outcome.durationMs.toFixed(1)}ms)`)
  }

  const failures = summary.results.filter((r) => !r.pass)
  if (failures.length > 0) {
    console.log('\n────────────────────── FAILURE DETAILS ──────────────────────')
    for (const outcome of failures) printFailureDetail(outcome)
  }

  process.exitCode = summary.failedCount > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('Runtime test harness crashed unexpectedly:', err)
  process.exitCode = 1
})
