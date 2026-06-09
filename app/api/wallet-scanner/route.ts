import { NextResponse } from 'next/server'
import { POST as scanWalletPost } from '../dev-wallet/route'

export const dynamic = 'force-dynamic'

type DevWalletPayload = Record<string, any> & { error?: string }

function labelsFrom(payload: DevWalletPayload): string[] {
  const labels = new Set<string>()
  if (payload.deployerAddress) labels.add('deployer')
  if (payload.suspiciousTransfers) labels.add('suspicious-transfer')
  if (Array.isArray(payload.linkedWallets) && payload.linkedWallets.length > 0) labels.add('linked-wallet-cluster')
  if (payload.devClusterSupply != null || payload.devClusterSupplyPercent != null) labels.add('supply-cluster')
  return Array.from(labels)
}

async function runWalletScan(req: Request, address: string, chain: string): Promise<Response> {
  const syntheticReq = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ contractAddress: address, chain }),
  })
  const res = await scanWalletPost(syntheticReq as any)
  const payload = await res.json().catch(() => ({})) as DevWalletPayload
  if (!res.ok || payload.error) {
    return NextResponse.json({ error: payload.error ?? 'Wallet scanner data unavailable.' }, { status: res.ok ? 502 : res.status })
  }

  const previousProjects = Array.isArray(payload.previousProjects) ? payload.previousProjects : []
  const rugProjects = previousProjects.filter((project) => project?.rugFlag === true)
  const clusterMap = payload.clusterMap ?? payload.devIntel?.clusterMap ?? null
  const deployer = payload.deployerAddress ?? payload.devIntel?.deployerAddress ?? null

  return NextResponse.json({
    ...payload,
    deployer,
    deployerAddress: deployer,
    pastLaunches: previousProjects,
    rugHistory: rugProjects,
    profitHistory: payload.profitHistory ?? null,
    clusterDetection: clusterMap,
    labels: Array.isArray(payload.labels) ? payload.labels : labelsFrom(payload),
    previousProjects,
    clusterMap,
  })
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const address = url.searchParams.get('address') ?? url.searchParams.get('contractAddress') ?? url.searchParams.get('contract') ?? ''
  const chain = url.searchParams.get('chain') ?? 'base'

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid or missing address parameter.' }, { status: 400 })
  }

  return runWalletScan(req, address, chain)
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const address = String(body.address ?? body.contractAddress ?? body.contract ?? '')
  const chain = String(body.chain ?? 'base')

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid or missing address parameter.' }, { status: 400 })
  }

  return runWalletScan(req, address, chain)
}
