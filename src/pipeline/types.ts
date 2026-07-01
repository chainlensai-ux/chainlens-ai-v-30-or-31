// MODULE 9 — pipelineOrchestrator: type definitions.
//
// Wires together all 8 existing modules into the single runWalletScan() entry point. This layer
// adds no new domain logic of its own — it only sequences calls into the modules, wraps each
// downstream stage in a fallback-safe wrapper (Architecture Step 7), and merges the result via
// finalReportAssembler (never re-implementing what that module already does).

import type { SupportedChain } from '../modules/providerFetchWindow/types'
import type { NormalizationError } from '../modules/normalization/types'
import type { FinalReport } from '../modules/finalReportAssembler/types'

export type ScanModeInput = 'normal' | 'deep'

export type RunWalletScanParams = {
  walletAddress: string
  chains: string[]
  scanMode: ScanModeInput
}

// Architecture Step 9's "output shape" for the orchestrator's public entry point: the exact
// Step 5 unified report shape, PLUS normalizationErrors as a sibling top-level field.
export type RunWalletScanResult = FinalReport & {
  normalizationErrors: NormalizationError[]
}

export type PreScanValidation = {
  valid: boolean
  errors: string[]
  sanitizedChains: SupportedChain[]
}

// Only chains the existing modules actually support (providerFetchWindow's SupportedChain union).
// An unrecognized chain string in the request is dropped, never guessed at or force-coerced.
export const SUPPORTED_CHAINS: SupportedChain[] = ['base', 'eth']

// Architecture Step 1: intel window is a fixed architectural constant, never a per-request input.
export const INTEL_WINDOW_DAYS = 90

// Illustrative constant used only by computeWindowCoverage's honest-approximation formula (see
// utils.ts) — converts recovered historical pages into an estimated number of additional
// real-data days covered. Not a precise measurement (no module in this delivery tracks the exact
// date range a recovered page reached); always conservative (never claims more real coverage than
// the recovery pass could plausibly have reached).
export const APPROX_DAYS_COVERED_PER_RECOVERED_PAGE = 15
