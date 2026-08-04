// MODULE 9 — pipelineOrchestrator: type definitions.
//
// Wires together all 8 existing modules into the single runWalletScan() entry point. This layer
// adds no new domain logic of its own — it only sequences calls into the modules, wraps each
// downstream stage in a fallback-safe wrapper (Architecture Step 7), and merges the result via
// finalReportAssembler (never re-implementing what that module already does).

import type { SupportedChain } from '../modules/providerFetchWindow/types'
import type { NormalizationError } from '../modules/normalization/types'
import type { FinalReport } from '../modules/finalReportAssembler/types'
import type { WalletConditionSection } from './walletConditionMessages'
import type { PnlReconciliationSummary } from '../lib/pnlReconciliation'
import type { ScanDeterminismAudit } from '../lib/scanDeterminismAudit'
import type { CanonicalSampleManifestAudit } from '../lib/canonicalPnlSampleManifest'

export type ScanModeInput = 'normal' | 'deep'

export type RunWalletScanParams = {
  walletAddress: string
  chains: string[]
  scanMode: ScanModeInput
  // OPTIONAL, ADDITIVE, DISCLOSED — see fifoEngine/types.ts's own CanonicalBalanceLookup header
  // (found live: confirmed architectural gap behind a false ~$545k unrealized PnL — fifoEngine's
  // event-replay-derived open quantity was never cross-checked against a real current balance).
  // Omitted by every existing caller that hasn't opted in — zero behavior change unless supplied.
  canonicalBalanceLookup?: import('../modules/fifoEngine/types').CanonicalBalanceLookup
  // Diagnostics-only enrichment for the unrealized-PnL reconciliation report (symbol/decimals/
  // quarantine flag + current-price source). Sourced from the SAME canonical holdings snapshot the
  // balance lookup above already uses — never an additional holdings fetch.
  unrealizedReconciliationDiagnostics?: import('../modules/fifoEngine/types').UnrealizedReconciliationDiagnosticsContext
  // EXPLICIT REFRESH, DISCLOSED (durable-canonical-sample follow-up task, requirement #7): default
  // false, no public automatic refresh — a rescan reproduces the previously published canonical
  // sample unless this is deliberately set true, in which case a NEW manifest version is created
  // (retaining audit linkage to the prior one) and the response discloses `sampleUpdated: true`.
  refreshCanonicalPnlSample?: boolean
}

// Architecture Step 9's "output shape" for the orchestrator's public entry point: the exact
// Step 5 unified report shape, PLUS normalizationErrors and walletConditionMessages as sibling
// top-level fields — same additive pattern as normalizationErrors, not a change to FinalReport's
// own protected type (src/modules/finalReportAssembler/types.ts is never touched).
export type RunWalletScanResult = FinalReport & {
  normalizationErrors: NormalizationError[]
  walletConditionMessages: WalletConditionSection[]
  // BOUNDED-SAMPLE UI WIRING, DISCLOSED (bounded-PnL-UI follow-up task): runWalletScan() has always
  // returned this at runtime (it spreads `...finalReport`, and finalReportAssembler.assemble()
  // already attaches `reconciliationSummary` — see FinalReportAssemblerOutput) — this type simply
  // never declared it, so no frontend/API caller could read it without a cast. Declared here,
  // additively, so the real `publicPnlGateAudit`/`warning` fields (verified lot count, pricing
  // coverage, disclosed unresolved-exit count) can reach the Wallet Scanner UI.
  reconciliationSummary?: PnlReconciliationSummary
  // SCAN DETERMINISM AUDIT, DISCLOSED (determinism follow-up task, requirement #6): additive,
  // real-values-only fingerprint of the canonical matched-lot/realized-PnL result — see
  // src/lib/scanDeterminismAudit.ts's own header.
  scanDeterminismAudit?: ScanDeterminismAudit
  // DURABLE CANONICAL SAMPLE MANIFEST, DISCLOSED (durable-canonical-sample follow-up task): see
  // src/lib/canonicalPnlSampleManifest.ts's own header. `sampleUpdated` is true only on an explicit
  // refresh (requirement #7) — never set on ordinary provider-availability-driven variance.
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit
  sampleUpdated?: boolean
  // MANIFEST FAST-PATH AUDIT, DISCLOSED (canonical-manifest-fast-path follow-up task, Parts B/C):
  // see src/pipeline/priceLotsForWallet.ts's own ManifestFastPathAudit header.
  manifestFastPathAudit?: import('./priceLotsForWallet').ManifestFastPathAudit
}

export type PreScanValidation = {
  valid: boolean
  errors: string[]
  sanitizedChains: SupportedChain[]
}

// Only chains the existing modules actually support (providerFetchWindow's SupportedChain union).
// An unrecognized chain string in the request is dropped, never guessed at or force-coerced.
export const SUPPORTED_CHAINS: SupportedChain[] = ['base', 'eth', 'arbitrum', 'hyperevm']

// Architecture Step 1: intel window is a fixed architectural constant, never a per-request input.
export const INTEL_WINDOW_DAYS = 180

// Illustrative constant used only by computeWindowCoverage's honest-approximation formula (see
// utils.ts) — converts recovered historical pages into an estimated number of additional
// real-data days covered. Not a precise measurement (no module in this delivery tracks the exact
// date range a recovered page reached); always conservative (never claims more real coverage than
// the recovery pass could plausibly have reached).
export const APPROX_DAYS_COVERED_PER_RECOVERED_PAGE = 15
