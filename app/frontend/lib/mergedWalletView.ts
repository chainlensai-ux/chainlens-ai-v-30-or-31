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
import type { RobinhoodWalletScanResponse } from '@/app/frontend/components/RobinhoodChainSection'

export type RobinhoodInclusion = {
  // True only when Robinhood Chain was actually, successfully scanned this session — a real `ok`/
  // `partial` holdings status with a real response, never merely "an attempt was made". A
  // 'not_configured' deployment, a failed fetch (robinhoodResult === null), or an 'unavailable'
  // holdings status are all `included: false` — honest, not "excluded", since those are three
  // different real states (see robinhoodStatusCopy below for the distinction shown to the user).
  included: boolean
  valueUsd: number | null
}

export function computeRobinhoodInclusion(
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined,
): RobinhoodInclusion {
  if (!robinhoodResult || !robinhoodResult.ok) return { included: false, valueUsd: null }
  const status = robinhoodResult.holdings.status
  if (status !== 'ok' && status !== 'partial') return { included: false, valueUsd: null }
  return { included: true, valueUsd: robinhoodResult.holdings.portfolioTotalUsd ?? 0 }
}

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

export function computeMergedTotalValueUsd(
  v2TotalValueUsd: number | null | undefined,
  robinhoodResult: RobinhoodWalletScanResponse | null | undefined,
): MergedTotal {
  const v2Total = v2TotalValueUsd ?? null
  const { included, valueUsd } = computeRobinhoodInclusion(robinhoodResult)
  if (v2Total == null && valueUsd == null) {
    return { totalValueUsd: null, robinhoodIncluded: included, robinhoodValueUsd: valueUsd }
  }
  return { totalValueUsd: (v2Total ?? 0) + (valueUsd ?? 0), robinhoodIncluded: included, robinhoodValueUsd: valueUsd }
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
  return ROBINHOOD_NOT_INCLUDED_COPY
}
