// PERFORMANCE REGRESSION BENCHMARK, DISCLOSED (perf-guardrails follow-up task: "Add a performance
// regression benchmark that automatically prints [an Old scan / New scan / per-bucket % / Overall %
// report], so every optimization is measurable instead of 'it feels faster.'"). Runs the REAL
// runWalletScan() pipeline (src/pipeline/index.ts) against a representative wallet set, reads that
// scan's own already-measured scanPerformanceSummary.stages (never a second, separate timing
// mechanism), buckets them into Provider fetch / Pricing / Merge / Recovery (see buckets.ts's own
// header for the exact stage-name mapping), and compares against a saved baseline run.
//
// REQUIRES REAL CREDENTIALS, DISCLOSED: this calls the real pipeline, which makes real GoldRush/
// Alchemy/DexScreener/CoinGecko/KV calls — it needs this project's real provider API keys and KV
// connection configured in the environment it runs in (see this repo's own .env.example), same as
// any real deployment. It will not run meaningfully in an environment with no provider access.
//
// Usage:
//   cp scripts/perfBenchmark/wallets.example.json scripts/perfBenchmark/wallets.json
//   # edit wallets.json with real wallet addresses you have permission to repeatedly scan
//   npx tsx scripts/perfBenchmark/run.ts                  # run + compare against saved baseline
//   npx tsx scripts/perfBenchmark/run.ts --save-baseline   # run + (re)capture this run AS the baseline
//
// Both wallets.json and baseline.json are gitignored (see .gitignore) — this tool's local run data
// and any real wallet addresses in it are never committed.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runWalletScan } from '../../src/pipeline/index'
import { bucketizeStages, sumBuckets, type BenchmarkBuckets } from './buckets'
import { formatBenchmarkReport } from './formatReport'

const WALLETS_PATH = fileURLToPath(new URL('./wallets.json', import.meta.url))
const BASELINE_PATH = fileURLToPath(new URL('./baseline.json', import.meta.url))

type WalletEntry = { address: string; chains: string[]; scanMode: 'normal' | 'deep' }

function loadWalletSet(): WalletEntry[] {
  if (!existsSync(WALLETS_PATH)) {
    console.error(
      `[perf-benchmark] ${WALLETS_PATH} not found.\n` +
      `Copy scripts/perfBenchmark/wallets.example.json to scripts/perfBenchmark/wallets.json and fill in a real, representative wallet set first.`,
    )
    process.exit(1)
  }
  const parsed = JSON.parse(readFileSync(WALLETS_PATH, 'utf8')) as { wallets: WalletEntry[] }
  if (!Array.isArray(parsed.wallets) || parsed.wallets.length === 0) {
    console.error(`[perf-benchmark] ${WALLETS_PATH} contains no wallets — nothing to benchmark.`)
    process.exit(1)
  }
  return parsed.wallets
}

function loadBaseline(): BenchmarkBuckets | null {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BenchmarkBuckets
}

function saveBaseline(buckets: BenchmarkBuckets): void {
  writeFileSync(BASELINE_PATH, JSON.stringify(buckets, null, 2))
}

// PER-WALLET, NOT CONCURRENT, DISCLOSED: run sequentially, one real scan at a time — this
// benchmark's own real wall-clock cost is a legitimate tradeoff for a clean, uncontended
// measurement (concurrent scans on the same process would share/contend for this pipeline's own
// process-global provider-cost ledgers and concurrency-limited worker pools, which would make each
// wallet's own stage timings less representative of what a single real user's scan actually
// experiences).
async function runOne(wallet: WalletEntry): Promise<BenchmarkBuckets> {
  console.warn(`[perf-benchmark] scanning ${wallet.address} (${wallet.chains.join(',')}, ${wallet.scanMode})...`)
  const result = await runWalletScan({ walletAddress: wallet.address, chains: wallet.chains, scanMode: wallet.scanMode })
  const stages = result.scanPerformanceSummary?.stages ?? []
  if (stages.length === 0) {
    console.warn(`[perf-benchmark] WARNING: ${wallet.address} returned no scanPerformanceSummary.stages — this wallet's contribution will be all zeros. Check preScan validity / provider connectivity.`)
  }
  return bucketizeStages(stages)
}

async function main(): Promise<void> {
  const saveAsBaseline = process.argv.includes('--save-baseline')
  const wallets = loadWalletSet()

  const perWallet: BenchmarkBuckets[] = []
  for (const wallet of wallets) {
    perWallet.push(await runOne(wallet))
  }
  const current = sumBuckets(perWallet)

  if (saveAsBaseline) {
    saveBaseline(current)
    console.log(`[perf-benchmark] saved this run (${wallets.length} wallet(s), totalMs=${current.totalMs}) as the new baseline -> ${BASELINE_PATH}`)
    return
  }

  const baseline = loadBaseline()
  if (!baseline) {
    saveBaseline(current)
    console.log(
      `[perf-benchmark] no baseline found — this run (${wallets.length} wallet(s), totalMs=${current.totalMs}) has been saved as the baseline.\n` +
      `Run again after making a change to see a before/after comparison.`,
    )
    return
  }

  console.log('')
  console.log(formatBenchmarkReport(baseline, current))
  console.log('')
}

main().catch((err) => {
  console.error('[perf-benchmark] failed', err)
  process.exit(1)
})
