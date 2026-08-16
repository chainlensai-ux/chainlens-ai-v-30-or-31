/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { POST as tokenScannerPost } from '@/app/api/token/route'
import { reconcileBaseRadarLp } from '@/lib/server/baseRadarLpReconciliation'
import { getRadarValuationBasis, resolveBaseRadarMarketCap } from '@/lib/baseRadarValuation'
import { fetchGoldRushHolderCount, fetchGoldRushConcentration, type ConcentrationResult } from '@/lib/server/goldrushHolderCount'
import { buildBaseRadarHolderEvidence } from '@/lib/baseRadarHolderEvidence'
import { resolveBaseRadarOwnershipFallback, type BaseRadarOwnershipFallback } from '@/lib/server/baseRadarOwnership'

// ROBINHOOD-CHAIN-SUPPORT, DISCLOSED (explicitly confirmed: "yes the token scanner works with
// robinhood" — Token Scanner's own engine already supports scanning Robinhood-chain contracts;
// this route was just never updated to recognize 'robinhood' as a valid chain, so opening the
// drawer for a Robinhood token 400'd with "Unsupported chain" before ever reaching Token Scanner).
type ChainKey = 'base' | 'eth' | 'robinhood'
type SectionKey = 'market' | 'lp' | 'holders' | 'deployer' | 'security' | 'socials'

type CacheSection = {
  value: unknown
  expiresAt: number
}

type EnrichmentCacheEntry = Partial<Record<SectionKey, CacheSection>> & {
  name?: CacheSection
  symbol?: CacheSection
  priceChart?: CacheSection
  fetchedAt?: string
}

type EnrichmentDiagnostics = {
  drawerEnrichmentAttempted: boolean
  drawerEnrichmentCacheHit: boolean
  drawerEnrichmentDedupeHit: boolean
  tokenScannerReuse: boolean
  marketEnriched: boolean
  lpEnriched: boolean
  holdersEnriched: boolean
  deployerEnriched: boolean
  securityEnriched: boolean
  socialsEnriched: boolean
  missingDrawerFields: string[]
  enrichmentDurationMs: number
}

const MARKET_TTL_MS = 60_000
const LP_TTL_MS = 3 * 60_000
const STATIC_TTL_MS = 10 * 60_000
const cache = new Map<string, EnrichmentCacheEntry>()
const inFlight = new Map<string, Promise<{ payload: Record<string, unknown>; diagnostics: EnrichmentDiagnostics }>>()

function normalizeChain(value: string | null): ChainKey | null {
  const chain = String(value ?? 'base').toLowerCase()
  if (chain === 'base') return 'base'
  if (chain === 'eth' || chain === 'ethereum') return 'eth'
  if (chain === 'robinhood') return 'robinhood'
  return null
}

function cacheKey(chain: ChainKey, contract: string) {
  return `${chain}:${contract.toLowerCase()}`
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

// Derives a holder-concentration risk label from indexed top-holder percentages —
// never reports "Open Check" when top10/top20 evidence is actually available.
function deriveConcentrationRisk(top10: number | null, top20: number | null): "extreme" | "high" | "medium" | "lower" | null {
  if (top10 == null && top20 == null) return null
  if ((top10 != null && top10 >= 80) || (top20 != null && top20 >= 90)) return "extreme"
  if (top10 != null && top10 >= 60) return "high"
  if (top10 != null && top10 >= 40) return "medium"
  return "lower"
}


function publicAddress(value: unknown): string | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.trim()) ? value.trim() : null
}


function firstPublicAddress(...values: unknown[]): string | null {
  for (const value of values) {
    const address = publicAddress(value)
    if (address) return address
  }
  return null
}

function evidenceAddress(evidence: unknown, key: string): string | null {
  const rows = Array.isArray(evidence) ? evidence : typeof evidence === 'string' ? [evidence] : []
  const pattern = new RegExp(`(?:^|\b)${key}=(${String.raw`0x[a-fA-F0-9]{40}`})(?:\b|$)`, 'i')
  for (const row of rows) {
    if (typeof row !== 'string') continue
    const match = row.match(pattern)
    const address = publicAddress(match?.[1])
    if (address) return address
  }
  return null
}

function teamControlledLpController(lpControl: unknown): string | null {
  if (!lpControl || typeof lpControl !== 'object') return null
  const raw = lpControl as Record<string, unknown>
  if (raw.status !== 'team_controlled') return null
  return firstPublicAddress(raw.controller, raw.lpController, raw.topHolder, raw.top_holder, raw.owner, raw.wallet, raw.holder) ?? evidenceAddress(raw.evidence, 'top_holder') ?? null
}

// OWNERSHIP-RPC-FALLBACK, DISCLOSED: fallbackOwnership is a real, independently-fetched on-chain
// owner() read (see lib/server/baseRadarOwnership.ts) — used ONLY when Token Scanner's own resolver
// genuinely has no verified answer, never overriding a real value it DID find.
function ownershipSummary(devOwnership: unknown, fallbackOwnership: BaseRadarOwnershipFallback | null): Record<string, unknown> {
  const raw = devOwnership && typeof devOwnership === 'object' ? devOwnership as Record<string, unknown> : {}
  const ownershipVerified = raw.ownershipVerified === true
  const ownerAddress = publicAddress(raw.ownerAddress)
  const adminAddress = publicAddress(raw.adminAddress)
  const isRenounced = ownershipVerified && raw.isRenounced === true
  const ownershipStatus = !ownershipVerified ? 'open_check' : isRenounced ? 'renounced' : (ownerAddress || adminAddress) ? 'active_owner' : 'open_check'
  if (!ownershipVerified && fallbackOwnership) {
    return {
      ...raw,
      ownerAddress: fallbackOwnership.ownerAddress,
      adminAddress,
      isRenounced: fallbackOwnership.isRenounced,
      ownershipVerified: fallbackOwnership.ownershipVerified,
      ownershipStatus: fallbackOwnership.ownershipStatus,
      ownershipLabel: fallbackOwnership.ownershipLabel,
      ownershipSource: fallbackOwnership.source,
    }
  }
  // OWNERSHIP-LABEL-WORDING, DISCLOSED (reported: "Open Check / Not verified" reads like something
  // broken rather than an honest gap — especially confusing since Token Scanner's own resolver AND
  // the independent RPC owner() fallback above both already tried before landing here). Neither
  // check found a standard Ownable owner/admin address for this token — most commonly because the
  // contract genuinely doesn't implement that pattern at all (very common; not every token has an
  // owner() function), not because a check failed to run. Reworded to say exactly that, without
  // overstating confidence that no privileged control exists via a different pattern (AccessControl
  // roles, a proxy admin slot, etc. — this only ever checked the standard Ownable selector).
  const ownershipLabel = ownershipStatus === 'renounced' ? 'Renounced ownership' : ownershipStatus === 'active_owner' ? 'Active owner/admin verified' : 'No standard owner/admin pattern confirmed'
  return { ...raw, ownerAddress, adminAddress, isRenounced, ownershipVerified, ownershipStatus, ownershipLabel }
}

function confirmedClusterEvidence(params: { edgeCount: number; matchedLinkedWallets: number; linkedWalletSupply: number | null; devClusterSupply: number | null }): boolean {
  // Holder nodes alone are not confirmed cluster evidence. Only real links, matched linked wallets,
  // or positive supply overlap should confirm a cluster.
  if (params.edgeCount > 0) return true
  if (params.matchedLinkedWallets > 0) return true
  if (params.linkedWalletSupply != null && params.linkedWalletSupply > 0) return true
  if (params.devClusterSupply != null && params.devClusterSupply > 0) return true
  return false
}

function hasValue(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return true
}

function fromCache(entry: EnrichmentCacheEntry | undefined, now: number): Record<string, unknown> | null {
  if (!entry) return null
  const required: SectionKey[] = ['market', 'lp', 'holders', 'deployer', 'security', 'socials']
  if (!required.every((key) => entry[key]?.expiresAt && entry[key]!.expiresAt > now)) return null
  return {
    name: entry.name?.value ?? null,
    symbol: entry.symbol?.value ?? null,
    market: entry.market?.value ?? null,
    lp: entry.lp?.value ?? null,
    holders: entry.holders?.value ?? null,
    deployer: entry.deployer?.value ?? null,
    security: entry.security?.value ?? null,
    socials: entry.socials?.value ?? null,
    priceChart: entry.priceChart?.value ?? null,
    fetchedAt: entry.fetchedAt ?? new Date(now).toISOString(),
  }
}

function missingFields(payload: Record<string, any>): string[] {
  const missing: string[] = []
  const lp = payload.lp ?? {}
  const holders = payload.holders ?? {}
  const deployer = payload.deployer ?? {}
  const socials = payload.socials ?? {}
  const security = payload.security ?? {}
  if (!hasValue(payload.market?.liquidityUsd)) missing.push('market.liquidityUsd')
  if (!hasValue(lp.lpControl?.status) && !hasValue(lp.lpLockStatus)) missing.push('lp.controlOrLockStatus')
  if (!hasValue(lp.lpController)) missing.push('lp.lpController')
  if (!hasValue(holders.top10)) missing.push('holders.top10')
  if (!hasValue(holders.holderCount)) missing.push('holders.holderCount')
  if (!hasValue(deployer.deployerAddress)) missing.push('deployer.address')
  if (!hasValue(security.honeypot) && !hasValue(security.contractFlags)) missing.push('security.flags')
  if (!hasValue(socials.website) && !hasValue(socials.twitter) && !hasValue(socials.telegram)) missing.push('socials.projectLinks')
  return missing
}

function publicEvidenceLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.toLowerCase()
  if (normalized.includes('moralis_transfer_fallback')) return 'Transfer inference'
  if (normalized.includes('moralis_token_transfers')) return 'Transfer evidence'
  if (normalized.includes('goldrush_token_holders')) return 'Holder evidence'
  if (normalized.includes('geckoterminal+goldrush') || normalized.includes('market + holder evidence')) return 'Market + holder evidence'
  if (normalized.includes('honeypot_is') || normalized.includes('honeypot.is') || normalized.includes('honeypot')) return 'Simulation evidence'
  if (normalized.includes('dexscreener')) return 'Market data'
  if (normalized.includes('geckoterminal') || normalized.includes('goldrush')) return 'Market + holder evidence'
  if (normalized.includes('transfer')) return 'Transfer inference'
  if (normalized.includes('simulation')) return 'Simulation evidence'
  if (normalized.includes('market') || normalized.includes('holder')) return 'Market + holder evidence'
  if (normalized.includes('dex_data') || normalized.includes('rpc')) return 'Market + on-chain evidence'
  return value.trim()
}

function sanitizeProviderText(value: string): string {
  return value
    .replace(/geckoterminal\+goldrush/gi, 'Market + holder evidence')
    .replace(/goldrush_token_holders/gi, 'Holder evidence')
    .replace(/moralis_transfer_fallback/gi, 'Transfer inference')
    .replace(/moralis_token_transfers/gi, 'Transfer evidence')
    // Only replace explicit provider-name forms (e.g. "honeypot.is", "honeypot_is") —
    // never the bare word "honeypot"/"simulation", which appear in normal CORTEX
    // sentences ("...mintability, simulation and tax status...") and must not be mangled.
    .replace(/honeypot(?:\.is|_is)/gi, 'Simulation evidence')
    .replace(/dexscreener/gi, 'Market data')
    .replace(/goldrush/gi, 'holder index')
    .replace(/geckoterminal/gi, 'Market data')
}

function sanitizeProviderNames<T>(value: T): T {
  if (typeof value === 'string') return sanitizeProviderText(value) as T
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderNames(item)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeProviderNames(entry)]),
    ) as T
  }
  return value
}

function publicLpControl(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const sourceLabel = publicEvidenceLabel(raw.source)
  return sanitizeProviderNames({
    ...raw,
    source: sourceLabel,
    sourceLabel,
  })
}

function observedPoolFields(scan: Record<string, any>) {
  const rawPoolCount = finiteNumber(scan.poolCount)
  const lpControl = scan.lpControl && typeof scan.lpControl === 'object' ? scan.lpControl as Record<string, unknown> : {}
  const hasPoolEvidence = Boolean(
    publicAddress(lpControl.primaryMarketPool) ||
    publicAddress(lpControl.verificationPool) ||
    publicAddress(scan.lpMeta?.primaryMarketPoolAddress) ||
    publicAddress(scan.lpMeta?.lpVerificationPoolAddress) ||
    scan.lpMeta?.poolDetected === true,
  )
  let observedPoolPresent = Boolean((rawPoolCount != null && rawPoolCount > 0) || hasPoolEvidence)
  let observedPoolCount = rawPoolCount != null && rawPoolCount > 0 ? rawPoolCount : (observedPoolPresent ? null : 0)
  let poolCountStatus: 'confirmed' | 'inferred_from_primary_pool' | 'fallback_confirmed' | 'unknown' = rawPoolCount != null && rawPoolCount > 0
    ? 'confirmed'
    : observedPoolPresent
      ? 'inferred_from_primary_pool'
      : 'unknown'

  // Fallback pool normalization: when no pool/pair identity was indexed but the
  // fallback market data carries real liquidity, volume, a known DEX, and a pair
  // creation time, treat the pool as observed/confirmed rather than "unknown".
  if (!observedPoolPresent) {
    const liquidityUsd = finiteNumber(scan.liquidityUsd)
    const volume24hUsd = finiteNumber(scan.volume24hUsd)
    const dexName = scan.primaryDexName ?? scan.dexName ?? null
    const pairCreatedAt = scan.poolActivity?.pairCreatedAt ?? null
    const fallbackConfirmed = liquidityUsd != null && liquidityUsd > 0
      && volume24hUsd != null && volume24hUsd > 0
      && Boolean(dexName)
      && Boolean(pairCreatedAt)
    if (fallbackConfirmed) {
      observedPoolPresent = true
      observedPoolCount = 1
      poolCountStatus = 'fallback_confirmed'
    }
  }

  return { observedPoolPresent, observedPoolCount, poolCountStatus }
}

function buildPublicPayload(scan: Record<string, any>, chain: ChainKey, contract: string, debug = false, fallbackHolderCount: number | null = null, fallbackHolderCountCapped = false, fallbackConcentration: ConcentrationResult | null = null, fallbackHolderProviderReachable = true, fallbackOwnership: BaseRadarOwnershipFallback | null = null): Record<string, unknown> {
  const holderDistribution = scan.holderDistribution ?? {}
  const holderResolver = scan.holderResolver ?? {}
  const holderRows = Array.isArray(holderDistribution.topHolders)
    ? holderDistribution.topHolders
    : Array.isArray(holderResolver.holders)
      ? holderResolver.holders
      : (fallbackConcentration?.reason === 'ok' ? fallbackConcentration.topHolders : [])
  // GOLDRUSH-HOLDER-COUNT-FALLBACK, DISCLOSED (reported: the drawer's "Holders" section unreliable
  // for many tokens — Token Scanner's own resolver (holderDistribution/holderResolver) sometimes
  // comes back with neither a count nor rows). fallbackHolderCount is a real, independently-fetched
  // GoldRush count (see scanToken below) — used ONLY when Token Scanner's own resolver genuinely has
  // nothing, never overriding a real value it DID find. CONCENTRATION-FALLBACK, DISCLOSED (reported:
  // "Top 1/10/20 concentration" showed N/A for nearly every Base Radar token even when Holders was
  // real): fallbackConcentration is fetchGoldRushConcentration's own independent top1/10/20 pull
  // (20 real holder balances vs. the contract's real total_supply, both read directly off Covalent's
  // token_holders_v2 rows — see lib/server/goldrushHolderCount.ts's header for how). Used ONLY when
  // Token Scanner's own resolver has no top10 value, never overriding a real one it DID find.
  // ZERO-COUNT-SENTINEL, DISCLOSED (found live-verifying this change: a token with genuinely no
  // usable holder evidence — holderDistributionStatus.status: 'unavailable_with_reason', holderResolver
  // .insufficientEvidence: true — still reports a literal holderCount of 0 in both places, which is
  // Token Scanner's "nothing resolved" sentinel, not "this token genuinely has zero holders".
  // Treating that 0 as a trustworthy exact count would violate the hard rule against faking holder
  // evidence, so a count is only trusted when Token Scanner's own status says it actually resolved
  // something ('ok'/'partial' for holderDistribution, `!insufficientEvidence` for holderResolver);
  // otherwise this falls through exactly as if no count were reported at all.
  const distributionStatusOk = scan.holderDistributionStatus?.status === 'ok' || scan.holderDistributionStatus?.status === 'partial'
  const resolverEvidenceOk = holderResolver.insufficientEvidence !== true
  const holderCount = (distributionStatusOk ? finiteNumber(holderDistribution.holderCount) : null)
    ?? (resolverEvidenceOk ? finiteNumber(holderResolver.holderCount) : null)
    ?? (holderRows.length > 0 ? holderRows.length : null)
    ?? fallbackHolderCount
  // PAGE-SIZE-CEILING, DISCLOSED (reported: "always says 100" — real, confirmed root cause: GoldRush's
  // token_holders_v2 pagination.total_count is capped at the requested page-size once a token has
  // more holders than that — see lib/server/goldrushHolderCount.ts's own header comment for the
  // Covalent-forum confirmation). The direct fallback path already detects this precisely via
  // has_more. STILL-SHOWING-BARE-100, DISCLOSED (reported again on a token whose count came from
  // Token Scanner's own resolver, not the fallback — it showed a bare "100" with no confirmation
  // either way): Token Scanner's holder resolver almost certainly hits the same Covalent provider
  // with its own page-size, and 100 is Covalent's own common default/max across many of their
  // endpoints. I have no visibility into Token Scanner's exact call to confirm its page-size
  // precisely (that engine is off-limits), so this is a disclosed HEURISTIC, not a direct
  // confirmation like the fallback path's has_more check: any resolved count of exactly 100, from
  // ANY source, is flagged as possibly page-capped rather than shown as a bare, falsely-precise
  // number. A token that genuinely has exactly 100 holders will very rarely occur in practice, so
  // this trades a small false-positive rate for never silently understating a token's real reach.
  const holderCountCapped = (holderCount === fallbackHolderCount && fallbackHolderCountCapped) || holderCount === 100
  const clusterMap = scan.devIntel?.clusterMap ?? scan.clusterMap ?? null
  const clusterEdges = Array.isArray(clusterMap?.edges) ? clusterMap.edges : []
  const clusterNodes = Array.isArray(clusterMap?.nodes) ? clusterMap.nodes : []
  const devClusterSupply = finiteNumber(scan.devIntel?.devClusterSupplyPercent ?? scan.devClusterSupplyPercent ?? scan.devIntel?.devClusterSupply)
  const linkedWalletSupply = finiteNumber(scan.devIntel?.linkedWalletSupplyPercent ?? scan.linkedWalletSupplyPercent ?? scan.devIntel?.linkedWalletSupply)
  const creatorHolderPercent = finiteNumber(scan.supplyControl?.creatorHolderPercent ?? scan.creatorHolderPercent)
  const socialsRaw = scan.projectSocials && typeof scan.projectSocials === 'object' ? scan.projectSocials : {}
  const security = scan.security && typeof scan.security === 'object' ? scan.security : {}
  const simulation = security.simulation ?? scan.honeypot ?? null
  const observedPools = observedPoolFields(scan)
  const lpReconciliation = reconcileBaseRadarLp(scan)
  const reconciledLpControlSource = scan.lpControl && typeof scan.lpControl === 'object'
    ? {
        ...scan.lpControl,
        displayLpModel: lpReconciliation.displayLpModel,
        proofApplicability: lpReconciliation.proofApplicability,
        lockBurnApplicable: lpReconciliation.lockBurnApplicable,
        evidence: lpReconciliation.evidence,
        primaryMarketPool: lpReconciliation.primaryMarketPool,
        primaryMarketPoolId: lpReconciliation.primaryMarketPoolId,
        poolAddressPresent: lpReconciliation.poolAddressPresent,
        secondaryLpControlSignals: lpReconciliation.secondaryLpControlSignals,
      }
    : scan.lpControl
  const sanitizedLpControl = publicLpControl(reconciledLpControlSource)
  const derivedLpController = teamControlledLpController(scan.lpControl)
  const publicLpController = firstPublicAddress(scan.lpController, derivedLpController, scan.lpControl?.controller, scan.lpControl?.topHolder, scan.lpControl?.owner)
  const teamControlledUnlockedLp = sanitizedLpControl?.status === 'team_controlled' && publicLpController && scan.lpLockStatus !== 'locked' && scan.lpLockStatus !== 'burned'
  const devOwnership = ownershipSummary(security.devOwnership, fallbackOwnership)
  const deployerStatus = scan.deployerStatus ?? scan.devIntel?.deployerStatus ?? null
  const matchedLinkedWallets = Array.isArray(scan.matchedLinkedWallets)
    ? scan.matchedLinkedWallets.length
    : Array.isArray(scan.devIntel?.matchedLinkedWallets)
      ? scan.devIntel.matchedLinkedWallets.length
      : Array.isArray(scan.supplyControl?.matchedLinkedWallets)
        ? scan.supplyControl.matchedLinkedWallets.length
        : 0
  const clusterConfirmed = confirmedClusterEvidence({
    edgeCount: clusterEdges.length,
    matchedLinkedWallets,
    linkedWalletSupply,
    devClusterSupply,
  })
  const clusterEvidenceReason = clusterConfirmed
    ? 'Confirmed cluster links found in current evidence.'
    : 'No confirmed cluster links in current evidence.'

  const resolvedDeployerAddress = publicAddress(scan.deployerAddress ?? scan.devIntel?.deployerAddress ?? null)
  const linkedWalletAddresses = (Array.isArray(scan.linkedWallets) ? scan.linkedWallets : [])
    .map((w: Record<string, any>) => publicAddress(w?.address ?? w))
    .filter((addr: string | null): addr is string => addr != null)

  // Items 4/5 — past launches and rug history are derived from cluster/linked-wallet
  // evidence already computed during this scan (clusterMap, matchedLinkedWallets,
  // supply overlap) — no additional provider calls are made.
  const pastLaunches = !resolvedDeployerAddress
    ? { status: 'open_check' as const, count: null, sample: [] as string[], reason: 'deployer identity is an open check' }
    : {
        status: 'checked' as const,
        count: matchedLinkedWallets > 0 ? matchedLinkedWallets : clusterEdges.length > 0 ? clusterEdges.length : 0,
        sample: linkedWalletAddresses.slice(0, 5),
        reason: null,
      }

  const rugHistory = !resolvedDeployerAddress
    ? { verified: null, count: null, reason: 'deployer identity is an open check' }
    : {
        verified: clusterConfirmed,
        count: clusterConfirmed ? (matchedLinkedWallets || clusterEdges.length || null) : 0,
        reason: null,
      }

  return {
    chain,
    contract,
    name: scan.name ?? scan.tokenInfo?.name ?? null,
    symbol: scan.symbol ?? scan.tokenInfo?.symbol ?? null,
    market: (() => {
      const liquidityUsd = finiteNumber(scan.liquidityUsd)
      const fdvUsd = finiteNumber(scan.fdvUsd ?? scan.fdv)
      const resolvedMarketCap = resolveBaseRadarMarketCap({
        dexPair: scan.dexPair ?? null,
        geckoPool: scan.geckoPool ?? null,
        normalized: scan,
      })
      const marketCapUsd = resolvedMarketCap.marketCapUsd
      const marketCapStatus = resolvedMarketCap.marketCapStatus
      const valuation = getRadarValuationBasis({
        marketCapUsd,
        marketCapStatus,
        fdvUsd,
        liquidityUsd,
      })
      return {
        priceUsd: finiteNumber(scan.priceUsd),
        liquidityUsd,
        volume24hUsd: finiteNumber(scan.volume24hUsd),
        fdvUsd,
        marketCapUsd,
        marketCapStatus,
        marketStatus: scan.marketStatus ?? null,
        marketConfidence: scan.marketConfidence ?? null,
        poolCount: observedPools.observedPoolCount,
        observedPoolPresent: observedPools.observedPoolPresent,
        observedPoolCount: observedPools.observedPoolCount,
        poolCountStatus: observedPools.poolCountStatus,
        primaryDexName: scan.primaryDexName ?? null,
        poolActivity: scan.poolActivity ?? null,
        valuationContext: scan.valuationContext ?? null,
        valuationBasis: valuation.basis,
        valuationUsd: valuation.valueUsd,
        valuationLabel: valuation.label,
        ...(debug ? { marketCapDiagnostics: {
          selectedMarketCapUsd: marketCapUsd,
          selectedMarketCapStatus: resolvedMarketCap.marketCapStatus,
          selectedMarketCapFieldPath: resolvedMarketCap.marketCapFieldPath,
          selectedValuationBasis: valuation.basis,
          fdvUsd,
          rawCandidates: resolvedMarketCap.rawCandidates,
          resolverReason: resolvedMarketCap.reason,
        } } : {}),
      }
    })(),
    lp: {
      lpLockStatus: scan.lpLockStatus ?? null,
      lpLockAmount: finiteNumber(scan.lpLockAmount),
      lpUnlockTime: scan.lpUnlockTime ?? null,
      lpController: publicLpController ?? null,
      lpProofStatus: scan.lpProofStatus ?? null,
      lpProofApplicability: lpReconciliation.proofApplicability,
      displayLpModel: lpReconciliation.displayLpModel,
      lockBurnApplicable: lpReconciliation.lockBurnApplicable,
      lockBurnReason: sanitizedLpControl?.lockBurnReason ?? scan.lpMeta?.lpModelDecision?.lockBurnReason ?? null,
      lpControl: sanitizedLpControl,
      lpControlRead: sanitizeProviderNames(scan.lpControlRead ?? null),
      secondaryLpControlSignals: sanitizeProviderNames(lpReconciliation.secondaryLpControlSignals),
      lpLockProvider: scan.lpLockStatus === 'locked' ? (scan.lpLockProvider ?? null) : null,
      lpDataMode: scan.lpDataMode ?? null,
      lpDataConfidence: scan.lpDataConfidence ?? null,
      lpExitRisk: teamControlledUnlockedLp ? 'high' : scan.lpExitRisk ?? null,
      lpExitRiskReason: teamControlledUnlockedLp ? 'High exit risk — Single wallet controls the detected LP position. No verified lock or burn proof was found.' : scan.lpExitRiskReason ?? null,
      liquidityDepthRisk: scan.liquidityDepthRisk ?? null,
      lpEvidenceSummary: sanitizeProviderNames(lpReconciliation.lpEvidenceSummary),
      lpModelProof: lpReconciliation.lpModelProof,
      lpMigrationProof: scan.lpMigrationProof ?? null,
      cortexLpRead: sanitizeProviderNames(lpReconciliation.cortexLpRead),
      lpProofDisplay: lpReconciliation.lpProofDisplay,
      primaryMarketPool: lpReconciliation.primaryMarketPool,
      primaryMarketPoolId: lpReconciliation.primaryMarketPoolId,
      poolAddressPresent: lpReconciliation.poolAddressPresent,
      rugRiskStatus: lpReconciliation.rugRiskDisplay?.status ?? null,
      rugRiskReason: lpReconciliation.rugRiskDisplay?.reason ?? null,
    },
    holders: (() => {
      const usedFallbackConcentration = !hasValue(holderDistribution.top10) && fallbackConcentration?.reason === 'ok'
      const top1 = finiteNumber(holderDistribution.top1) ?? (usedFallbackConcentration ? fallbackConcentration!.top1 : null)
      const top10 = finiteNumber(holderDistribution.top10) ?? (usedFallbackConcentration ? fallbackConcentration!.top10 : null)
      const top20 = finiteNumber(holderDistribution.top20) ?? (usedFallbackConcentration ? fallbackConcentration!.top20 : null)
      // HOLDER-EVIDENCE-CLARITY, DISCLOSED (reported: the drawer showed "Holders: 100+" / "Status:
      // Not confirmed" / "Concentration unavailable" next to copy that said "Holder count verified"
      // — self-contradictory, since a minimum count ("at least 100") is not exact verified evidence,
      // and neither implies anything about top-holder concentration). holderEvidence is the single
      // structured source of truth for both facts, kept fully separate: holderCountCapped=true means
      // this is a minimum, never presented as verified even though it can still pass the feed's
      // holder gate; concentration is only ever "resolved" when real top-holder balances (top1/10/20
      // above) actually exist, never inferred from the count. See lib/baseRadarHolderEvidence.ts.
      const holderProviderLabel = usedFallbackConcentration || (holderCount === fallbackHolderCount && fallbackHolderCount != null) ? 'goldrush_fallback' : 'token_scanner'
      const holderEvidence = buildBaseRadarHolderEvidence({
        holderCount,
        countIsMinimum: holderCountCapped,
        top1Percent: top1,
        top10Percent: top10,
        top20Percent: top20,
        holderProviderReachable: holderCount != null ? true : fallbackHolderProviderReachable,
        // usedFallbackConcentration true means fallbackConcentration.reason === 'ok', i.e. these
        // top1/10/20 came from fetchGoldRushConcentration (GoldRush/Covalent) specifically.
        concentrationProvider: usedFallbackConcentration ? 'goldrush' : null,
      })
      // AUDIT, DISCLOSED: dev-only structured log of the holder-evidence decision for this token —
      // never sent to the client, mirrors the TOKEN-SAVER debug-log pattern already used elsewhere
      // in this codebase (e.g. baseRadarFeedScoring.ts) for tracing scoring/evidence decisions.
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[baseRadarHolderEvidenceAudit]', {
          symbol: scan.symbol ?? scan.tokenInfo?.symbol ?? null,
          tokenAddress: contract,
          holderProvider: holderProviderLabel,
          holderCountStatus: holderEvidence.holderCountStatus,
          holderCountExact: holderEvidence.holderCountExact ?? null,
          holderCountMinimum: holderEvidence.holderCountMinimum ?? null,
          holderGatePassed: holderEvidence.holderGatePassed,
          holderVerified: holderEvidence.holderVerified,
          concentrationStatus: holderEvidence.concentrationStatus,
          topHolderBalancesResolved: holderEvidence.topHolderBalancesResolved,
          top1Percent: holderEvidence.top1Percent ?? null,
          top10Percent: holderEvidence.top10Percent ?? null,
          top20Percent: holderEvidence.top20Percent ?? null,
          evidenceGaps: holderEvidence.evidenceGaps,
        })
      }
      return {
        top1,
        top10,
        top20,
        holderCount,
        holderCountCapped,
        holderEvidence,
        status: scan.holderDistributionStatus?.status ?? scan.holderStatus ?? null,
        reason: usedFallbackConcentration
          ? 'Top 1/10/20 computed from GoldRush indexed balances (top 20 holders) — an independent fallback, not Token Scanner\'s full resolver.'
          : sanitizeProviderNames(scan.holderDistributionStatus?.reason ?? holderResolver.reason ?? null),
        confidence: usedFallbackConcentration ? 'fallback_indexed' : (holderResolver.confidence ?? scan.holderDistributionStatus?.confidence ?? null),
        topHolders: holderRows.slice(0, 20).map((h: Record<string, any>, index: number) => ({
          rank: finiteNumber(h.rank) ?? index + 1,
          address: h.address ?? null,
          percent: finiteNumber(h.percent ?? h.pctOfSupply),
          isContract: typeof h.isContract === 'boolean' ? h.isContract : null,
          // PROTOCOL-CUSTODY-LABEL, DISCLOSED: h.label is fetchGoldRushConcentration's own
          // known-non-wallet-address label (e.g. "Uniswap V4 Pool Custody (PoolManager)") — set
          // only for the one independently-verified Robinhood V4 PoolManager address today, never
          // guessed. Reuses the existing walletType field (already part of this row's shape,
          // previously always null/unrendered) rather than adding a new one.
          walletType: h.label ?? h.walletType ?? null,
        })),
        concentration: deriveConcentrationRisk(top10, top20)
          ?? scan.cortexRiskEngine?.holderIntelligence?.concentration ?? scan.holderIntelligence?.concentration ?? null,
        creatorInTopHolders: typeof scan.creatorInTopHolders === 'boolean' ? scan.creatorInTopHolders : null,
        creatorHolderPercent,
        // PROTOCOL-CUSTODY-EXCLUSION, DISCLOSED: real, measured share of supply held by known
        // non-wallet (protocol custody) addresses excluded from top1/10/20 above — see
        // lib/server/goldrushHolderCount.ts's own header for the full rationale. Only ever set
        // when fallbackConcentration actually found one among its fetched rows; never inferred.
        protocolHeldPercent: usedFallbackConcentration ? (fallbackConcentration!.protocolHeldPercent ?? null) : null,
      }
    })(),
    deployer: {
      deployerAddress: scan.deployerAddress ?? scan.devIntel?.deployerAddress ?? null,
      deployerStatus,
      deployerConfidence: scan.deployerConfidence ?? scan.devIntel?.deployerConfidence ?? null,
      methodLabel: publicEvidenceLabel(scan.methodUsed ?? scan.devIntel?.methodUsed) ?? null,
      creationTxHash: scan.creationTxHash ?? scan.devIntel?.creationTxHash ?? null,
      pastLaunches,
      rugHistory,
      clusterEvidence: {
        confirmed: clusterConfirmed,
        edgeCount: clusterEdges.length,
        nodeCount: clusterNodes.length,
        devClusterSupplyPercent: devClusterSupply,
        linkedWalletSupplyPercent: linkedWalletSupply,
        matchedLinkedWallets,
        reason: clusterEvidenceReason,
      },
      supplyControl: sanitizeProviderNames(scan.supplyControl ?? scan.devIntel?.supplyControl ?? null),
      linkedWallets: Array.isArray(scan.linkedWallets) ? scan.linkedWallets : [],
      creatorInTopHolders: typeof scan.creatorInTopHolders === 'boolean' ? scan.creatorInTopHolders : null,
      creatorHolderPercent,
      reason: sanitizeProviderNames(scan.devIntel?.reason ?? null),
    },
    security: {
      honeypot: sanitizeProviderNames(simulation),
      simulationStatus: lpReconciliation.simulationPairAddress === null ? 'open_check' : security.simulationStatus ?? (simulation ? 'ok' : 'open_check'),
      // REASON-CODE FIX, DISCLOSED (full Base Radar audit): was 'missing pair address' (a
      // space-separated phrase) — lib/baseRadarSimulation.ts's real RadarSimulationOpenCheckReason
      // enum uses 'missing_pair_address' (underscored). Confirmed this exact field isn't currently
      // read anywhere in the drawer (buildSimulation() reads security.honeypot.failureReason or the
      // feed's own already-correct reason instead), so this was silently inert rather than visibly
      // wrong — corrected to the real enum value so it's right if/when something does read it.
      simulationReason: lpReconciliation.simulationPairAddress === null
        ? 'missing_pair_address'
        : sanitizeProviderNames(security.simulationReason ?? security.reason ?? null),
      contractFlags: security.contractFlags ?? null,
      devOwnership,
      riskDrivers: sanitizeProviderNames(scan.cortexRiskEngine?.riskDrivers ?? scan.riskDrivers ?? []),
      openChecks: sanitizeProviderNames(scan.cortexRiskEngine?.openChecks ?? scan.openChecks ?? []),
    },
    socials: {
      website: socialsRaw.website ?? null,
      twitter: socialsRaw.twitter ?? null,
      telegram: socialsRaw.telegram ?? null,
      status: scan.projectSocials ? (socialsRaw.status ?? null) : null,
      reason: sanitizeProviderNames(scan.projectSocials ? (socialsRaw.reason ?? null) : null),
    },
    priceChart: sanitizeProviderNames(scan.priceChart ?? null),
    fetchedAt: new Date().toISOString(),
  }
}

async function scanToken(req: Request, chain: ChainKey, contract: string, debug: boolean): Promise<Record<string, unknown>> {
  const scanReq = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ contract, chain, debug }),
  })
  const scanRes = await tokenScannerPost(scanReq)
  const scan = await scanRes.json().catch(() => null) as Record<string, any> | null
  if (!scanRes.ok || !scan || scan.error) {
    return {
      chain,
      contract,
      status: 'limited_evidence',
      error: 'Drawer enrichment is temporarily limited. Open Token Scanner for a deeper manual check.',
      fetchedAt: new Date().toISOString(),
    }
  }
  // GOLDRUSH-HOLDER-COUNT-FALLBACK, DISCLOSED: only fetched when Token Scanner's own scan genuinely
  // has no holder count/rows at all — never an extra request on a scan that already has real data.
  // fetchGoldRushHolderCount supports 'base' and 'robinhood' (confirmed real GoldRush/Covalent
  // Robinhood Chain coverage — see that module's own header comment); 'eth' isn't wired into that
  // fetch, so only forward chain when it's one of the two this module actually handles.
  const scanHolderDistribution = scan.holderDistribution ?? {}
  const scanHolderResolver = scan.holderResolver ?? {}
  // ZERO-COUNT-SENTINEL, DISCLOSED (same fix as buildPublicPayload's holderCount resolution below):
  // a status of 'unavailable_with_reason'/'error', or holderResolver.insufficientEvidence:true, means
  // Token Scanner found nothing — its reported holderCount of 0 in that case is a "nothing resolved"
  // sentinel, not real evidence, so it must not block the fallback fetch from running.
  const scanDistributionStatusOk = scan.holderDistributionStatus?.status === 'ok' || scan.holderDistributionStatus?.status === 'partial'
  const scanResolverEvidenceOk = scanHolderResolver.insufficientEvidence !== true
  const scanHasHolderData = (scanDistributionStatusOk && finiteNumber(scanHolderDistribution.holderCount) != null)
    || (scanResolverEvidenceOk && finiteNumber(scanHolderResolver.holderCount) != null)
    || (Array.isArray(scanHolderDistribution.topHolders) && scanHolderDistribution.topHolders.length > 0)
    || (Array.isArray(scanHolderResolver.holders) && scanHolderResolver.holders.length > 0)
  let fallbackHolderCount: number | null = null
  let fallbackHolderCountCapped = false
  // REACHABILITY, DISCLOSED (feeds holderEvidence.evidenceGaps' holder_provider_unreachable vs
  // holder_count_unavailable distinction): a fetch that timed out / had no API key / rate-limited /
  // errored means the provider itself couldn't be reached; 'no_data'/'ok' mean it responded.
  let fallbackHolderProviderReachable = true
  if (!scanHasHolderData && (chain === 'base' || chain === 'robinhood')) {
    const fallback = await fetchGoldRushHolderCount(contract, chain)
    fallbackHolderCount = fallback.count
    fallbackHolderCountCapped = fallback.isCapped === true
    fallbackHolderProviderReachable = !['timeout', 'http_error', 'no_api_key', 'rate_limited'].includes(fallback.reason)
  }
  // CONCENTRATION-FALLBACK, DISCLOSED: only fetched when Token Scanner's own scan genuinely has no
  // top10 value — a real, additional GoldRush call, but only on the gap this was built to close.
  const scanHasTop10 = finiteNumber(scanHolderDistribution.top10) != null
  let fallbackConcentration: ConcentrationResult | null = null
  if (!scanHasTop10 && (chain === 'base' || chain === 'robinhood')) {
    fallbackConcentration = await fetchGoldRushConcentration(contract, chain)
  }
  // OWNERSHIP-RPC-FALLBACK, DISCLOSED: only fetched when Token Scanner's own devOwnership genuinely
  // didn't verify anything — a single cheap read-only eth_call, never overriding a real answer Token
  // Scanner's fuller analysis DID find. Valid for all three chains this route serves (base/eth/
  // robinhood all resolve to real RPC endpoints in lib/server/lpProof.ts's LpChain type).
  let fallbackOwnership: BaseRadarOwnershipFallback | null = null
  if (scan.security?.devOwnership?.ownershipVerified !== true) {
    fallbackOwnership = await resolveBaseRadarOwnershipFallback(chain, contract)
  }
  return buildPublicPayload(scan, chain, contract, debug, fallbackHolderCount, fallbackHolderCountCapped, fallbackConcentration, fallbackHolderProviderReachable, fallbackOwnership)
}

function storeCache(key: string, payload: Record<string, unknown>, now: number) {
  cache.set(key, {
    name: { value: payload.name ?? null, expiresAt: now + STATIC_TTL_MS },
    symbol: { value: payload.symbol ?? null, expiresAt: now + STATIC_TTL_MS },
    market: { value: payload.market ?? null, expiresAt: now + MARKET_TTL_MS },
    lp: { value: payload.lp ?? null, expiresAt: now + LP_TTL_MS },
    holders: { value: payload.holders ?? null, expiresAt: now + STATIC_TTL_MS },
    deployer: { value: payload.deployer ?? null, expiresAt: now + STATIC_TTL_MS },
    security: { value: payload.security ?? null, expiresAt: now + STATIC_TTL_MS },
    socials: { value: payload.socials ?? null, expiresAt: now + STATIC_TTL_MS },
    priceChart: { value: sanitizeProviderNames(payload.priceChart ?? null), expiresAt: now + MARKET_TTL_MS },
    fetchedAt: String(payload.fetchedAt ?? new Date(now).toISOString()),
  })
}

async function enrich(req: Request, chain: ChainKey, contract: string, dedupeHit: boolean) {
  const started = Date.now()
  const key = cacheKey(chain, contract)
  const cached = fromCache(cache.get(key), started)
  if (cached) {
    const missingDrawerFields = missingFields(cached)
    return {
      payload: cached,
      diagnostics: {
        drawerEnrichmentAttempted: true,
        drawerEnrichmentCacheHit: true,
        drawerEnrichmentDedupeHit: dedupeHit,
        tokenScannerReuse: false,
        marketEnriched: !missingDrawerFields.includes('market.liquidityUsd'),
        lpEnriched: !missingDrawerFields.includes('lp.controlOrLockStatus'),
        holdersEnriched: !missingDrawerFields.includes('holders.top10'),
        deployerEnriched: !missingDrawerFields.includes('deployer.address'),
        securityEnriched: !missingDrawerFields.includes('security.flags'),
        socialsEnriched: !missingDrawerFields.includes('socials.projectLinks'),
        missingDrawerFields,
        enrichmentDurationMs: Date.now() - started,
      },
    }
  }

  const debug = new URL(req.url).searchParams.get('debug') === '1' || new URL(req.url).searchParams.get('debug') === 'true'
  const payload = await scanToken(req, chain, contract, debug)
  storeCache(key, payload, Date.now())
  const missingDrawerFields = missingFields(payload as Record<string, any>)
  return {
    payload,
    diagnostics: {
      drawerEnrichmentAttempted: true,
      drawerEnrichmentCacheHit: false,
      drawerEnrichmentDedupeHit: dedupeHit,
      tokenScannerReuse: true,
      marketEnriched: !missingDrawerFields.includes('market.liquidityUsd'),
      lpEnriched: !missingDrawerFields.includes('lp.controlOrLockStatus'),
      holdersEnriched: !missingDrawerFields.includes('holders.top10'),
      deployerEnriched: !missingDrawerFields.includes('deployer.address'),
      securityEnriched: !missingDrawerFields.includes('security.flags'),
      socialsEnriched: !missingDrawerFields.includes('socials.projectLinks'),
      missingDrawerFields,
      enrichmentDurationMs: Date.now() - started,
    },
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const contract = String(url.searchParams.get('contract') ?? url.searchParams.get('address') ?? '').trim()
  const chain = normalizeChain(url.searchParams.get('chain'))
  const debug = url.searchParams.get('debug') === '1' || url.searchParams.get('debug') === 'true'

  if (!chain) return NextResponse.json({ error: 'Unsupported chain.' }, { status: 400 })
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) return NextResponse.json({ error: 'Invalid or missing contract address.' }, { status: 400 })

  const key = cacheKey(chain, contract)
  const cached = fromCache(cache.get(key), Date.now())
  if (cached) {
    const missingDrawerFields = missingFields(cached)
    const diagnostics = {
        drawerEnrichmentAttempted: true,
        drawerEnrichmentCacheHit: true,
        drawerEnrichmentDedupeHit: false,
        tokenScannerReuse: false,
        marketEnriched: !missingDrawerFields.includes('market.liquidityUsd'),
        lpEnriched: !missingDrawerFields.includes('lp.controlOrLockStatus'),
        holdersEnriched: !missingDrawerFields.includes('holders.top10'),
        deployerEnriched: !missingDrawerFields.includes('deployer.address'),
        securityEnriched: !missingDrawerFields.includes('security.flags'),
        socialsEnriched: !missingDrawerFields.includes('socials.projectLinks'),
        missingDrawerFields,
        enrichmentDurationMs: 0,
      }
    return NextResponse.json(debug ? { ...cached, diagnostics, _debug: diagnostics } : cached)
  }

  const existing = inFlight.get(key)
  if (existing) {
    const result = await existing.then((value) => ({ payload: value.payload, diagnostics: { ...value.diagnostics, drawerEnrichmentDedupeHit: true } }))
    return NextResponse.json(debug ? { ...result.payload, diagnostics: result.diagnostics, _debug: result.diagnostics } : result.payload)
  }

  const promise = enrich(req, chain, contract, false)
  inFlight.set(key, promise)
  try {
    const result = await promise
    return NextResponse.json(debug ? { ...result.payload, diagnostics: result.diagnostics, _debug: result.diagnostics } : result.payload)
  } finally {
    inFlight.delete(key)
  }
}
