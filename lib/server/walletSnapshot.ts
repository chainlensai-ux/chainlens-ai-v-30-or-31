type Holding = {
  name: string
  symbol: string
  icon: string | null
  chain: string | null
  balance: number
  value: number
  price: number | null
  change24h: number | null
  verified: boolean
}

export type WalletSnapshot = {
  address: string
  totalValue: number
  holdings: Holding[]
  txCount: number | null
  firstTxDate: string | null
  walletAgeDays: number | null
  _diagnostics?: {
    walletProviderFieldsPresent: {
      holdings: boolean
      totalValue: boolean
      txCount: boolean
      walletAgeDays: boolean
    }
    missingReasons: string[]
  }
}

const ZERION_KEY       = process.env.ZERION_KEY!
const ALCHEMY_ETH_KEY  = process.env.ALCHEMY_ETHEREUM_KEY!
const ALCHEMY_BASE_KEY = process.env.ALCHEMY_BASE_KEY!

function zerionAuth() {
  return `Basic ${Buffer.from(`${ZERION_KEY}:`).toString('base64')}`
}

async function zerionGet(path: string, params: Record<string, string> = {}) {
  const url = new URL(`https://api.zerion.io/v1/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', Authorization: zerionAuth() },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Zerion ${res.status} ${path}`)
  return res.json()
}

async function alchemyRpc(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    cache: 'no-store',
  })
  const json = await res.json()
  return json.result ?? null
}

async function getFirstTxOnChain(address: string, alchemyUrl: string): Promise<Date | null> {
  const baseParams = {
    fromBlock: '0x0',
    category: ['external', 'internal', 'erc20'],
    withMetadata: true,
    maxCount: '0x1',
    order: 'asc',
  }
  const [sent, received] = await Promise.allSettled([
    alchemyRpc(alchemyUrl, 'alchemy_getAssetTransfers', [{ ...baseParams, fromAddress: address }]),
    alchemyRpc(alchemyUrl, 'alchemy_getAssetTransfers', [{ ...baseParams, toAddress: address }]),
  ])

  const dates: Date[] = []
  for (const r of [sent, received]) {
    const ts = r.status === 'fulfilled' && r.value?.transfers?.[0]?.metadata?.blockTimestamp
    if (ts) dates.push(new Date(ts as string))
  }
  return dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : null
}

export async function fetchWalletSnapshot(address: string): Promise<WalletSnapshot> {
  const addr: string = (address ?? '').trim()
  if (!addr || !/^0x[0-9a-fA-F]{40}$/i.test(addr)) {
    throw new Error('Invalid wallet address')
  }

  const ethUrl  = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_ETH_KEY}`
  const baseUrl = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_BASE_KEY}`

  const [positionsRes, portfolioRes, ethFirst, baseFirst, nonceRes] = await Promise.allSettled([
    zerionGet(`wallets/${addr}/positions/`, {
      currency: 'usd',
      'filter[positions]': 'only_simple',
      'filter[trash]': 'only_non_trash',
      sort: '-value',
      'page[size]': '50',
    }),
    zerionGet(`wallets/${addr}/portfolio/`, { currency: 'usd' }),
    getFirstTxOnChain(addr, ethUrl),
    getFirstTxOnChain(addr, baseUrl),
    alchemyRpc(ethUrl, 'eth_getTransactionCount', [addr, 'latest']),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawPos: any[] = positionsRes.status === 'fulfilled' ? (positionsRes.value?.data ?? []) : []
  const holdings = rawPos
    .map(pos => {
      const a  = pos.attributes ?? {}
      const fi = a.fungible_info ?? {}
      return {
        name:      fi.name      ?? 'Unknown',
        symbol:    fi.symbol    ?? '?',
        icon:      fi.icon?.url ?? null,
        chain:     pos.relationships?.chain?.data?.id ?? null,
        balance:   a.quantity?.float   ?? 0,
        value:     a.value             ?? 0,
        price:     a.price             ?? null,
        change24h: a.changes?.percent_1d ?? null,
        verified:  fi.flags?.verified  ?? false,
      }
    })
    .filter(h => h.value > 0.01)

  const totalValue: number =
    portfolioRes.status === 'fulfilled'
      ? (portfolioRes.value?.data?.attributes?.total?.positions ?? 0)
      : holdings.reduce((s, h) => s + h.value, 0)

  const firstCandidates: Date[] = []
  if (ethFirst.status  === 'fulfilled' && ethFirst.value)  firstCandidates.push(ethFirst.value)
  if (baseFirst.status === 'fulfilled' && baseFirst.value) firstCandidates.push(baseFirst.value)
  const firstTxDate = firstCandidates.length > 0
    ? new Date(Math.min(...firstCandidates.map(d => d.getTime())))
    : null
  const walletAgeDays = firstTxDate
    ? Math.floor((Date.now() - firstTxDate.getTime()) / 86_400_000)
    : null

  const txCount = nonceRes.status === 'fulfilled' && nonceRes.value
    ? parseInt(nonceRes.value as string, 16)
    : null

  return {
    address: addr,
    totalValue,
    holdings,
    txCount,
    firstTxDate: firstTxDate?.toISOString() ?? null,
    walletAgeDays,
    _diagnostics: {
      walletProviderFieldsPresent: {
        holdings: holdings.length > 0,
        totalValue: totalValue > 0,
        txCount: txCount !== null,
        walletAgeDays: walletAgeDays !== null,
      },
      missingReasons: [
        holdings.length === 0 ? 'holdings: Zerion returned no positions' : '',
        totalValue === 0 ? 'totalValue: portfolio endpoint returned zero' : '',
        txCount === null ? 'txCount: Alchemy nonce unavailable' : '',
        walletAgeDays === null ? 'walletAgeDays: no first-tx found on ETH or Base' : '',
      ].filter(Boolean),
    },
  }
}
