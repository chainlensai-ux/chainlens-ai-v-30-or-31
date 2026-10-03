// Selected-wallet evidence only. Holder-index absence is never a balance or history result.
export type WalletBalanceSnapshot = {
  tokenBalanceRaw: string | null
  tokenBalanceSucceeded: boolean
  nativeBalance: number | null
  nativeBalanceSucceeded: boolean
  nativeSymbol?: string
  checkedAt?: string
}
export type LaunchReceiptEvidence = {
  wallet: string
  txHash: string
  timestamp: string | null
  rule: 'deployment_transaction' | 'deployment_plus_24h'
}
type Transfer = { from?: string | null; to?: string | null; txHash?: string | null; timestamp?: string | number | null; amountRaw?: string | number | null; category?: string | null }
const time = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : Date.parse(String(v))
  const ms = n < 1e12 ? n * 1000 : n
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? ms : null
}
// A verified deployment transaction anchors the window. Pool creation, current holdings,
// undated graph links and an arbitrary first page of transfers do NOT establish launch receipt.
export function launchReceiptsFromTransfers(transfers: Transfer[], verifiedCreationTx: string | null): LaunchReceiptEvidence[] {
  if (!verifiedCreationTx) return []
  const tokenTransfers = transfers.filter(t => t.category === 'erc20' && t.txHash && t.to && Number.isFinite(Number(t.amountRaw)) && Number(t.amountRaw) > 0)
  const deployment = tokenTransfers.filter(t => t.txHash!.toLowerCase() === verifiedCreationTx.toLowerCase())
  const start = deployment.map(t => time(t.timestamp)).find(t => t != null) ?? null
  return tokenTransfers.flatMap(t => {
    const inDeployment = t.txHash!.toLowerCase() === verifiedCreationTx.toLowerCase()
    const ts = time(t.timestamp)
    if (!inDeployment && !(start != null && ts != null && ts >= start && ts <= start + 86_400_000)) return []
    return [{ wallet: t.to!.toLowerCase(), txHash: t.txHash!, timestamp: ts == null ? null : new Date(ts).toISOString(), rule: inDeployment ? 'deployment_transaction' as const : 'deployment_plus_24h' as const }]
  })
}

export function rawInteger(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  try { return BigInt(raw) } catch { return null }
}
export function formatTokenUnits(raw: bigint, decimals: number): string {
  const digits = raw.toString().padStart(decimals + 1, '0')
  const whole = decimals ? digits.slice(0, -decimals) : digits
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : ''
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '')
}

export function resolveWalletDetail(input: {
  wallet: string; symbol?: string | null; decimals?: number | null; totalSupplyRaw?: string | null
  indexed?: { rank?: number | null; percent?: number | null; amount?: string | number | null } | null
  indexAvailable: boolean; snapshot?: WalletBalanceSnapshot | null; loading?: boolean
  launchReceipts?: LaunchReceiptEvidence[] | null
}) {
  const raw = input.snapshot?.tokenBalanceSucceeded ? rawInteger(input.snapshot.tokenBalanceRaw) : null
  const decimals = input.decimals
  const canScale = typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255
  const total = rawInteger(input.totalSupplyRaw)
  const pct = raw != null && total != null && total > BigInt(0) ? Number(raw * BigInt(1000000) / total) / 10000 : null
  const indexed = input.indexed
  const currentHolder = raw != null ? (raw > BigInt(0) ? 'Yes' : 'No') : 'Unknown'
  const supply = raw != null && canScale
    ? `${formatTokenUnits(raw, decimals)} ${input.symbol || 'tokens'}${pct != null ? ` · ${raw > BigInt(0) && pct < 0.01 ? '<0.01' : pct.toFixed(2)}%` : ''}`
    : raw != null ? `${raw.toString()} base units` : indexed?.percent != null ? `${indexed.percent.toFixed(2)}% of supply` : input.loading ? 'Checking balance…' : 'Unavailable'
  const nativeVerified = input.snapshot?.nativeBalanceSucceeded === true && typeof input.snapshot.nativeBalance === 'number' && Number.isFinite(input.snapshot.nativeBalance) && input.snapshot.nativeBalance >= 0
  const launch = input.launchReceipts?.find(e => e.wallet.toLowerCase() === input.wallet.toLowerCase())
  return {
    supply, currentHolder, percent: pct,
    supplySource: raw != null ? (canScale ? 'Direct on-chain balance' : 'Direct balance; token decimals unverified') : indexed?.percent != null ? 'Indexed holder snapshot' : input.loading ? 'Direct on-chain check in progress' : 'Balance could not be verified',
    indexedSupply: raw != null && indexed?.percent != null ? `Indexed snapshot: ${indexed.percent.toFixed(2)}%` : null,
    holderRank: indexed?.rank != null ? `#${indexed.rank}` : input.indexAvailable && !indexed ? 'Outside indexed holder set' : 'Rank unavailable',
    rankSource: indexed?.rank != null ? 'Indexed holder snapshot' : raw != null && raw > BigInt(0) ? 'Holder balance verified directly; rank not inferred' : 'Balance checks do not establish rank',
    currentHolderSource: raw != null ? 'Direct balance check' : indexed ? 'Indexed snapshot retained; current balance unverified' : 'No successful balance evidence',
    nativeBalance: nativeVerified ? `${input.snapshot!.nativeBalance!.toLocaleString('en-US', { maximumSignificantDigits: 6 })} ${input.snapshot!.nativeSymbol || 'ETH'}` : input.loading ? 'Checking balance…' : 'Unavailable',
    launchReceipt: launch ? 'Yes' : 'Not established',
    launchSource: launch ? `${launch.rule === 'deployment_transaction' ? 'Transfer in deployment transaction' : 'Transfer within 24h of deployment'} · ${launch.txHash}` : 'No verified launch-window transfer evidence',
    provenance: {
      tokenBalance: { status: raw != null || indexed?.percent != null ? 'verified' as const : 'unavailable' as const, source: raw != null ? 'rpc_balanceOf' as const : 'holder_index' as const },
      holderRank: { status: indexed?.rank != null ? 'verified' as const : input.indexAvailable && !indexed ? 'not_in_indexed_set' as const : 'unavailable' as const },
      nativeBalance: { status: nativeVerified ? 'verified' as const : 'unavailable' as const },
      launchReceipt: { status: launch ? 'verified' as const : 'not_established' as const },
    },
  }
}
