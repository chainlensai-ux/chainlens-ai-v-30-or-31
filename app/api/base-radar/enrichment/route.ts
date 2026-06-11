/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { POST as tokenScannerPost } from '@/app/api/token/route'

type ChainKey = 'base' | 'eth'
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
  return null
}

function cacheKey(chain: ChainKey, contract: string) {
  return `${chain}:${contract.toLowerCase()}`
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
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

function ownershipSummary(devOwnership: unknown): Record<string, unknown> {
  const raw = devOwnership && typeof devOwnership === 'object' ? devOwnership as Record<string, unknown> : {}
  const ownershipVerified = raw.ownershipVerified === true
  const ownerAddress = publicAddress(raw.ownerAddress)
  const adminAddress = publicAddress(raw.adminAddress)
  const isRenounced = ownershipVerified && raw.isRenounced === true
  const ownershipStatus = !ownershipVerified ? 'open_check' : isRenounced ? 'renounced' : (ownerAddress || adminAddress) ? 'active_owner' : 'open_check'
  const ownershipLabel = ownershipStatus === 'renounced' ? 'Renounced ownership' : ownershipStatus === 'active_owner' ? 'Active owner/admin verified' : 'Open Check / Not verified'
  return { ...raw, ownerAddress, adminAddress, isRenounced, ownershipVerified, ownershipStatus, ownershipLabel }
}

function confirmedClusterEvidence(params: { deployerStatus: unknown; edgeCount: number; matchedLinkedWallets: number | null; linkedWalletSupply: number | null; devClusterSupply: number | null }): boolean {
  if (params.edgeCount > 0) return true
  if (params.matchedLinkedWallets != null && params.matchedLinkedWallets > 0) return true
  if (params.linkedWalletSupply != null && params.linkedWalletSupply > 0) return true
  if (params.deployerStatus === 'confirmed' && params.devClusterSupply != null && params.devClusterSupply > 0) return true
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
  if (normalized.includes('geckoterminal') || normalized.includes('goldrush')) return 'Market + holder evidence'
  if (normalized.includes('honeypot_is') || normalized.includes('honeypot.is') || normalized.includes('honeypot')) return 'Simulation evidence'
  if (normalized.includes('transfer')) return 'Transfer inference'
  if (normalized.includes('simulation')) return 'Simulation evidence'
  if (normalized.includes('market') || normalized.includes('holder')) return 'Market + holder evidence'
  if (normalized.includes('dex_data') || normalized.includes('rpc')) return 'Market + on-chain evidence'
  return value.trim()
}

function sanitizeProviderText(value: string): string {
  return value
    .replace(/geckoterminal\+goldrush/gi, 'Market + holder evidence')
    .replace(/moralis_transfer_fallback/gi, 'Transfer inference')
    .replace(/honeypot(?:\.is|_is)?/gi, 'Simulation evidence')
    .replace(/goldrush/gi, 'holder index')
    .replace(/geckoterminal/gi, 'market index')
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
  const observedPoolPresent = Boolean((rawPoolCount != null && rawPoolCount > 0) || hasPoolEvidence)
  const observedPoolCount = rawPoolCount != null && rawPoolCount > 0 ? rawPoolCount : (observedPoolPresent ? null : 0)
  const poolCountStatus: 'confirmed' | 'inferred_from_primary_pool' | 'unknown' = rawPoolCount != null && rawPoolCount > 0
    ? 'confirmed'
    : observedPoolPresent
      ? 'inferred_from_primary_pool'
      : 'unknown'
  return { observedPoolPresent, observedPoolCount, poolCountStatus }
}

function buildPublicPayload(scan: Record<string, any>, chain: ChainKey, contract: string): Record<string, unknown> {
  const holderDistribution = scan.holderDistribution ?? {}
  const holderResolver = scan.holderResolver ?? {}
  const holderRows = Array.isArray(holderDistribution.topHolders)
    ? holderDistribution.topHolders
    : Array.isArray(holderResolver.holders)
      ? holderResolver.holders
      : []
  const holderCount = finiteNumber(holderDistribution.holderCount) ?? finiteNumber(holderResolver.holderCount) ?? (holderRows.length > 0 ? holderRows.length : null)
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
  const sanitizedLpControl = publicLpControl(scan.lpControl)
  const derivedLpController = teamControlledLpController(scan.lpControl)
  const publicLpController = firstPublicAddress(scan.lpController, derivedLpController, scan.lpControl?.controller, scan.lpControl?.topHolder, scan.lpControl?.owner)
  const teamControlledUnlockedLp = sanitizedLpControl?.status === 'team_controlled' && publicLpController && scan.lpLockStatus !== 'locked' && scan.lpLockStatus !== 'burned'
  const devOwnership = ownershipSummary(security.devOwnership)
  const deployerStatus = scan.deployerStatus ?? scan.devIntel?.deployerStatus ?? null
  const matchedLinkedWallets = Array.isArray(scan.matchedLinkedWallets) ? scan.matchedLinkedWallets.length : null
  const clusterConfirmed = confirmedClusterEvidence({
    deployerStatus,
    edgeCount: clusterEdges.length,
    matchedLinkedWallets,
    linkedWalletSupply,
    devClusterSupply,
  })

  return {
    chain,
    contract,
    name: scan.name ?? scan.tokenInfo?.name ?? null,
    symbol: scan.symbol ?? scan.tokenInfo?.symbol ?? null,
    market: {
      priceUsd: finiteNumber(scan.priceUsd),
      liquidityUsd: finiteNumber(scan.liquidityUsd),
      volume24hUsd: finiteNumber(scan.volume24hUsd),
      fdvUsd: finiteNumber(scan.fdvUsd ?? scan.fdv),
      marketCapUsd: finiteNumber(scan.marketCapUsd ?? scan.market_cap),
      marketStatus: scan.marketStatus ?? null,
      marketConfidence: scan.marketConfidence ?? null,
      poolCount: observedPools.observedPoolCount,
      observedPoolPresent: observedPools.observedPoolPresent,
      observedPoolCount: observedPools.observedPoolCount,
      poolCountStatus: observedPools.poolCountStatus,
      primaryDexName: scan.primaryDexName ?? null,
      poolActivity: scan.poolActivity ?? null,
      valuationContext: scan.valuationContext ?? null,
    },
    lp: {
      lpLockStatus: scan.lpLockStatus ?? null,
      lpLockAmount: finiteNumber(scan.lpLockAmount),
      lpUnlockTime: scan.lpUnlockTime ?? null,
      lpController: publicLpController ?? null,
      lpProofStatus: scan.lpProofStatus ?? null,
      lpProofApplicability: scan.lpProofApplicability ?? null,
      lockBurnReason: sanitizedLpControl?.lockBurnReason ?? scan.lpMeta?.lpModelDecision?.lockBurnReason ?? null,
      lpControl: sanitizedLpControl,
      lpControlRead: sanitizeProviderNames(scan.lpControlRead ?? null),
      lpLockProvider: scan.lpLockStatus === 'locked' ? (scan.lpLockProvider ?? null) : null,
      lpDataMode: scan.lpDataMode ?? null,
      lpDataConfidence: scan.lpDataConfidence ?? null,
      lpExitRisk: teamControlledUnlockedLp ? 'high' : scan.lpExitRisk ?? null,
      lpExitRiskReason: teamControlledUnlockedLp ? 'High exit risk — Single wallet controls the detected LP position. No verified lock or burn proof was found.' : scan.lpExitRiskReason ?? null,
      lpEvidenceSummary: sanitizeProviderNames(scan.lpEvidenceSummary ?? null),
      lpModelProof: scan.lpModelProof ?? null,
      lpMigrationProof: scan.lpMigrationProof ?? null,
      cortexLpRead: scan.cortexLpRead ?? null,
    },
    holders: {
      top1: finiteNumber(holderDistribution.top1),
      top10: finiteNumber(holderDistribution.top10),
      top20: finiteNumber(holderDistribution.top20),
      holderCount,
      status: scan.holderDistributionStatus?.status ?? scan.holderStatus ?? null,
      reason: sanitizeProviderNames(scan.holderDistributionStatus?.reason ?? holderResolver.reason ?? null),
      confidence: holderResolver.confidence ?? scan.holderDistributionStatus?.confidence ?? null,
      topHolders: holderRows.slice(0, 20).map((h: Record<string, any>, index: number) => ({
        rank: finiteNumber(h.rank) ?? index + 1,
        address: h.address ?? null,
        percent: finiteNumber(h.percent ?? h.pctOfSupply),
        isContract: typeof h.isContract === 'boolean' ? h.isContract : null,
        walletType: h.walletType ?? null,
      })),
      concentration: scan.cortexRiskEngine?.holderIntelligence?.concentration ?? scan.holderIntelligence?.concentration ?? null,
      creatorInTopHolders: typeof scan.creatorInTopHolders === 'boolean' ? scan.creatorInTopHolders : null,
      creatorHolderPercent,
    },
    deployer: {
      deployerAddress: scan.deployerAddress ?? scan.devIntel?.deployerAddress ?? null,
      deployerStatus,
      deployerConfidence: scan.deployerConfidence ?? scan.devIntel?.deployerConfidence ?? null,
      methodLabel: publicEvidenceLabel(scan.methodUsed ?? scan.devIntel?.methodUsed) ?? null,
      creationTxHash: scan.creationTxHash ?? scan.devIntel?.creationTxHash ?? null,
      pastLaunches: scan.deployerProfile?.rugHistory != null ? null : null,
      rugHistoryVerified: null,
      clusterEvidence: {
        confirmed: clusterConfirmed,
        edgeCount: clusterEdges.length,
        nodeCount: clusterNodes.length,
        devClusterSupplyPercent: devClusterSupply,
        linkedWalletSupplyPercent: linkedWalletSupply,
        matchedLinkedWallets,
      },
      supplyControl: sanitizeProviderNames(scan.supplyControl ?? scan.devIntel?.supplyControl ?? null),
      linkedWallets: Array.isArray(scan.linkedWallets) ? scan.linkedWallets : [],
      creatorInTopHolders: typeof scan.creatorInTopHolders === 'boolean' ? scan.creatorInTopHolders : null,
      creatorHolderPercent,
      reason: sanitizeProviderNames(scan.devIntel?.reason ?? null),
    },
    security: {
      honeypot: sanitizeProviderNames(simulation),
      contractFlags: security.contractFlags ?? null,
      devOwnership,
      riskDrivers: sanitizeProviderNames(scan.cortexRiskEngine?.riskDrivers ?? scan.riskDrivers ?? []),
      openChecks: sanitizeProviderNames(scan.cortexRiskEngine?.openChecks ?? scan.openChecks ?? []),
    },
    socials: {
      website: socialsRaw.website ?? null,
      twitter: socialsRaw.twitter ?? null,
      telegram: socialsRaw.telegram ?? null,
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
  return buildPublicPayload(scan, chain, contract)
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
