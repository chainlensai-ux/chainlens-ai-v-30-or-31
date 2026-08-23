// V1 ENGINE REPLACED WITH LIGHTWEIGHT, ZERO-RPC FALLBACKS.
//
// Both functions below previously lived inline in app/api/portfolio/route.ts and
// lib/server/walletScannerRunner.ts respectively (each calling fetchWalletSnapshot() from
// lib/server/walletSnapshot.ts, which fires Alchemy RPC calls) — consolidated here into one
// shared module so there is exactly one place defining what "lite" wallet/portfolio data is.
//
// Both are honest empty placeholders — empty arrays/objects, never a fabricated balance,
// position, or identity field — not a real data source. Real GoldRush/Zerion/ENS wiring is NOT
// implemented here (out of scope for this task); flagged explicitly so this isn't mistaken for
// "wallet/portfolio data actually works now." Neither function ever calls an RPC/provider, and
// neither can throw — both are synchronous logic wrapped in a resolved Promise, so there is no
// I/O, no external call, and no failure mode to catch.

export type WalletLiteResult = {
  ok: true
  address: string
  balances: unknown[]
  positions: unknown[]
  chains: unknown[]
  identity: Record<string, unknown>
  labels: Record<string, unknown>
  // Optional analyst projection populated only by the real V2 adapter. The zero-RPC lite
  // fallback deliberately leaves these absent so callers can distinguish missing evidence.
  totalValue?: number | null
  holdings?: Array<{ symbol: string; value: number | null; chain: string }>
  txCount?: number | null
  pnlCoverage?: unknown
  historicalRecoveryStatus?: unknown
  openLots?: number | null
  closedLots?: number | null
  walletScanHealth?: unknown
  walletModuleCoverage?: unknown
  walletTokenPnlSummary?: unknown
  walletTokenPnlRead?: unknown[]
  walletTradeStatsSummary?: unknown
  walletHistoricalCoverageSummary?: unknown
  walletRecoveryRecommendation?: unknown
  walletLotSummary?: unknown
  publicPnlStatus?: string
  publicPerformanceClosedLots?: number
  publicRealizedPnlUsd?: number | null
  publicWinRatePercent?: number | null
  publicSamplePerformanceRead?: unknown
  evidenceGaps?: string[]
  walletProfile?: unknown
  dataFreshness?: string
}

export async function getWalletLite(address: string): Promise<WalletLiteResult> {
  return {
    ok: true,
    address,
    balances: [],
    positions: [],
    chains: [],
    identity: {},
    labels: {},
  }
}

export async function getPortfolioLite(address: string): Promise<WalletLiteResult> {
  return {
    ok: true,
    address,
    balances: [],
    positions: [],
    chains: [],
    identity: {},
    labels: {},
  }
}
