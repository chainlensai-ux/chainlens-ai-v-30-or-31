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
  // GOLDRUSH CALL SPLIT, DISCLOSED (UI/trust follow-up task): the real, measured historical-vs-
  // current-price GoldRush call split — see AcceptedEvidenceSkipAudit's own header on
  // priceLotsForWallet.ts. Read by walletScanWorker.ts to attribute [wallet-provider-cost-audit]'s
  // own numbers correctly instead of reporting open-position current-price calls as historical
  // replay waste.
  goldrushCallSplit?: { historicalGoldrushLiveCalls: number; currentPriceGoldrushLiveCalls: number; currentPriceDexLiveCalls: number }
  // WALLET SCANNER PROVIDER/DEX-MODEL SUPPORT AUDIT, DISCLOSED (Wallet Scanner graph/API + DEX
  // model support audit task): additive, real-values-only diagnostic — computed entirely from data
  // this scan already produced (providerDiagnostics, the same structural-coverage event
  // classification pass finalReportAssembler's own gate already runs, normalizationErrors, and the
  // requested-vs-sanitized chain lists) — no new provider calls, no change to FIFO/PnL. See
  // WalletScannerProviderSupportAudit's own header for exactly which fields are real counts vs
  // honestly `null` because this codebase doesn't currently thread that evidence up to this layer.
  walletScannerProviderSupportAudit?: WalletScannerProviderSupportAudit
  // WALLET PnL COVERAGE / RECOVERY AUDIT, DISCLOSED (verified-coverage recovery task): additive,
  // read-only diagnostic explaining per lot why official PnL is withheld when verified coverage is
  // under the gate. Built from the same finalized matchedLots and the same shared canonical
  // predicate the public gate itself uses, so it cannot disagree with that gate. Zero provider
  // calls, zero pricing, no lot created or reclassified. See the module header for the honest
  // limits on which taxonomy reasons this lot-level pass can and cannot populate.
  walletPnlCoverageRecoveryAudit?: import('../lib/walletPnlCoverageRecoveryAudit').WalletPnlCoverageRecoveryAudit
  // SCAN PERFORMANCE SUMMARY, DISCLOSED (perf-sprint task: "a final scanPerformanceSummary showing
  // per-stage timings, percentage of total runtime, critical path, provider latency, cache hit
  // rate, and total scan duration"). Built entirely from real, already-measured values this scan
  // produced — scanTimer's own per-stage marks (see startStageTimer's own header for the honest
  // limit of what it can observe: this orchestration layer's own await points, not time spent
  // inside protected modules' internal call graphs), the real per-chain provider latencies, and
  // real cache hit/miss counts from the two stage caches this file wraps directly. Never estimated
  // or fabricated — a stage this scan didn't reach (e.g. recoveryPolicy on a 'normal' scan) is
  // simply absent from `stages`, not zero-filled.
  scanPerformanceSummary?: ScanPerformanceSummary
}

export type ScanPerformanceSummary = {
  totalMs: number
  // Ordered exactly as this pipeline's own stages executed (JS object key insertion order,
  // matching scanTimer.stages) — this pipeline is a mostly-linear dependency chain (see
  // safeRunRecoveryPolicy/resolveDustSuppressionKeys/priceLotsForWallet's own headers on why each
  // stage's real input depends on the previous stage's real output), so this list IS the critical
  // path, not a heuristic guess at one.
  stages: Array<{ name: string; ms: number; percentOfTotal: number }>
  criticalPath: string[]
  providerLatencyMs: Array<{ chain: string; ms: number }>
  cacheHitRate: {
    providerFetchWindow: { hits: number; misses: number; hitRatePercent: number | null }
    recoveryPolicy: { hits: number; misses: number; hitRatePercent: number | null }
  }
}

// See RunWalletScanResult.walletScannerProviderSupportAudit's own disclosure above for the "why"
// of this field set. Every non-null field here is a real, already-computed value reused (never
// recomputed) from this same scan.
export type WalletScannerProviderSupportAudit = {
  runtimeCommitSha: string | null
  selectedChainMode: ScanModeInput
  enabledChains: SupportedChain[]
  // The raw chain strings the caller actually requested, before SUPPORTED_CHAINS filtering — kept
  // alongside enabledChains so a caller can see exactly what was dropped (e.g. 'bnb'/'robinhood',
  // which this pipeline's providerFetchWindow/holdings/dedupe layer has zero integration for today
  // — see SUPPORTED_CHAINS above; a request for them is an honest, disclosed coverage gap below,
  // never a silent no-op or a fabricated result).
  requestedChains: string[]
  // Real — the only two graph/event-history providers actually integrated anywhere in this
  // pipeline (see providerFetchWindow/types.ts's own ProviderName union). Never lists a provider
  // this codebase doesn't call (e.g. Moralis) — this codebase has no such integration to report.
  providerSourcesConfigured: string[]
  providerSourcesAttempted: string[]
  providerSourcesSucceeded: string[]
  providerSourcesFailed: string[]
  graphSourcesUsed: string[]
  // NOT CURRENTLY WIRED TO THIS LAYER, HONESTLY NULL, DISCLOSED: real per-protocol (V2/V3/V4/
  // concentrated) swap/LP event counts exist only as SHADOW/DEBUG-ONLY diagnostics deep inside
  // src/modules/receiptSwapDecoder (see forensicClassifier.ts's own "never fed into FIFO/pricing/
  // PnL/canonical events" header) and are never threaded up to this report today. Rather than
  // fabricate a count (or a misleading `0`, which would read as "checked, found none" instead of
  // "not tracked here"), these stay `null` — plumbing that evidence up to this layer is a real,
  // separate follow-up, not a same-pass audit wiring fix.
  dexModelsDetected: string[] | null
  v2EventsDetected: number | null
  v3EventsDetected: number | null
  v4EventsDetected: number | null
  concentratedEventsDetected: number | null
  // Real — reused from src/modules/eventClassification's own classification pass (the SAME pass
  // finalReportAssembler's structural-coverage gate already runs this scan, never a second one).
  // `lp_staking` is a real category this classifier can assign (see eventClassification/index.ts),
  // though it currently has no verified LP-contract registry to positively assign it from — an
  // honest 0 here means "none positively identified", never "none exist".
  lpActionsDetected: number
  lpActionsExcludedFromOfficialPnl: number
  // Sum of every non-`genuine_trade_leg`/`unknown`/`dust_non_economic` classified event this scan
  // saw (ordinary_transfer + distribution_airdrop + router_intermediary + bridge + lp_staking) —
  // exactly eventClassification's own FIFO_ELIGIBLE exclusion set, real and already-enforced, not a
  // new gate.
  uncertainEventsExcludedFromOfficialPnl: number
  // Real — normalizationErrors entries with reason === 'duplicate_event' (src/modules/normalization
  // reports these as INFORMATIONAL diagnostics; the actual removal already happened deterministically
  // before FIFO ever saw them — see normalizeEvents' own seen-set dedupe).
  duplicateEventsRemovedBeforeCap: number
  providerFailures: Array<{ chain: SupportedChain; provider: 'goldrush' | 'alchemy'; errorReason: string | null }>
  // Real — every requested-but-unsupported chain (never reaches providerFetchWindow at all) plus
  // every enabled chain whose real fetch came back 'provider_unavailable' this scan. Each entry
  // names WHY, so a caller never has to infer "coverage gap" from an empty result alone.
  coverageGaps: Array<{ chain: string; reason: 'chain_not_supported_by_wallet_scanner' | 'provider_unavailable_this_scan' }>
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
