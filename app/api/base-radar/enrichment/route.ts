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
  const socialsRaw = scan.projectSocials && typeof scan.projectSocials === 'object' ? scan.projectSocials : {}
  const security = scan.security && typeof scan.security === 'object' ? scan.security : {}
  const simulation = security.simulation ?? scan.honeypot ?? null

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
      poolCount: finiteNumber(scan.poolCount),
      primaryDexName: scan.primaryDexName ?? null,
      poolActivity: scan.poolActivity ?? null,
      valuationContext: scan.valuationContext ?? null,
    },
    lp: {
      lpLockStatus: scan.lpLockStatus ?? null,
      lpLockAmount: finiteNumber(scan.lpLockAmount),
      lpUnlockTime: scan.lpUnlockTime ?? null,
      lpController: publicAddress(scan.lpController) ?? publicAddress(security.devOwnership?.ownerAddress) ?? publicAddress(scan.lpControl?.owner) ?? null,
      lpProofStatus: scan.lpProofStatus ?? null,
      lpProofApplicability: scan.lpProofApplicability ?? null,
      lpControl: scan.lpControl ?? null,
      lpControlRead: scan.lpControlRead ?? null,
      lpLockProvider: scan.lpLockStatus === 'locked' ? (scan.lpLockProvider ?? null) : null,
      lpDataMode: scan.lpDataMode ?? null,
      lpDataConfidence: scan.lpDataConfidence ?? null,
      lpExitRisk: scan.lpExitRisk ?? null,
      lpExitRiskReason: scan.lpExitRiskReason ?? null,
      lpEvidenceSummary: scan.lpEvidenceSummary ?? null,
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
      reason: scan.holderDistributionStatus?.reason ?? holderResolver.reason ?? null,
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
    },
    deployer: {
      deployerAddress: scan.deployerAddress ?? scan.devIntel?.deployerAddress ?? null,
      deployerStatus: scan.deployerStatus ?? scan.devIntel?.deployerStatus ?? null,
      deployerConfidence: scan.deployerConfidence ?? scan.devIntel?.deployerConfidence ?? null,
      methodLabel: scan.methodUsed ?? scan.devIntel?.methodUsed ?? null,
      creationTxHash: scan.creationTxHash ?? scan.devIntel?.creationTxHash ?? null,
      pastLaunches: scan.deployerProfile?.rugHistory != null ? null : null,
      rugHistoryVerified: null,
      clusterEvidence: {
        confirmed: clusterEdges.length > 0 || clusterNodes.length > 1 || (devClusterSupply != null && devClusterSupply > 0),
        edgeCount: clusterEdges.length,
        nodeCount: clusterNodes.length,
        devClusterSupplyPercent: devClusterSupply,
        linkedWalletSupplyPercent: linkedWalletSupply,
        matchedLinkedWallets: Array.isArray(scan.matchedLinkedWallets) ? scan.matchedLinkedWallets.length : null,
      },
      supplyControl: scan.supplyControl ?? scan.devIntel?.supplyControl ?? null,
      linkedWallets: Array.isArray(scan.linkedWallets) ? scan.linkedWallets : [],
      creatorInTopHolders: typeof scan.creatorInTopHolders === 'boolean' ? scan.creatorInTopHolders : null,
      reason: scan.devIntel?.reason ?? null,
    },
    security: {
      honeypot: simulation,
      contractFlags: security.contractFlags ?? null,
      devOwnership: security.devOwnership ?? null,
      riskDrivers: scan.cortexRiskEngine?.riskDrivers ?? scan.riskDrivers ?? [],
      openChecks: scan.cortexRiskEngine?.openChecks ?? scan.openChecks ?? [],
    },
    socials: {
      website: socialsRaw.website ?? null,
      twitter: socialsRaw.twitter ?? null,
      telegram: socialsRaw.telegram ?? null,
    },
    priceChart: scan.priceChart ?? null,
    fetchedAt: new Date().toISOString(),
  }
}

async function scanToken(req: Request, chain: ChainKey, contract: string): Promise<Record<string, unknown>> {
  const scanReq = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ contract, chain, debug: false }),
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
    priceChart: { value: payload.priceChart ?? null, expiresAt: now + MARKET_TTL_MS },
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

  const payload = await scanToken(req, chain, contract)
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

  if (!chain) return NextResponse.json({ error: 'Unsupported chain.' }, { status: 400 })
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) return NextResponse.json({ error: 'Invalid or missing contract address.' }, { status: 400 })

  const key = cacheKey(chain, contract)
  const cached = fromCache(cache.get(key), Date.now())
  if (cached) {
    const missingDrawerFields = missingFields(cached)
    return NextResponse.json({
      ...cached,
      diagnostics: {
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
      },
    })
  }

  const existing = inFlight.get(key)
  if (existing) {
    const result = await existing.then((value) => ({ payload: value.payload, diagnostics: { ...value.diagnostics, drawerEnrichmentDedupeHit: true } }))
    return NextResponse.json({ ...result.payload, diagnostics: result.diagnostics })
  }

  const promise = enrich(req, chain, contract, false)
  inFlight.set(key, promise)
  try {
    const result = await promise
    return NextResponse.json({ ...result.payload, diagnostics: result.diagnostics })
  } finally {
    inFlight.delete(key)
  }
}
