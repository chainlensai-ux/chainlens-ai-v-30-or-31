import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

type HolderRow = { rank?: number | null; address?: string | null; balance?: string | number | null; percent?: number | null; pctOfSupply?: number | null; isContract?: boolean | null; isEOA?: boolean | null; walletType?: string | null; label?: string | null; tags?: string[] | null }

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

  const res = await fetch(tokenUrl, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      authorization: req.headers.get('authorization') ?? '',
    },
    body: JSON.stringify({ contract: address, chain }),
  })
  const json = await res.json().catch(() => ({})) as TokenScanPayload & { error?: string }
  if (!res.ok || json.error) {
    return NextResponse.json({ error: json.error ?? 'Holder data unavailable.' }, { status: res.ok ? 502 : res.status })
  }

  const topHolders = json.holderDistribution?.topHolders ?? json.holderResolver?.holders ?? []
  const holders = topHolders.map((holder, index) => {
    const isContract = holder.isContract === true || holder.walletType === 'contract'
    return {
      address: holder.address ?? null,
      balance: holder.balance ?? null,
      percent: holderPercent(holder),
      isContract,
      isEOA: holder.isEOA ?? (holder.address ? !isContract : null),
      rank: holder.rank ?? index + 1,
    }
  })
  const contractCount = holders.filter((holder) => holder.isContract === true).length
  const eoaCount = holders.filter((holder) => holder.isEOA === true).length
  const top10 = json.holderDistribution?.top10 ?? json.sections?.holders?.top10 ?? null
  const concentrationStatus = top10 == null ? 'unknown' : top10 >= 50 ? 'high' : top10 >= 25 ? 'moderate' : 'healthy'

  return NextResponse.json({
    holders,
    topHolders: holders,
    concentration: {
      top1: json.holderDistribution?.top1 ?? json.sections?.holders?.top1 ?? null,
      top10,
      top20: json.holderDistribution?.top20 ?? json.sections?.holders?.top20 ?? null,
      holderCount: json.holderDistribution?.holderCount ?? json.sections?.holders?.holderCount ?? topHolders.length,
      status: concentrationStatus,
    },
    contractCount,
    eoaCount,
    smartWallets: topHolders.filter((holder) => String(holder.label ?? '').toLowerCase().includes('smart') || (holder.tags ?? []).some((tag) => /smart/i.test(tag))).map((holder) => holder.address).filter(Boolean),
    snipers: topHolders.filter((holder) => String(holder.label ?? '').toLowerCase().includes('sniper') || (holder.tags ?? []).some((tag) => /sniper/i.test(tag))).map((holder) => holder.address).filter(Boolean),
    status: statusFrom(json.holderDistributionStatus) ?? json.sections?.holders?.status ?? 'partial',
    reason: json.sections?.holders?.reason ?? json.holderResolver?.reason ?? null,
  })
}
