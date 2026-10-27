// EARLY BUYERS — presentation helpers (UI only).
//
// Pure functions that turn an EarlyBuyerIntel response into display values. Nothing here changes
// what the engine found: no new metrics, no re-classification, no confidence scores. Counts shown
// in the UI are either fields of the response or regroupings of fields the response already
// carries (and are cross-checked against the engine's own totals before being shown).

import type { BalanceComparison, BuyerGroup, CurrentHoldingsSnapshot, EarlyBuyer, EarlyBuyerIntel, SharedRecipient } from '@/lib/server/earlyBuyers/types'

export const EXPLORER: Record<string, string> = { base: 'https://basescan.org', eth: 'https://etherscan.io' }
export const explorerTx = (chain: string, hash: string) => `${EXPLORER[chain] ?? EXPLORER.base}/tx/${hash}`
export const explorerAddress = (chain: string, address: string) => `${EXPLORER[chain] ?? EXPLORER.base}/address/${address}`
export const shortHex = (value: string, head = 6, tail = 4) => value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value

const groupDigits = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export type AmountDisplay = {
  /** What the cell shows. */
  text: string
  /** Exact value for tooltips / details. */
  exact: string
  /** 'token' only when decimals were supplied; otherwise the value is raw on-chain units. */
  unit: 'token' | 'raw'
}

/**
 * Formats a raw integer token amount. Converts to token units ONLY when `decimals` is a supplied
 * integer; without decimals the exact raw integer is shown and labelled raw — never a guessed 18.
 */
export function formatTokenAmount(raw: string, decimals: number | null | undefined): AmountDisplay {
  if (!/^\d+$/.test(raw)) return { text: raw, exact: raw, unit: 'raw' }
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    const grouped = groupDigits(raw.replace(/^0+(?=\d)/, ''))
    return { text: grouped, exact: grouped, unit: 'raw' }
  }
  const value = BigInt(raw)
  const scale = BigInt(10) ** BigInt(decimals)
  const whole = value / scale
  const frac = value % scale
  const fracDigits = decimals > 0 ? frac.toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  const exact = `${groupDigits(whole.toString())}${fracDigits ? `.${fracDigits}` : ''}`
  if (whole >= BigInt(1_000_000)) {
    // Compact form for large amounts; the exact value stays available as `exact`.
    const units: Array<[bigint, string]> = [[BigInt(1_000_000_000_000), 'T'], [BigInt(1_000_000_000), 'B'], [BigInt(1_000_000), 'M']]
    for (const [size, suffix] of units) {
      if (whole >= size) {
        const hundredths = (value * BigInt(100)) / (size * scale)
        const text = `${groupDigits((hundredths / BigInt(100)).toString())}.${(hundredths % BigInt(100)).toString().padStart(2, '0')}${suffix}`
        return { text, exact, unit: 'token' }
      }
    }
  }
  if (value === BigInt(0)) return { text: '0', exact: '0', unit: 'token' }
  if (whole === BigInt(0)) {
    // Below one token: keep up to 6 significant fractional digits, never round a non-zero value to 0.
    const digits = frac.toString().padStart(decimals, '0')
    const firstNonZero = digits.search(/[1-9]/)
    const kept = digits.slice(0, Math.min(decimals, firstNonZero + 6)).replace(/0+$/, '')
    return { text: `0.${kept}`, exact, unit: 'token' }
  }
  const shortFrac = fracDigits.slice(0, 4).replace(/0+$/, '')
  return { text: `${groupDigits(whole.toString())}${shortFrac ? `.${shortFrac}` : ''}`, exact, unit: 'token' }
}

/** Sort key for raw integer strings without precision loss. */
export function compareRawDesc(a: string, b: string): number {
  const x = /^\d+$/.test(a) ? BigInt(a) : BigInt(0), y = /^\d+$/.test(b) ? BigInt(b) : BigInt(0)
  return x === y ? 0 : x > y ? -1 : 1
}

/** Observed recipients ordered by amount received (largest first), wallet address as tie-break. */
export function recipientsByAmount(buyers: EarlyBuyer[]): EarlyBuyer[] {
  return [...buyers].sort((a, b) => compareRawDesc(a.boughtRaw, b.boughtRaw) || a.wallet.localeCompare(b.wallet))
}

export type SharedBlockGroups = {
  /** Blocks in which more than one observed recipient received pool-sourced tokens. */
  blocks: Array<{ block: number; wallets: string[] }>
  /** Distinct wallets across those blocks. */
  walletCount: number
  /** True when this regrouping reproduces the engine's own sameBlockCount exactly. */
  matchesEngine: boolean
}

/**
 * T3 breakdown. The engine reports only a count (sameBlockCount) of recipients that shared a block
 * with another recipient; each EarlyBuyer carries the blocks of its own deliveries, so the same
 * grouping can be listed. The list is only shown when it reproduces the engine's count.
 */
export function sharedBlockGroups(intel: Pick<EarlyBuyerIntel, 'buyers' | 'sameBlockCount'>): SharedBlockGroups {
  const byBlock = new Map<number, Set<string>>()
  for (const buyer of intel.buyers) for (const block of buyer.blocks ?? []) {
    const set = byBlock.get(block) ?? new Set<string>(); set.add(buyer.wallet.toLowerCase()); byBlock.set(block, set)
  }
  const blocks = [...byBlock].filter(([, set]) => set.size > 1).sort((a, b) => a[0] - b[0]).map(([block, set]) => ({ block, wallets: [...set].sort() }))
  const walletCount = new Set(blocks.flatMap((b) => b.wallets)).size
  return { blocks, walletCount, matchesEngine: walletCount === intel.sameBlockCount }
}

/** T1 first, then T2; within a tier, larger groups first. Engine order is otherwise arbitrary. */
export function orderedGroups(groups: BuyerGroup[]): BuyerGroup[] {
  const rank = (g: BuyerGroup) => (g.tier === 'T1' ? 0 : 1)
  return [...groups].sort((a, b) => rank(a) - rank(b) || b.wallets.length - a.wallets.length || b.transactions.length - a.transactions.length)
}

export function associationLabel(group: BuyerGroup): string {
  if (group.tier === 'T1') return 'Shared transaction delivery'
  if (group.associationType === 'common_initiator') return 'Common transaction initiator'
  if (group.associationType === 'shared_contract_call') return 'Same block and same contract'
  return 'Association'
}

// Plain-language explanations for the engine's coverage codes. The raw code is always shown next
// to the explanation in Evidence details; an unknown code falls back to the code itself.
const REASONS: Record<string, string> = {
  receipt_cap_50: 'Only the first 50 swap receipts in the window were read. Later deliveries in the window were not examined.',
  acquisition_cap_100: 'Reading stopped at 100 observed deliveries.',
  holdings_wallet_cap_50: 'Current holdings were read for the first 50 recipients only.',
  some_holdings_unpriced: 'Some current balances could not be read.',
  holdings_unavailable: 'Current balances could not be read.',
  current_holdings_not_refreshed: 'Current balances were not refreshed for this request.',
  multi_pool_transaction_unattributed: 'Some transactions swapped through more than one launch pool and were not attributed.',
  swap_liquidity_mixed_transaction_unattributed: 'Some transactions mixed a swap with a liquidity change and were not counted.',
  acquisition_timestamp_unavailable: 'Some delivery timestamps could not be read.',
  trade_timestamp_missing: 'A trade timestamp could not be read.',
  ethereum_time_window_unverified: 'The 60-second Ethereum window could not be confirmed from block timestamps.',
  no_swap_within_bounded_lookahead: 'No swap was found within the search range after first liquidity.',
  window_not_finalized: 'The window is newer than the chain’s finalized block, so results may still change.',
  finality_unavailable: 'Chain finality could not be read.',
  dex_pool_response_cap_50: 'The pool directory returned more than 50 pools; only the first 50 were considered.',
  dex_pool_lookup_unavailable: 'The pool directory could not be reached.',
  pool_discovery_incomplete: 'Pool discovery was incomplete.',
  launch_discovery_incomplete: 'Launch-pool discovery was incomplete.',
  launch_discovery_failed: 'Launch-pool discovery failed.',
  pool_candidate_cap_3: 'More than three candidate pools were found; later candidates were not checked.',
  factory_creation_event_not_found_in_bounded_range: 'A candidate pool’s factory creation event was not found in the searched range.',
  first_liquidity_event_unverified: 'A candidate pool’s first liquidity event could not be verified.',
  historical_block_unavailable: 'A historical block needed for pool chronology could not be read.',
  pool_creation_timestamp_unavailable: 'A candidate pool has no known creation time.',
  factory_creation_evidence_malformed: 'A pool creation record could not be parsed.',
  launch_venue_not_supported_by_v1: 'A candidate pool is on a venue this version does not analyze.',
  venue_not_on_chain: 'A candidate venue does not exist on this chain.',
  launch_block_unavailable: 'The launch block could not be established.',
  no_supported_pool_creation_evidence: 'No supported pool with creation evidence was found.',
  launch_venue_not_verified_in_v1: 'The launch venue is not supported in this version.',
  paid_analysis_required: 'No stored result exists for this token yet. Running a new analysis requires Pro or Elite.',
  distribution_log_cap_1000: 'Creator distributions were read up to 1,000 transfers.',
  distribution_logs_unavailable: 'Creator distributions could not be read.',
  swap_logs_unavailable: 'Swap logs could not be read.',
  receipt_unavailable: 'A transaction receipt could not be read.',
  call_count_budget_exceeded: 'The analysis reached its RPC call limit.',
  estimated_cu_budget_exceeded: 'The analysis reached its compute-unit limit.',
  deadline: 'The analysis reached its time limit.',
  rpc_transport_failed: 'The RPC provider could not be reached.',
  rpc_unconfigured: 'No RPC provider is configured for this chain.',
  analysis_failed: 'The analysis failed.',
  base_and_ethereum_only: 'Early Buyers supports Base and Ethereum only.',
  response_size_cap: 'A provider response exceeded the size limit.',
}

export function reasonLabel(code: string): string {
  if (REASONS[code]) return REASONS[code]
  if (code.startsWith('holdings_')) return `Current balances were not refreshed (${code.slice('holdings_'.length).replace(/_/g, ' ')}).`
  if (/^rpc_http_\d+$/.test(code)) return `The RPC provider returned HTTP ${code.slice('rpc_http_'.length)}.`
  if (/^dex_pool_http_\d+$/.test(code)) return `The pool directory returned HTTP ${code.slice('dex_pool_http_'.length)}.`
  return code
}

/** Coverage codes may be comma-joined (discovery reasons); split, de-duplicate, keep order. */
export function coverageCodes(reasons: string[]): string[] {
  return [...new Set(reasons.flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean))]
}

export const DISCOVERY_OUTCOME_LABEL: Record<string, string> = {
  verified: 'Verified',
  estimated: 'Estimated',
  skipped: 'Not checked',
  unresolved: 'Unresolved',
  excluded: 'Excluded',
}

export type WindowCoverage = {
  /** Nominal window whose swap logs were requested, e.g. "100–119". */
  nominal: string | null
  nominalBlocks: number | null
  /** One-line description of the receipts actually inspected. Never claims more than was read. */
  examined: string
  complete: boolean | null
}

/**
 * Separates the nominal window (blocks whose swap logs were requested) from the receipts actually
 * inspected. Rows stored before receipt coverage was recorded say so rather than implying a full read.
 */
export function windowCoverage(window: EarlyBuyerIntel['window']): WindowCoverage {
  const { startBlock, endBlock, examined } = window
  const nominal = startBlock != null && endBlock != null ? `${startBlock}–${endBlock}` : null
  const nominalBlocks = startBlock != null && endBlock != null ? endBlock - startBlock + 1 : null
  if (nominal == null) return { nominal, nominalBlocks, examined: 'Not established', complete: null }
  if (!examined) return { nominal, nominalBlocks, examined: `${nominalBlocks} nominal blocks · receipt coverage not recorded`, complete: null }
  if (examined.swapTransactions === 0) return { nominal, nominalBlocks, examined: `${nominalBlocks} blocks scanned · no swap transactions found`, complete: true }
  const range = examined.startBlock != null && examined.endBlock != null ? (examined.startBlock === examined.endBlock ? `block ${examined.startBlock}` : `blocks ${examined.startBlock}–${examined.endBlock}`) : 'no blocks'
  const complete = examined.receipts === examined.swapTransactions
  return { nominal, nominalBlocks, examined: complete ? `All ${examined.swapTransactions} swap ${examined.swapTransactions === 1 ? 'transaction' : 'transactions'} inspected (${range})` : `${examined.receipts} of ${examined.swapTransactions} swap transactions inspected · ${range}`, complete }
}

/** When and where current balances were read. Null when no read happened. */
export function holdingsSnapshotLabel(h: CurrentHoldingsSnapshot | undefined): string | null {
  if (!h) return null
  const time = formatTimestamp(h.blockTimestampSec)
  const at = h.blockNumber != null ? `block ${h.blockNumber}${time ? ` · ${time}` : ''}` : `read ${new Date(h.readAtMs).toISOString().replace('T', ' ').slice(0, 19)} UTC (block not reported)`
  return `${at} · ${h.source === 'cache' ? `cached, ${formatAge(h.cacheAgeSec)} old` : 'live read'}`
}

export function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

/** Short cell text and full explanation. Never "bought more", "sold", "profit" or "loss". */
export function balanceComparisonLabel(c: BalanceComparison | undefined): { text: string; detail: string } {
  const caveat = 'Not evidence of a sale, transfer, profit or loss; transfers and acquisitions outside the observed window also change the balance.'
  if (!c || c.relation === 'unavailable') return { text: 'Unavailable', detail: 'Current balance was not read, so no comparison is made.' }
  if (c.relation === 'no_observed_receipt') return { text: '—', detail: 'No observed launch receipt to compare against.' }
  const pct = c.ratioPct != null ? `${c.ratioPct}%` : ''
  if (c.relation === 'exceeds_observed_receipts') return { text: `${pct} · exceeds`, detail: `Current balance exceeds observed launch receipts (${pct} of the amount observed received). ${caveat}` }
  if (c.relation === 'zero_balance') return { text: '0% · zero balance', detail: `Current balance is zero. ${caveat}` }
  if (c.relation === 'equal_to_observed_receipts') return { text: '100%', detail: `Current balance equals observed launch receipts. ${caveat}` }
  return { text: pct, detail: `Current balance is ${pct} of observed launch receipts. ${caveat}` }
}

export function sharedRecipientLabel(r: SharedRecipient): string {
  return r.classification === 'fee_or_distribution_pattern' ? 'Fee or distribution pattern' : 'High-frequency shared recipient'
}

const EXPOSURE_REASONS: Record<string, string> = {
  holdings_incomplete: 'current balances were not read for every observed recipient',
  total_supply_unavailable: 'total supply could not be read',
  total_supply_zero: 'the token reported a total supply of zero',
  balances_exceed_total_supply: 'the observed balances exceed the reported total supply, so the figure is not reliable',
  duplicate_recipients: 'the recipient list contained duplicates',
  no_observed_recipients: 'no recipients were observed',
}
export const exposureReasonLabel = (code: string | null): string => (code && EXPOSURE_REASONS[code]) || code || 'unavailable'

export function formatTimestamp(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}
