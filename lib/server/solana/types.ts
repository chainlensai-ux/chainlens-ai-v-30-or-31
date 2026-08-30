// SOLANA-NATIVE INTELLIGENCE ENGINE — SHARED TYPES, DISCLOSED (Solana-native architecture task).
//
// Single source of truth for every type the lib/server/solana/* analyzer modules and
// lib/server/solanaTokenScannerBeta.ts's public facade share. Centralized here (rather than
// re-declared per-analyzer) so every module reasons about the exact same shapes and nothing
// silently drifts between mintAnalyzer/holderAnalyzer/poolAnalyzer/etc.
//
// HONESTY CONTRACT — read before adding a field here: every value this engine reports must be
// real, provider-sourced evidence or an explicit, honest gap. Never a placeholder, never a
// zero standing in for "unknown", never a guessed classification. See each analyzer module's own
// header for what it does and does not attempt.

import type {
  SolanaJupiterResult,
  SolanaHeliusResult,
  SolanaGoldrushResult,
  SolanaOhlcvResult,
  SolanaHeliusHolderResult,
} from '../solanaProviders.ts'
import type { SolanaDeepCreatorAnalysis } from './deepCreatorAnalyzer.ts'
import type { SolanaSupplyControl } from './supplyControlAnalyzer.ts'
import type { SolanaWatchItem } from './watchPlanAnalyzer.ts'
import type { SolanaSupplyTimeline } from './supplyTimelineAnalyzer.ts'
import type { SolanaClusterMap } from './clusterAnalyzer.ts'
import type { SolanaCreatorConfidence } from './creatorConfidenceAnalyzer.ts'
import type { SolanaPatternAnalysis } from './patternAnalyzer.ts'
import type { SolanaDeveloperScore } from './developerScoreAnalyzer.ts'

export type SolanaUnsupportedCheck = {
  check: string
  reason: string
}

/** The EVM checks Token Scanner runs that have no valid Solana equivalent. */
export const SOLANA_UNSUPPORTED_CHECKS: readonly SolanaUnsupportedCheck[] = [
  { check: 'LP lock / burn proof', reason: 'Solana AMM pools do not use ERC-20-style LP tokens — pool authority verification is not fully supported yet.' },
  { check: 'Honeypot simulation', reason: 'Honeypot simulation unavailable on this path.' },
  { check: 'Buy / sell tax simulation', reason: 'Tax simulation unavailable on this path.' },
  { check: 'Contract owner / renounced ownership', reason: 'Solana has no EVM ownership model — mint and freeze authority are checked instead.' },
  { check: 'Deployer transaction history', reason: 'Creator/deployer transaction history is unavailable without Helius Enhanced Transactions (not called by default).' },
]

export type SolanaTopAccountShare = {
  /** Rank, 1-based, by balance descending. */
  rank: number
  /** The token ACCOUNT address (an ATA/vault, not necessarily a wallet) as returned by the RPC — real on-chain data, kept so the Cluster Map can render holder nodes and resolve their owner wallets. */
  address: string
  /** Raw base-unit amount as returned by the RPC (string to avoid precision loss). */
  amountRaw: string
  /** Share of total supply, 0-100, rounded to 2dp. Null when supply is unknown. */
  percentOfSupply: number | null
}

export type SolanaMarketData = {
  priceUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  primaryPoolAddress: string | null
  primaryDexLabel: string | null
  /** SPL mints carry no name/symbol on-chain — read from the matched side of the DexScreener pair. */
  tokenName: string | null
  tokenSymbol: string | null
  /** Pair age, human-readable (e.g. "42d"), derived from DexScreener's pairCreatedAt. Null if absent. */
  pairAgeLabel: string | null
  /** Same real pairCreatedAt evidence as pairAgeLabel, kept as a whole-day integer for scoring (Token Maturity category in solanaCortexRisk.ts) — never re-derived from the label string. Null if absent. */
  pairAgeDays: number | null
  /** Real transaction counts from the same DexScreener pair response's txns.h24 field. */
  txns24h: { buys: number | null; sells: number | null }
  /** Real social links from the same DexScreener pair response's info.websites/info.socials. */
  socials: { website: string | null; twitter: string | null; telegram: string | null; discord: string | null; reddit: string | null }
}

export type SolanaTokenScannerAudit = {
  enabled: boolean
  rpcConfigured: boolean
  mintAddress: string
  tokenProgram: string | null
  supplyResolved: boolean
  decimalsResolved: boolean
  largestAccountsResolved: boolean
  top1Percent: number | null
  top10Percent: number | null
  top20Percent: number | null
  marketProviderUsed: string | null
  marketDataResolved: boolean
  mintAuthorityResolved: boolean
  freezeAuthorityResolved: boolean
  unsupportedChecks: string[]
  evidenceGaps: string[]
}

export type SolanaProviderWiringAudit = {
  mint: string
  enabledProviders: {
    alchemySolana: boolean
    dexScreener: boolean
    jupiter: boolean
    helius: boolean
    goldrushOrCovalent: boolean
  }
  providerCalls: {
    alchemy: {
      called: boolean
      success: boolean
      endpointsUsed: string[]
      resolved: {
        tokenProgram: string | null
        decimals: number | null
        supply: number | null
        mintAuthority: string | null
        freezeAuthority: string | null
        topAccounts: number | null
      }
      errorReason: string | null
    }
    dexScreener: {
      called: boolean
      success: boolean
      pairsFound: number
      selectedPair: string | null
      resolved: {
        price: number | null
        liquidity: number | null
        volume24h: number | null
        marketCap: number | null
        fdv: number | null
        dex: string | null
        pairAge: string | null
      }
      errorReason: string | null
    }
    jupiter: SolanaJupiterResult
    helius: SolanaHeliusResult
    goldrushOrCovalent: SolanaGoldrushResult
    geckoTerminal: { called: boolean; success: boolean; candleCount: number; timeframe: string; errorReason: string | null }
    heliusHolders: SolanaHeliusHolderResult
  }
  mergedResult: {
    tokenName: string | null
    tokenSymbol: string | null
    price: number | null
    liquidity: number | null
    volume24h: number | null
    marketCap: number | null
    supply: number | null
    tokenProgram: string | null
    mintAuthority: string | null
    freezeAuthority: string | null
    top1: number | null
    top10: number | null
    top20: number | null
    holderCount: number | null
    holderCountIsLowerBound: boolean
    poolDex: string | null
    poolAge: string | null
    riskReadAvailable: boolean
  }
  missingEvidence: string[]
  unsupportedChecks: string[]
  confidenceLimits: string[]
}

/**
 * Real, on-chain-verified identity of the program that owns the primary pool account — a single
 * cheap getAccountInfo read, compared against a small map of known, stable, publicly documented
 * Solana AMM program IDs. `label` is null when the owner isn't recognized — `owner` still carries
 * the real address either way, so nothing here ever guesses a wrong program name.
 */
export type SolanaPoolVerdict = 'verified_official_pool' | 'unrecognized_program' | 'unverified'

export type SolanaPoolProgram = {
  resolved: boolean
  poolAddress: string | null
  owner: string | null
  label: string | null
  errorReason: string | null
  /**
   * Pool Authority Engine follow-up, DISCLOSED: a real, differentiated verdict computed purely
   * from the fields above — no new evidence, no PDA/vault-authority derivation (that would need
   * byte-offset struct parsing this codebase can't safely verify without live testing; see this
   * module's own header). 'verified_official_pool' means the pool's owning PROGRAM is confirmed
   * as one of the known AMM programs — it does NOT mean liquidity is locked or withdrawal-proof;
   * see poolVerdictDescription for the exact, non-overclaiming wording.
   */
  verdict: SolanaPoolVerdict
  /**
   * PumpSwap is exclusively Pump.fun's own post-graduation AMM — a pool resolving to that program
   * is a real, definitional fact that the token graduated off the Pump.fun bonding curve, not an
   * inference. Null for every other program (Raydium/Orca/Meteora tokens can launch without ever
   * touching Pump.fun, so migration cannot be safely claimed there).
   */
  migratedFromPumpFun: boolean | null
}

export type SolanaBetaScanResult = {
  solanaBeta: true
  chain: 'solana'
  mintAddress: string
  /** Header identity, resolved Jupiter first, DexScreener fallback, null (mint) last. */
  resolvedTokenName: string | null
  resolvedTokenSymbol: string | null
  poolProgram: SolanaPoolProgram
  jupiter: SolanaJupiterResult
  helius: SolanaHeliusResult
  goldrushOrCovalent: SolanaGoldrushResult
  ohlcv: SolanaOhlcvResult
  heliusHolders: SolanaHeliusHolderResult
  /**
   * DEEP MODE, DISCLOSED: null unless the caller explicitly requested `deep: true` — never run by
   * default. See deepCreatorAnalyzer.ts's own header for the full cost/honesty disclosure. This is
   * the ONLY place Helius Enhanced Transactions (a paid, more expensive API) is ever called.
   */
  deepCreator: SolanaDeepCreatorAnalysis | null
  solanaProviderWiringAudit: SolanaProviderWiringAudit
  /** 'spl-token' | 'spl-token-2022' | null when the owning program could not be read. */
  tokenProgram: string | null
  decimals: number | null
  /** Total supply in whole tokens (decimals applied). Null when unresolved. */
  totalSupply: number | null
  /**
   * null means "no authority" (revoked) ONLY when authorityReadSucceeded is true. When the read
   * failed, both fields are null and the corresponding evidence gap is present — so a caller can
   * never mistake "couldn't check" for "revoked".
   */
  mintAuthority: string | null
  freezeAuthority: string | null
  authorityReadSucceeded: boolean
  holderConcentrationAvailable: boolean
  topAccountConcentration: {
    /** Always labelled as ACCOUNTS, never holders — see holderAnalyzer.ts's own header. */
    accountsSampled: number
    top1Percent: number | null
    top10Percent: number | null
    top20Percent: number | null
    accounts: SolanaTopAccountShare[]
  } | null
  // RELIABILITY FIX, DISCLOSED (Solana holder-concentration reliability task), ADDITIVE: the
  // resolver's own richer status/source/confidence/public-vs-technical-reason view of the SAME
  // concentration read `topAccountConcentration` above already reflects — never a second,
  // independent computation. See holderConcentrationResolver.ts for the full cache/Helius/RPC/
  // supply-only/failure resolution order.
  solanaHolderConcentrationResult: import('./holderConcentrationResolver.ts').SolanaHolderConcentrationResult
  solanaHolderConcentrationAudit: import('./holderConcentrationResolver.ts').SolanaHolderConcentrationAudit
  marketDataAvailable: boolean
  marketData: SolanaMarketData | null
  /** Reduced-confidence risk read. Never 'SAFE'/'verified' — see riskEngine.ts. */
  betaRisk: {
    verdict: 'OPEN_CHECK' | 'CAUTION' | 'HIGH_RISK'
    confidence: 'LOW' | 'MEDIUM'
    reasons: string[]
  }
  solanaEvidenceGaps: string[]
  unsupportedChecks: SolanaUnsupportedCheck[]
  solanaTokenScannerAudit: SolanaTokenScannerAudit
  /** Real supply/inflation analysis (Token-2022 extensions included) — see supplyControlAnalyzer.ts. */
  supplyControl: SolanaSupplyControl
  /** Evidence-driven monitoring recommendations, empty array when no active risk signal is present — see watchPlanAnalyzer.ts. */
  watchPlan: SolanaWatchItem[]
  /** Real, honestly-scoped mint/pool history — see supplyTimelineAnalyzer.ts for what can and cannot be reconstructed. */
  supplyTimeline: SolanaSupplyTimeline
  /** null unless opts.deepCluster was explicitly requested — see clusterAnalyzer.ts for scope. */
  clusterMap: SolanaClusterMap | null
  /** Tiered Confirmed/Likely/Possible/Unknown creator verdict — see creatorConfidenceAnalyzer.ts. */
  creatorConfidence: SolanaCreatorConfidence
  /** Real, honestly-scoped pattern checks — see patternAnalyzer.ts for what can and cannot be verified. */
  patternAnalysis: SolanaPatternAnalysis
  /** Explainable composite score built from every signal above — see developerScoreAnalyzer.ts. */
  developerScore: SolanaDeveloperScore
}

export type SolanaBetaScanFailure = {
  solanaBeta: true
  chain: 'solana'
  status: 'not_enabled' | 'not_configured' | 'mint_not_found' | 'rpc_error'
  error: string
  solanaTokenScannerAudit: SolanaTokenScannerAudit
}

export function emptySolanaAudit(mintAddress: string, enabled: boolean, rpcConfigured: boolean): SolanaTokenScannerAudit {
  return {
    enabled,
    rpcConfigured,
    mintAddress,
    tokenProgram: null,
    supplyResolved: false,
    decimalsResolved: false,
    largestAccountsResolved: false,
    top1Percent: null,
    top10Percent: null,
    top20Percent: null,
    marketProviderUsed: null,
    marketDataResolved: false,
    mintAuthorityResolved: false,
    freezeAuthorityResolved: false,
    unsupportedChecks: SOLANA_UNSUPPORTED_CHECKS.map((u) => u.check),
    evidenceGaps: [],
  }
}
