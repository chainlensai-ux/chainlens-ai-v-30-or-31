// SOLANA PROVIDER MERGE, DISCLOSED (Solana-native architecture task): the orchestrator. Calls
// every analyzer in this directory in sequence, merges Alchemy + DexScreener + Jupiter + Helius +
// GeckoTerminal evidence into one SolanaBetaScanResult and one solanaProviderWiringAudit. This is
// the ONLY place that assembles the final result — every analyzer above stays a pure, focused,
// independently testable read. GoldRush/Covalent is deliberately never called here — see
// solanaProviders.ts's solanaGoldrushEnrichment for why (no verified Solana chain slug exists
// anywhere in this codebase to call one safely).

import {
  isSolanaBetaFeatureEnabled,
  isSolanaRpcConfigured,
  getSolanaRpcUrl,
  isJupiterConfigured,
  isHeliusConfigured,
  isDexScreenerAvailable,
  isGoldrushKeyPresent,
} from '../solanaChainConfig.ts'
import { solanaGoldrushEnrichment } from '../solanaProviders.ts'
import type { RpcFetch } from './rpcClient.ts'
import { analyzeSolanaMint } from './mintAnalyzer.ts'
import { analyzeSolanaHolders } from './holderAnalyzer.ts'
import { analyzeSolanaMarket, analyzeSolanaCandles } from './marketAnalyzer.ts'
import { resolveSolanaMetadata } from './metadataResolver.ts'
import { analyzeSolanaCreator } from './creatorAnalyzer.ts'
import { analyzeSolanaDeepCreator } from './deepCreatorAnalyzer.ts'
import { analyzeSolanaPool } from './poolAnalyzer.ts'
import { scoreSolanaBeta } from './riskEngine.ts'
import { buildSolanaSupplyControl } from './supplyControlAnalyzer.ts'
import { buildSolanaWatchPlan } from './watchPlanAnalyzer.ts'
import { buildSolanaSupplyTimeline } from './supplyTimelineAnalyzer.ts'
import { analyzeSolanaCluster, type SolanaClusterMap } from './clusterAnalyzer.ts'
import {
  SOLANA_UNSUPPORTED_CHECKS,
  emptySolanaAudit,
  type SolanaBetaScanResult,
  type SolanaBetaScanFailure,
  type SolanaProviderWiringAudit,
} from './types.ts'

/**
 * The ONLY Solana scan entry point. Never calls any EVM scanner, LP-proof, honeypot, tax, or
 * deployer helper — by construction, since this module and everything it imports contains none of
 * them. `fetchImpl`/`rpcUrl` overrides exist purely so tests can exercise the real logic without
 * network access.
 */
export async function runSolanaProviderMerge(
  mintAddress: string,
  opts: { fetchImpl?: RpcFetch; rpcUrl?: string | null; deep?: boolean; deepCluster?: boolean } = {},
): Promise<SolanaBetaScanResult | SolanaBetaScanFailure> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const enabled = isSolanaBetaFeatureEnabled()
  const rpcConfigured = isSolanaRpcConfigured()
  const audit = emptySolanaAudit(mintAddress, enabled, rpcConfigured)

  if (!enabled) {
    return { solanaBeta: true, chain: 'solana', status: 'not_enabled', error: 'Solana Beta is not enabled.', solanaTokenScannerAudit: audit }
  }
  const rpcUrl = opts.rpcUrl !== undefined ? opts.rpcUrl : getSolanaRpcUrl()
  if (!rpcUrl) {
    return { solanaBeta: true, chain: 'solana', status: 'not_configured', error: 'Solana Beta is not configured yet.', solanaTokenScannerAudit: audit }
  }

  // ── 1. Mint identity + authority + supply (Alchemy) ─────────────────────────
  const mint = await analyzeSolanaMint(mintAddress, rpcUrl, fetchImpl)
  if (!mint.ok) {
    audit.evidenceGaps = mint.evidenceGaps
    return { solanaBeta: true, chain: 'solana', status: mint.status, error: mint.error, solanaTokenScannerAudit: audit }
  }
  audit.tokenProgram = mint.tokenProgram
  audit.decimalsResolved = mint.decimals != null
  audit.mintAuthorityResolved = mint.authorityReadSucceeded
  audit.freezeAuthorityResolved = mint.authorityReadSucceeded
  audit.supplyResolved = mint.totalSupply != null
  const evidenceGaps: string[] = [...mint.evidenceGaps]

  // ── 2. Holder intelligence (Alchemy top accounts + Helius real holder count) ─
  const holders = await analyzeSolanaHolders({ mintAddress, rpcUrl, fetchImpl, rawSupply: mint.rawSupply })
  audit.largestAccountsResolved = holders.topAccountConcentration != null
  audit.top1Percent = holders.topAccountConcentration?.top1Percent ?? null
  audit.top10Percent = holders.topAccountConcentration?.top10Percent ?? null
  audit.top20Percent = holders.topAccountConcentration?.top20Percent ?? null
  evidenceGaps.push(...holders.evidenceGaps)

  // ── 3. Market data (DexScreener — primary) ──────────────────────────────────
  const market = await analyzeSolanaMarket(mintAddress, fetchImpl)
  audit.marketProviderUsed = market.provider
  audit.marketDataResolved = market.data != null
  if (!market.data) evidenceGaps.push('No Solana market/pool data found via DexScreener — price, liquidity and volume unavailable.')

  // ── 4. Metadata identity (Jupiter first, DexScreener fallback) ─────────────
  const metadata = await resolveSolanaMetadata({
    mintAddress, fetchImpl,
    dexScreenerName: market.data?.tokenName ?? null,
    dexScreenerSymbol: market.data?.tokenSymbol ?? null,
  })
  evidenceGaps.push(...metadata.evidenceGaps)

  // ── 5. Creator/dev activity signal (Helius, lightweight only) ──────────────
  const creator = await analyzeSolanaCreator(mintAddress, fetchImpl)
  evidenceGaps.push(...creator.evidenceGaps)

  // ── 5b. Deep Mode creator trace — EXPLICIT OPT-IN ONLY, never run by default ──
  // See deepCreatorAnalyzer.ts's header: this is the ONLY OTHER path (besides 5c below) that calls
  // Helius Enhanced Transactions (paid, more expensive) anywhere in this engine, and only when
  // opts.deep is true.
  const deepCreator = opts.deep === true ? await analyzeSolanaDeepCreator(mintAddress, fetchImpl) : null
  if (deepCreator) evidenceGaps.push(...deepCreator.evidenceGaps)

  // ── 5c. Deep Mode cluster/funding trace — EXPLICIT OPT-IN ONLY, one further hop past the
  // creator wallet. Requires the creator trace above (runs it if not already present via opts.deep
  // so a caller only needs to pass opts.deepCluster). See clusterAnalyzer.ts's header for exactly
  // what relationship types are and are not attempted.
  let clusterMap: SolanaClusterMap | null = null
  if (opts.deepCluster === true) {
    const creatorTraceForCluster = deepCreator?.creatorTrace ?? (await analyzeSolanaDeepCreator(mintAddress, fetchImpl)).creatorTrace
    clusterMap = await analyzeSolanaCluster({ mintAddress, creatorTrace: creatorTraceForCluster, fetchImpl })
    if (clusterMap.evidenceCount === 0) evidenceGaps.push('No verified wallet relationships found for this mint\'s creator wallet.')
  }

  // ── 6. GoldRush / Covalent (no verified Solana endpoint — cleanly unavailable) ─
  const goldrushOrCovalent = solanaGoldrushEnrichment()

  // ── 7. GeckoTerminal OHLCV candles (free, keyless — real Price Chart data) ──
  const ohlcv = await analyzeSolanaCandles(market.data?.primaryPoolAddress ?? null, fetchImpl)
  if (market.data?.primaryPoolAddress && !ohlcv.success) evidenceGaps.push('Candle history could not be indexed for this pool — Price Chart shows a live snapshot only.')

  // ── 8. Pool program identity (real getAccountInfo owner read) ──────────────
  const poolAddress = market.data?.primaryPoolAddress ?? null
  const pool = await analyzeSolanaPool({ poolAddress, rpcUrl, fetchImpl })
  evidenceGaps.push(...pool.evidenceGaps)

  // ── 9. Risk read (Solana-native — see riskEngine.ts) ────────────────────────
  const betaRisk = scoreSolanaBeta({
    mintAuthority: mint.mintAuthority,
    freezeAuthority: mint.freezeAuthority,
    authorityReadSucceeded: mint.authorityReadSucceeded,
    top1Percent: holders.topAccountConcentration?.top1Percent ?? null,
    marketDataAvailable: market.data != null,
    liquidityUsd: market.data?.liquidityUsd ?? null,
    evidenceGapCount: evidenceGaps.length,
  })

  audit.evidenceGaps = evidenceGaps

  // ── 10. Supply Control / Watch Plan / Supply Timeline — derived purely from evidence already
  // gathered above, no new provider calls. ────────────────────────────────────────────────────
  const supplyControl = buildSolanaSupplyControl(mint)
  const watchPlan = buildSolanaWatchPlan({
    supplyControl,
    top1Percent: holders.topAccountConcentration?.top1Percent ?? null,
    top10Percent: holders.topAccountConcentration?.top10Percent ?? null,
    marketData: market.data,
    poolProgram: pool.poolProgram,
    deepCreator,
  })
  const supplyTimeline = buildSolanaSupplyTimeline({ mint, poolProgram: pool.poolProgram, marketData: market.data, deepCreator })

  const wiringAudit: SolanaProviderWiringAudit = {
    mint: mintAddress,
    enabledProviders: {
      alchemySolana: true,
      dexScreener: isDexScreenerAvailable(),
      jupiter: isJupiterConfigured(),
      helius: isHeliusConfigured(),
      goldrushOrCovalent: isGoldrushKeyPresent(),
    },
    providerCalls: {
      alchemy: {
        called: true,
        success: mint.authorityReadSucceeded && mint.totalSupply != null,
        endpointsUsed: poolAddress ? ['getAccountInfo', 'getTokenSupply', 'getTokenLargestAccounts', 'getAccountInfo (pool)'] : ['getAccountInfo', 'getTokenSupply', 'getTokenLargestAccounts'],
        resolved: {
          tokenProgram: mint.tokenProgram,
          decimals: mint.decimals,
          supply: mint.totalSupply,
          mintAuthority: mint.mintAuthority,
          freezeAuthority: mint.freezeAuthority,
          topAccounts: holders.topAccountConcentration?.accountsSampled ?? null,
        },
        errorReason: mint.authorityReadSucceeded ? null : 'mint_authority_parse_failed',
      },
      dexScreener: {
        called: true,
        success: market.data != null,
        pairsFound: market.pairsFound,
        selectedPair: market.data?.primaryPoolAddress ?? null,
        resolved: {
          price: market.data?.priceUsd ?? null,
          liquidity: market.data?.liquidityUsd ?? null,
          volume24h: market.data?.volume24hUsd ?? null,
          marketCap: market.data?.marketCapUsd ?? null,
          fdv: market.data?.fdvUsd ?? null,
          dex: market.data?.primaryDexLabel ?? null,
          pairAge: market.data?.pairAgeLabel ?? null,
        },
        errorReason: market.errorReason,
      },
      jupiter: metadata.jupiter,
      helius: creator.helius,
      goldrushOrCovalent,
      geckoTerminal: { called: ohlcv.called, success: ohlcv.success, candleCount: ohlcv.candles.length, timeframe: ohlcv.timeframe, errorReason: ohlcv.errorReason },
      heliusHolders: holders.heliusHolders,
    },
    mergedResult: {
      tokenName: metadata.resolvedTokenName,
      tokenSymbol: metadata.resolvedTokenSymbol,
      price: market.data?.priceUsd ?? metadata.jupiter.resolved.price ?? null,
      liquidity: market.data?.liquidityUsd ?? null,
      volume24h: market.data?.volume24hUsd ?? null,
      marketCap: market.data?.marketCapUsd ?? null,
      supply: mint.totalSupply,
      tokenProgram: mint.tokenProgram,
      mintAuthority: mint.mintAuthority,
      freezeAuthority: mint.freezeAuthority,
      top1: holders.topAccountConcentration?.top1Percent ?? null,
      top10: holders.topAccountConcentration?.top10Percent ?? null,
      top20: holders.topAccountConcentration?.top20Percent ?? null,
      holderCount: holders.heliusHolders.holderCount ?? goldrushOrCovalent.resolved.holderCount,
      holderCountIsLowerBound: holders.heliusHolders.isLowerBound,
      poolDex: market.data?.primaryDexLabel ?? null,
      poolAge: market.data?.pairAgeLabel ?? null,
      riskReadAvailable: mint.authorityReadSucceeded || market.data != null,
    },
    missingEvidence: evidenceGaps,
    unsupportedChecks: SOLANA_UNSUPPORTED_CHECKS.map((u) => u.check),
    confidenceLimits: betaRisk.reasons,
  }

  return {
    solanaBeta: true,
    chain: 'solana',
    mintAddress,
    resolvedTokenName: metadata.resolvedTokenName,
    resolvedTokenSymbol: metadata.resolvedTokenSymbol,
    poolProgram: pool.poolProgram,
    jupiter: metadata.jupiter,
    helius: creator.helius,
    goldrushOrCovalent,
    ohlcv,
    heliusHolders: holders.heliusHolders,
    deepCreator,
    solanaProviderWiringAudit: wiringAudit,
    tokenProgram: mint.tokenProgram,
    decimals: mint.decimals,
    totalSupply: mint.totalSupply,
    mintAuthority: mint.mintAuthority,
    freezeAuthority: mint.freezeAuthority,
    authorityReadSucceeded: mint.authorityReadSucceeded,
    holderConcentrationAvailable: holders.topAccountConcentration != null,
    topAccountConcentration: holders.topAccountConcentration,
    marketDataAvailable: market.data != null,
    marketData: market.data,
    betaRisk,
    solanaEvidenceGaps: evidenceGaps,
    unsupportedChecks: [...SOLANA_UNSUPPORTED_CHECKS],
    solanaTokenScannerAudit: audit,
    supplyControl,
    watchPlan,
    supplyTimeline,
    clusterMap,
  }
}
