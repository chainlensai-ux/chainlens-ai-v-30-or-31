// MERGED WALLET VIEW, DISCLOSED (split-Wallet-Scanner-results fix task): the Wallet Scanner page
// runs two genuinely separate scans — the V2 EVM pipeline (Base/ETH/Arbitrum, via scanWalletV2())
// and Robinhood Chain (via GET /api/wallet-scan/robinhood, lib/server/robinhoodWalletScanner.ts).
// Before this task, the page rendered two independent result cards with two independent totals for
// the SAME wallet — the Portfolio Intelligence card's "Supported On-Chain Portfolio Value" (V2-only)
// and the Robinhood Chain card's "Total Value" (Robinhood-only) — while ALSO claiming, unconditionally,
// that "custodial/exchange holdings (e.g. Robinhood) are not included", even on a scan where Robinhood
// Chain genuinely WAS scanned and included in a card two inches away. Confirmed live bug: $2.25
// (V2-only) shown next to a real, nonzero Robinhood total for the same wallet.
//
// This file is the SINGLE place that decides (a) whether Robinhood is honestly "included" this scan,
// and (b) what the one canonical total for a wallet+scan is. It performs NO new network calls and NO
// new PnL/decoder computation — every number here is a direct read or a straightforward sum of fields
// the existing two fetches (scanWalletV2, handleRobinhoodScan) already produced. It never fakes
// Robinhood PnL and never touches the Robinhood decoder/PnL gates in lib/server/robinhoodWalletScanner.ts.
//
// WORKER-LEVEL ROBINHOOD FIELD, DISCLOSED (Wallet Scanner chain selection fix, worker level): the
// job/poll result (`report.robinhood`, populated by workers/walletScanV2.ts's runWalletScanV2Worker
// once it's threaded `includeRobinhoodRequested`) is a SECOND, independent source of the same
// Robinhood data this file's `robinhoodResult` param already reads via the separate GET
// /api/wallet-scan/robinhood fetch. No reconciliation logic exists between the two on purpose,
// verified rather than assumed: both ultimately call the exact same scanRobinhoodWallet(), which
// reads/writes the exact same wallet-keyed ~60s TTL cache (getCachedRobinhoodWalletHoldings/
// getCachedRobinhoodWalletActivity in lib/server/robinhoodWalletScanner.ts) — so within that window
// they describe the same underlying cached scan and will naturally agree. This function
// deliberately keeps reading only `robinhoodResult` (the separate fetch) since that is the ONLY
// source available on the fast preview-scan path, which never goes through the async job worker at
// all — using `report.robinhood` as the sole source here would silently regress that path to "no
// Robinhood" instead.
//
import type { RobinhoodWalletScanResponse } from '@/lib/walletScan/canonicalWalletSelectors'
import type { PricedHolding } from '@/lib/engine/modules/pricing/types'
import { ROBINHOOD_CHAIN_META } from '@/lib/walletScan/canonicalWalletSelectors'

export type RobinhoodInclusion = {
  // True only when Robinhood Chain was actually, successfully scanned this session AND produced a
  // real, non-null priced total — a real `ok`/`partial` holdings status with a real response, never
  // merely "an attempt was made". A 'not_configured' deployment, a failed fetch
  // (robinhoodResult === null), an 'unavailable' holdings status, OR a real 'partial' holdings-found-
  // but-genuinely-unpriced result are all `included: false` — honest, not "excluded", since these are
  // several different real states (see robinhoodStatusCopy/robinhoodDisplayState below for the
  // distinction shown to the user).
  included: boolean
  valueUsd: number | null
}

// FIXED, DISCLOSED (Robinhood-partial-adapter-and-Blockscout-proof follow-up): confirmed live bug —
// this previously returned `included: true, valueUsd: portfolioTotalUsd ?? 0` for ANY 'ok'/'partial'
// status, including a real 'partial' result whose `portfolioTotalUsd` is genuinely null (holdings
// exist — e.g. one unpriced token — but no priced evidence at all). Defaulting a null total to `0`
// while still claiming `included: true` is exactly the false "merged" claim the task's hard rules
// forbid ("Do NOT add Robinhood value unless priced evidence exists", "Do NOT show Robinhood in
// normal chain breakdown as valued if robinhoodMerged=false") — it made the UI show a Robinhood chip/
// "Includes Robinhood Chain" copy for a wallet with ZERO real priced Robinhood value. `included` now
// requires a real, non-null `portfolioTotalUsd` regardless of status — a 'partial' status with a null
// total is honestly `included: false` (see robinhoodDisplayState below for its own, distinct
// "found but unpriced" UI state, which is NOT the same as "not included at all").
export function computeRobinhoodInclusion(
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined,
): RobinhoodInclusion {
  if (!robinhoodResult || !robinhoodResult.ok) return { included: false, valueUsd: null }
  const status = robinhoodResult.holdings.status
  if (status !== 'ok' && status !== 'partial') return { included: false, valueUsd: null }
  const valueUsd = robinhoodResult.holdings.portfolioTotalUsd
  if (valueUsd == null) return { included: false, valueUsd: null }
  return { included: true, valueUsd }
}

// DISPLAY STATE, DISCLOSED (this task's own explicit requirement — item 2's "Robinhood found but
// unpriced" wording): a finer-grained classification than `included` alone, so the UI can show the
// TRUE state of a Robinhood scan rather than collapsing "genuinely not scanned/disabled" and "scanned,
// holdings found, but nothing could be priced" into the same generic "not included" bucket.
export type RobinhoodDisplayState = 'valued' | 'partial_unpriced' | 'failed' | 'not_configured' | 'not_scanned'

export function computeRobinhoodDisplayState(
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined,
): RobinhoodDisplayState {
  if (!robinhoodResult) return 'not_scanned'
  if (!robinhoodResult.ok) return 'failed'
  const status = robinhoodResult.holdings.status
  if (status === 'not_configured') return 'not_configured'
  if (status === 'unavailable') return 'failed'
  const valueUsd = robinhoodResult.holdings.portfolioTotalUsd
  if (valueUsd != null) return 'valued'
  const hasHoldings = (robinhoodResult.holdings.holdings?.length ?? 0) > 0 || robinhoodResult.holdings.native != null
  return hasHoldings ? 'partial_unpriced' : 'failed'
}

export const ROBINHOOD_FOUND_UNPRICED_COPY = 'Robinhood Chain found holdings but could not price them — not included in the total.'

export type MergedTotal = {
  // The ONE canonical portfolio value for this wallet+scan: the V2 pipeline's total (Base/ETH/
  // Arbitrum) plus Robinhood's total, but ONLY when Robinhood was actually, successfully scanned.
  // Never a fabricated number — null+null stays null (honest "not available"), a real V2 total with
  // no Robinhood inclusion is the V2 total alone (unchanged from before this task for a wallet where
  // Robinhood isn't configured/didn't scan), and a real V2 total plus a real Robinhood total is their
  // literal sum.
  totalValueUsd: number | null
  robinhoodIncluded: boolean
  robinhoodValueUsd: number | null
}

// CANONICAL WORKER OVERRIDE, DISCLOSED (final-canonical-merge-proof follow-up): when a deep-scan job
// result carries the worker's own already-merged `canonicalTotalValueUsd`/`finalCanonicalMergeAudit`
// (workers/walletScanV2.ts — see WalletV2Report's own header in app/terminal/wallet-scanner/page.tsx),
// that IS the authoritative, already-computed after-merge total: prefer it outright rather than
// re-summing v2Total + the separate Robinhood fetch a second time here, which would either duplicate
// the same real number (harmless but redundant) or, worse, silently diverge from the worker's own
// proof object if the two ever disagree. Only used when the caller actually has it — the fast preview
// path (which never goes through the async job worker) has no such field and falls through to the
// existing v2Total + robinhoodResult computation below, unchanged.
export type CanonicalMergeOverride = {
  totalValueUsd: number | null
  robinhoodMerged: boolean
} | null | undefined

export function computeMergedTotalValueUsd(
  v2TotalValueUsd: number | null | undefined,
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined,
  canonicalOverride?: CanonicalMergeOverride,
): MergedTotal {
  if (canonicalOverride) {
    return {
      totalValueUsd: canonicalOverride.totalValueUsd,
      robinhoodIncluded: canonicalOverride.robinhoodMerged,
      robinhoodValueUsd: canonicalOverride.robinhoodMerged
        ? (canonicalOverride.totalValueUsd ?? 0) - (v2TotalValueUsd ?? 0)
        : null,
    }
  }
  const v2Total = v2TotalValueUsd ?? null
  const { included, valueUsd } = computeRobinhoodInclusion(robinhoodResult)
  if (v2Total == null && valueUsd == null) {
    return { totalValueUsd: null, robinhoodIncluded: included, robinhoodValueUsd: valueUsd }
  }
  return { totalValueUsd: (v2Total ?? 0) + (valueUsd ?? 0), robinhoodIncluded: included, robinhoodValueUsd: valueUsd }
}

// WORKER-CANONICAL-TO-OVERRIDE ADAPTER, DISCLOSED: a small, pure helper turning a WalletV2Report's
// own (optional) canonical fields into the `CanonicalMergeOverride` shape above — kept as its own
// function so every call site (CORTEX, the hero total, chain chips) derives the override the exact
// same way, never by re-reading the report's raw fields inconsistently in three different places.
export function deriveCanonicalMergeOverride(report: {
  canonicalTotalValueUsd?: number | null
  finalCanonicalMergeAudit?: { robinhoodMerged: boolean } | null
} | null | undefined): CanonicalMergeOverride {
  if (!report || report.canonicalTotalValueUsd === undefined) return null
  return {
    totalValueUsd: report.canonicalTotalValueUsd,
    robinhoodMerged: report.finalCanonicalMergeAudit?.robinhoodMerged ?? false,
  }
}

// EXACT WORDING, DISCLOSED (this task's own explicit requirement): when Robinhood was genuinely
// scanned and included, the old unconditional "may not be included"/"are not included" copy is
// actively false — replace it with this exact sentence. When Robinhood was NOT included this scan
// (never attempted, not configured, or a failed/unavailable scan), stay honest about on-chain-only
// coverage without claiming Robinhood support doesn't exist in this codebase (it does) — this is
// intentionally different phrasing from the old, now-permanently-false "no custodial/exchange
// integration anywhere in this codebase" comment/copy this replaces.
export const ROBINHOOD_INCLUDED_COPY = 'Includes Robinhood Chain when enabled and successfully scanned.'
export const ROBINHOOD_NOT_INCLUDED_COPY =
  'Covers on-chain holdings on supported chains only. Robinhood Chain is included automatically once it is enabled and successfully scanned.'

export function portfolioCoverageCopy(robinhoodIncluded: boolean): string {
  return robinhoodIncluded ? ROBINHOOD_INCLUDED_COPY : ROBINHOOD_NOT_INCLUDED_COPY
}

// NOT-CONFIGURED WORDING, DISCLOSED (Wallet Scanner deep scan chain coverage fix, requirement 7):
// when Robinhood is disabled or missing its RPC/env config, the UI must say so plainly — never the
// generic "not included this scan" copy above, which could be misread as "the scan tried and
// failed" rather than "Robinhood Chain support isn't turned on for this deployment." Reuses
// RobinhoodChainSection's own existing `holdings.status === 'not_configured'` vocabulary (see that
// component) rather than inventing a new status field.
export const ROBINHOOD_NOT_CONFIGURED_COPY = 'Robinhood Chain not scanned — not configured'

// STATUS-AWARE COPY, DISCLOSED: the specific, more-informative sibling of portfolioCoverageCopy()
// above — callers that have the real RobinhoodWalletScanResponse (and so can tell "not configured"
// apart from "attempted but failed"/"never attempted") should call this instead so the
// not-configured case gets its own exact, honest wording rather than the generic fallback.
export function robinhoodStatusCopy(
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined,
  robinhoodIncluded: boolean,
): string {
  if (robinhoodIncluded) return ROBINHOOD_INCLUDED_COPY
  const status = robinhoodResult && robinhoodResult.ok ? robinhoodResult.holdings.status : null
  if (status === 'not_configured') return ROBINHOOD_NOT_CONFIGURED_COPY
  // FOUND-BUT-UNPRICED, DISCLOSED (Robinhood-partial-adapter-and-Blockscout-proof follow-up,
  // requirement 2's explicit wording): a real 'partial' holdings status with real holdings but no
  // priced total is a genuinely different state from "never scanned"/"disabled" — say so honestly
  // rather than folding it into the generic not-included copy, which would misleadingly suggest
  // Robinhood was never even attempted for this wallet.
  if (computeRobinhoodDisplayState(robinhoodResult) === 'partial_unpriced') return ROBINHOOD_FOUND_UNPRICED_COPY
  return ROBINHOOD_NOT_INCLUDED_COPY
}

// WALLET PUBLIC UI DATA AUDIT, DISCLOSED (Wallet-Scanner-Robinhood-UI-breakdown-mismatch fix): this
// task's own explicit requirement — a single, computed-client-side proof that the chain bars/chips a
// user actually SEES sum to the same total displayed next to them, using the SAME source object CORTEX
// reads. Confirmed live bug this closes: total $9,097.55 (already merged, from canonicalTotalValueUsd)
// next to chain bars summing to only $1,721.23 (still reading the old, EVM-only chainValueUsd) — the
// exact class of silent mismatch this audit exists to make impossible to miss. Pure — no network call,
// no new computation beyond summing the ALREADY-DISPLAYED breakdown rows and comparing to the
// ALREADY-DISPLAYED total.
export type WalletPublicUiDataAudit = {
  displayedTotalUsd: number | null
  displayedPortfolioTotalByChain: Record<string, number>
  displayedChainSumUsd: number
  displayedHoldingsChains: string[]
  // ADDED, DISCLOSED (finish-Wallet-Scanner-Robinhood-integration follow-up, this task's own explicit
  // required fields): real per-chain counts off the SAME rows the Holdings tab actually renders
  // (post-Robinhood-merge, see mergeRobinhoodIntoPricedHoldings below) — never a separate recount.
  // displayedHoldingsCountByChain counts every displayed row (priced OR dust, whatever the Holdings
  // tab shows); displayedPricedCountByChain is the subset of those with a real, non-null valueUsd —
  // the same "priced" concept PortfolioIntelligenceCard's own pricedTokenCount already uses.
  displayedHoldingsCountByChain: Record<string, number>
  displayedPricedCountByChain: Record<string, number>
  // Chains for which SOME real PnL status/message is shown to the user this scan — EVM chains (the
  // aggregate pnlV2/fifoAndPnl figures cover the whole EVM scan, never split per chain beyond
  // pnlV2.chainBreakdown) plus 'robinhood' whenever a real robinhoodResult.pnl status line is
  // rendered (verified, partial, or the honest disabled/unsupported message) — never implies a
  // verified number exists for every chain listed here, only that a real status is displayed.
  displayedPnlChains: string[]
  displayedChainsScanned: string[]
  cortexChainsDisplayed: string[]
  sourceObjectUsed: 'canonical_portfolio_total_by_chain' | 'evm_only_chain_value_usd' | 'v1_chain_value_breakdown' | 'none'
  usesMergedCanonicalResult: boolean
  mismatchUsd: number | null
  mismatchReason: string | null
}

// TOLERANCE, DISCLOSED: cents-level rounding across several chain sums is expected and never a real
// mismatch — anything above $0.01 means the bars and the total genuinely disagree.
const CHAIN_SUM_MISMATCH_TOLERANCE_USD = 0.01

export function buildWalletPublicUiDataAudit(params: {
  displayedTotalUsd: number | null
  displayedBreakdown: Array<{ chain: string; valueUsd: number }>
  canonicalChainTotalByChain: Record<string, number> | null | undefined
  evmOnlyChainValueUsd: Record<number, number> | null | undefined
  v1BreakdownPresent: boolean
  chainsScanned: string[]
  cortexChainsDisplayed: string[]
  // ADDED, DISCLOSED (finish-Wallet-Scanner-Robinhood-integration follow-up): the real rows the
  // Holdings tab is actually displaying this scan (post-Robinhood-merge) — used ONLY to build the two
  // per-chain count fields above, never to recompute displayedChainSumUsd/mismatchUsd (those stay
  // sourced from displayedBreakdown, unchanged).
  displayedHoldingsRows: Array<{ chain: string; valueUsd: number | null }>
  displayedPnlChains: string[]
}): WalletPublicUiDataAudit {
  const displayedPortfolioTotalByChain: Record<string, number> = {}
  for (const row of params.displayedBreakdown) displayedPortfolioTotalByChain[row.chain] = row.valueUsd
  const displayedChainSumUsd = params.displayedBreakdown.reduce((sum, row) => sum + row.valueUsd, 0)
  const displayedHoldingsChains = params.displayedBreakdown.map((row) => row.chain)

  const displayedHoldingsCountByChain: Record<string, number> = {}
  const displayedPricedCountByChain: Record<string, number> = {}
  for (const row of params.displayedHoldingsRows) {
    displayedHoldingsCountByChain[row.chain] = (displayedHoldingsCountByChain[row.chain] ?? 0) + 1
    if (row.valueUsd != null) displayedPricedCountByChain[row.chain] = (displayedPricedCountByChain[row.chain] ?? 0) + 1
  }

  const usesMergedCanonicalResult = Boolean(params.canonicalChainTotalByChain && Object.keys(params.canonicalChainTotalByChain).length > 0)
  const sourceObjectUsed: WalletPublicUiDataAudit['sourceObjectUsed'] = usesMergedCanonicalResult
    ? 'canonical_portfolio_total_by_chain'
    : (params.evmOnlyChainValueUsd && Object.keys(params.evmOnlyChainValueUsd).length > 0)
      ? 'evm_only_chain_value_usd'
      : params.v1BreakdownPresent
        ? 'v1_chain_value_breakdown'
        : 'none'

  const mismatchUsd = params.displayedTotalUsd != null ? Math.abs(params.displayedTotalUsd - displayedChainSumUsd) : null
  const mismatchReason = (mismatchUsd != null && mismatchUsd > CHAIN_SUM_MISMATCH_TOLERANCE_USD)
    ? (usesMergedCanonicalResult
      ? `Chain bars (sum $${displayedChainSumUsd.toFixed(2)}) disagree with the displayed total ($${params.displayedTotalUsd!.toFixed(2)}) even though the merged canonical per-chain map was used — investigate a real data inconsistency.`
      : `Chain bars are reading a non-canonical source ('${sourceObjectUsed}') while the displayed total may already include Robinhood — this is the exact split-source bug this audit exists to catch.`)
    : null

  return {
    displayedTotalUsd: params.displayedTotalUsd,
    displayedPortfolioTotalByChain,
    displayedChainSumUsd,
    displayedHoldingsChains,
    displayedHoldingsCountByChain,
    displayedPricedCountByChain,
    displayedPnlChains: params.displayedPnlChains,
    displayedChainsScanned: params.chainsScanned,
    cortexChainsDisplayed: params.cortexChainsDisplayed,
    sourceObjectUsed,
    usesMergedCanonicalResult,
    mismatchUsd,
    mismatchReason,
  }
}

// ROBINHOOD-INTO-HOLDINGS MERGE, DISCLOSED (finish-Wallet-Scanner-Robinhood-integration follow-up,
// this task's own explicit requirement 3): the Holdings tab previously only ever received
// report.pricedHoldings/report.chainValueUsd — the EVM-only pricing engine's own output — so
// Robinhood never appeared there at all, only inside its own separate tab. This function adapts
// Robinhood's real, already-fetched holdings (RobinhoodWalletScanResponse['holdings'], a genuinely
// different shape — address/uiBalance/priceSource, not tokenAddress/quantity/decimals/classification)
// into real PricedHolding-shaped rows so they flow through the SAME selectHoldingsV2 selector every
// EVM holding already does — same dust/zero-value filtering, same sort, same table component. NEVER
// fabricates a price or value: a Robinhood token with `priceUsd: null`/`valueUsd: null` becomes a
// PricedHolding with the same null fields, which selectHoldingsV2 already, honestly excludes from
// both the meaningful and dust buckets (see holdingsV2Selector.ts's own "NEVER HIDDEN BY VALUE"
// header) — exactly the same treatment an unpriced EVM token already gets today, not a new rule.
// `decimals: 0`/`quantity: String(uiBalance)` is a deliberate, disclosed shortcut: the frontend
// RobinhoodWalletScanResponse type only ever carries the already-human-readable `uiBalance` (see
// RobinhoodChainSection.tsx's own type — no raw decimals/rawBalance reach the client), and
// HoldingsTable/holdingsV2Selector only ever read `amount`/`providerValueUsd` from the derived
// TokenHolding row (via toDisplayRow), never quantity*10**decimals — so this never produces a wrong
// displayed balance, only skips a client-side round-trip through decimals that was never needed.
export function mergeRobinhoodIntoPricedHoldings(
  pricedHoldings: PricedHolding[] | null | undefined,
  chainValueUsd: Record<number, number> | null | undefined,
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined,
  // Same priority-order convention as selectChainBreakdown (WalletProfileHeader.tsx): the worker's
  // own AFTER-merge canonicalChainTotalByChain (only ever contains 4663 when Robinhood was genuinely
  // merged — see workers/walletScanV2.ts) takes priority over the EVM-only chainValueUsd. Passing
  // neither/undefined degrades to the plain EVM-only chainValueUsd, unchanged from before this task.
  canonicalChainTotalByChain?: Record<string, number> | null,
): { pricedHoldings: PricedHolding[]; chainValueUsd: Record<number, number> } {
  const basePricedHoldings = Array.isArray(pricedHoldings) ? pricedHoldings : []
  const baseChainValueUsd = (chainValueUsd && typeof chainValueUsd === 'object') ? chainValueUsd : {}
  const mergedChainValueUsd = (canonicalChainTotalByChain && Object.keys(canonicalChainTotalByChain).length > 0)
    ? Object.fromEntries(Object.entries(canonicalChainTotalByChain).map(([chainIdStr, valueUsd]) => [Number(chainIdStr), valueUsd]))
    : { ...baseChainValueUsd }

  if (!robinhoodResult || !robinhoodResult.ok) {
    return { pricedHoldings: basePricedHoldings, chainValueUsd: mergedChainValueUsd }
  }

  const robinhoodRows: PricedHolding[] = []
  const h = robinhoodResult.holdings
  if (h.native) {
    robinhoodRows.push({
      chainId: ROBINHOOD_CHAIN_META.chainId,
      tokenAddress: 'native',
      symbol: h.native.symbol,
      decimals: 0,
      quantity: String(h.native.uiBalance ?? 0),
      priceUsd: h.native.priceUsd,
      valueUsd: h.native.valueUsd,
      classification: 'other',
    })
  }
  for (const t of h.holdings) {
    robinhoodRows.push({
      chainId: ROBINHOOD_CHAIN_META.chainId,
      tokenAddress: t.address,
      symbol: t.symbol ?? t.address.slice(0, 8),
      decimals: 0,
      quantity: String(t.uiBalance ?? 0),
      priceUsd: t.priceUsd,
      valueUsd: t.valueUsd,
      classification: 'other',
    })
  }

  return {
    pricedHoldings: [...basePricedHoldings, ...robinhoodRows],
    chainValueUsd: mergedChainValueUsd,
  }
}
