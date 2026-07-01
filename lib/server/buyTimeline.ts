// BUY-TIMELINE: isolated, additive, informational-only module. Reconstructs a wallet's
// acquisition (BUY) history entirely from GoldRush + Alchemy provider data — never Moralis.
// Callers are responsible for only ever passing GoldRush/Alchemy-sourced events; this module has
// no provider fetch logic of its own and no dependency on lib/server/moralis.
//
// Safety: this is a read-only, best-effort informational lane. It does NOT classify sells, does
// NOT run FIFO, does NOT compute or unlock official/public PnL, and does NOT feed into any
// integrity gate — walletSnapshot.ts's existing FIFO/pricing/public-PnL pipeline is completely
// untouched by this module. It only answers "what did this wallet acquire and when."

export type BuyTimelineSourceEvent = {
  txHash: string | null
  timestamp: string | null
  fromAddress: string | null
  toAddress: string | null
  contract: string
  symbol: string
  amount: number
  amountRaw: string | null
  chain: string
  direction: 'buy' | 'sell' | 'unknown'
}

export type BuyTimelineProvider = 'goldrush' | 'alchemy'

export type BuyTimelineSourceItem = {
  event: BuyTimelineSourceEvent
  provider: BuyTimelineProvider
}

export type BuyTimelineEvent = {
  timestamp: number
  txHash: string
  token: string
  amount: string
  chain: string
  provider: BuyTimelineProvider
  // Informational only — true when the same tx also has a wallet-side outbound leg (a same-tx
  // swap shape). Never required for BUY classification: an inbound-to-wallet transfer is a BUY
  // whether or not a paired outbound leg or a known router is present ("router-independent").
  pairedWithSameTxOutbound: boolean
}

export type BuyTimelineSummary = {
  firstBuyAt: number | null
  lastBuyAt: number | null
  mostActivePeriod: { period: string; count: number } | null
  topAcquiredTokens: Array<{ token: string; count: number }>
  acquisitionVelocity: number | null // buys per day, null when fewer than 2 buys
}

export type BuyTimelineResult = {
  totalBuys: number
  buys: BuyTimelineEvent[]
  summary: BuyTimelineSummary
}

function txGroupKey(event: BuyTimelineSourceEvent): string {
  return event.txHash ?? `no-tx:${event.contract}:${event.timestamp ?? ''}`
}

export function buildBuyTimeline(mergedEvents: BuyTimelineSourceItem[], walletAddress: string): BuyTimelineResult {
  const walletLower = (walletAddress ?? '').toLowerCase()

  const byTx = new Map<string, BuyTimelineSourceItem[]>()
  for (const item of mergedEvents) {
    const key = txGroupKey(item.event)
    const group = byTx.get(key) ?? []
    group.push(item)
    byTx.set(key, group)
  }

  const buys: BuyTimelineEvent[] = []
  const seen = new Set<string>()

  for (const item of mergedEvents) {
    const { event, provider } = item
    if (!event.contract || !event.contract.toLowerCase().startsWith('0x')) continue
    if (!event.timestamp) continue
    const ts = Date.parse(event.timestamp)
    if (!Number.isFinite(ts)) continue

    // BUY rule (GoldRush and Alchemy both): the event is a direct inbound ERC20 transfer to the
    // wallet. This already covers "GoldRush inbound transfers (direction === 'buy')" and "Alchemy
    // inbound Transfer events to walletAddress" identically, since both providers' upstream
    // normalization sets `direction` from the same to/from-vs-wallet rule. Router-independent
    // pairing (same-tx inbound/outbound) is never a REQUIREMENT for promotion — it is surfaced
    // below as informational context only, never gating.
    const isInboundToWallet = event.direction === 'buy' && (event.toAddress ?? '').toLowerCase() === walletLower
    if (!isInboundToWallet) continue

    const dedupeKey = `${event.txHash ?? ''}|${event.contract.toLowerCase()}|${event.amountRaw ?? event.amount}|${provider}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const group = byTx.get(txGroupKey(event)) ?? []
    const pairedWithSameTxOutbound = group.some(g => (g.event.fromAddress ?? '').toLowerCase() === walletLower)

    buys.push({
      timestamp: ts,
      txHash: event.txHash ?? '',
      token: event.symbol || event.contract,
      amount: event.amountRaw ?? String(event.amount),
      chain: event.chain,
      provider,
      pairedWithSameTxOutbound,
    })
  }

  buys.sort((a, b) => a.timestamp - b.timestamp)

  return { totalBuys: buys.length, buys, summary: buildBuyTimelineSummary(buys) }
}

function buildBuyTimelineSummary(buys: BuyTimelineEvent[]): BuyTimelineSummary {
  if (buys.length === 0) {
    return { firstBuyAt: null, lastBuyAt: null, mostActivePeriod: null, topAcquiredTokens: [], acquisitionVelocity: null }
  }

  const firstBuyAt = buys[0].timestamp
  const lastBuyAt = buys[buys.length - 1].timestamp

  // Grouped by UTC day — the finest grain that still reads as a "period" rather than a single
  // event, so a real acquisition spike is visible without needing a week/month rollup.
  const byDay = new Map<string, number>()
  for (const b of buys) {
    const day = new Date(b.timestamp).toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  let mostActivePeriod: { period: string; count: number } | null = null
  for (const [period, count] of byDay.entries()) {
    if (!mostActivePeriod || count > mostActivePeriod.count) mostActivePeriod = { period, count }
  }

  const byToken = new Map<string, number>()
  for (const b of buys) byToken.set(b.token, (byToken.get(b.token) ?? 0) + 1)
  const topAcquiredTokens = [...byToken.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([token, count]) => ({ token, count }))

  const acquisitionVelocity = buys.length < 2
    ? null
    : buys.length / Math.max(1, (lastBuyAt - firstBuyAt) / (1000 * 60 * 60 * 24))

  return { firstBuyAt, lastBuyAt, mostActivePeriod, topAcquiredTokens, acquisitionVelocity }
}
