// Runtime test harness — main entry point.
//
// Runs the full ChainLens 90-Day Intelligence Engine pipeline end-to-end for every wallet in
// wallets.ts, logs structured results, and validates report shape / fallback / cost / integrity /
// performance correctness for each run.

import {
  assertCost,
  assertFallbacks,
  assertIntegrity,
  assertPerformance,
  assertShape,
  logStructuredResult,
  runPipelineForWallet,
  type AssertionResult,
} from './utils'
import { WALLET_TEST_CONFIGS, type WalletTestConfig } from './wallets'

// Synthetic (no real network I/O) runs get a much tighter performance budget than live-provider
// runs, which depend on real GoldRush/Alchemy round-trip latency.
const SYNTHETIC_PERFORMANCE_BUDGET_MS = 5_000
const LIVE_PERFORMANCE_BUDGET_MS = 60_000

export type WalletTestOutcome = {
  name: string
  pass: boolean
  durationMs: number
  usedSyntheticPath: boolean
  checks: {
    shape: AssertionResult
    fallbacks: AssertionResult
    cost: AssertionResult
    integrity: AssertionResult
    performance: AssertionResult
  }
}

export type TestRunSummary = {
  totalWallets: number
  passedCount: number
  failedCount: number
  results: WalletTestOutcome[]
}

async function runWalletTest(wallet: WalletTestConfig): Promise<WalletTestOutcome> {
  const startTime = performance.now()
  const outcome = await runPipelineForWallet(wallet)
  const endTime = performance.now()

  logStructuredResult(wallet, outcome)

  const budget = outcome.usedSyntheticPath ? SYNTHETIC_PERFORMANCE_BUDGET_MS : LIVE_PERFORMANCE_BUDGET_MS
  const checks = {
    shape: assertShape(outcome.report),
    fallbacks: assertFallbacks(outcome.report),
    cost: assertCost(outcome.report),
    integrity: assertIntegrity(outcome.report),
    performance: assertPerformance(startTime, endTime, budget),
  }

  const pass = Object.values(checks).every((c) => c.pass)

  return { name: wallet.name, pass, durationMs: outcome.durationMs, usedSyntheticPath: outcome.usedSyntheticPath, checks }
}

export async function runAllWalletTests(): Promise<TestRunSummary> {
  const results: WalletTestOutcome[] = []
  for (const wallet of WALLET_TEST_CONFIGS) {
    // Sequential, not parallel: keeps structured log output readable and avoids any risk of
    // concurrent-run interference with the shared recoveryPolicy page-cap accounting were it ever
    // made stateful across calls (it currently isn't, but sequential execution costs little here
    // and removes the question entirely).
    // eslint-disable-next-line no-await-in-loop
    results.push(await runWalletTest(wallet))
  }

  const passedCount = results.filter((r) => r.pass).length
  return { totalWallets: results.length, passedCount, failedCount: results.length - passedCount, results }
}

export { WALLET_TEST_CONFIGS } from './wallets'
export type { WalletTestConfig } from './wallets'
export {
  assertCost,
  assertFallbacks,
  assertIntegrity,
  assertPerformance,
  assertShape,
  runPipelineForWallet,
} from './utils'
