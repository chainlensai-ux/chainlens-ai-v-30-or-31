import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

type HolderRow = { rank?: number | null; address?: string | null; percent?: number | null; pctOfSupply?: number | null; isContract?: boolean | null; walletType?: string | null }

type TokenScanPayload = {
  holderDistribution?: { topHolders?: HolderRow[]; top1?: number | null; top10?: number | null; top20?: number | null; holderCount?: number | null } | null
  holderResolver?: { holders?: HolderRow[]; reason?: string | null } | null
  holderDistributionStatus?: { status?: string | null; reason?: string | null } | string | null
  sections?: { holders?: { status?: string | null; reason?: string | null; holderCount?: number | null; top1?: number | null; top10?: number | null; top20?: number | null } } | null
}

function statusFrom(value: TokenScanPayload['holderDistributionStatus']): string | null {
  if (typeof value === 'string') return value
  return value?.status ?? null
}

function holderPercent(holder: HolderRow): number | null {
  const value = holder.percent ?? holder.pctOfSupply ?? null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const address = url.searchParams.get('address') ?? url.searchParams.get('contract') ?? ''
  const chain = url.searchParams.get('chain') ?? 'base'

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid or missing address parameter.' }, { status: 400 })
  }

  const tokenUrl = new URL('/api/token', url.origin)
  tokenUrl.searchParams.set('contract', address)
  tokenUrl.searchParams.set('chain', chain)

  const res = await fetch(tokenUrl, {
    cache: 'no-store',
    headers: { authorization: req.headers.get('authorization') ?? '' },
  })
  const json = await res.json().catch(() => ({})) as TokenScanPayload & { error?: string }
  if (!res.ok || json.error) {
    return NextResponse.json({ error: json.error ?? 'Holder data unavailable.' }, { status: res.ok ? 502 : res.status })
  }

  const topHolders = json.holderDistribution?.topHolders ?? json.holderResolver?.holders ?? []
  const contractCount = topHolders.filter((holder) => holder.isContract === true || holder.walletType === 'contract').length
  const eoaCount = topHolders.length > 0 ? topHolders.length - contractCount : 0
  const top10 = json.holderDistribution?.top10 ?? json.sections?.holders?.top10 ?? null
  const concentrationStatus = top10 == null ? 'unknown' : top10 >= 50 ? 'high' : top10 >= 25 ? 'moderate' : 'healthy'

  return NextResponse.json({
    topHolders: topHolders.map((holder, index) => ({ ...holder, rank: holder.rank ?? index + 1, percent: holderPercent(holder) })),
    concentration: {
      top1: json.holderDistribution?.top1 ?? json.sections?.holders?.top1 ?? null,
      top10,
      top20: json.holderDistribution?.top20 ?? json.sections?.holders?.top20 ?? null,
      holderCount: json.holderDistribution?.holderCount ?? json.sections?.holders?.holderCount ?? topHolders.length,
      status: concentrationStatus,
    },
    contractCount,
    eoaCount,
    smartWallets: contractCount,
    snipers: 0,
    status: statusFrom(json.holderDistributionStatus) ?? json.sections?.holders?.status ?? 'partial',
    reason: json.sections?.holders?.reason ?? json.holderResolver?.reason ?? null,
  })
}
