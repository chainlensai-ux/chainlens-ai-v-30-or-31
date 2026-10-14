// Alchemy Address Activity webhook → whale_alerts candidate rows (pure; the route does I/O).
import { NATIVE_ETH_SENTINEL } from './whaleAlertIdentity'

export type AlchemyActivity = {
  fromAddress?: string | null
  toAddress?: string | null
  hash?: string | null
  value?: number | null
  asset?: string | null
  category?: string | null
  rawContract?: {
    address?: string | null
    decimals?: number | null
    rawValue?: string | null
  } | null
}

export type WebhookTrackedWallet = { address: string; label: string | null }

/** Networks this feed stores. Every row is written with chain 'base'. */
export const SUPPORTED_WEBHOOK_NETWORKS = new Set(['BASE_MAINNET'])

const ROUTING_ONLY_SYMBOLS = new Set(['USDC', 'USDBC', 'EURC', 'DAI', 'USDT', 'WETH', 'ETH', 'CBBTC', 'WSTETH'])

function isBelowSymbolThreshold(symbol: string | null, amount: number | null): boolean {
  if (amount === null) return false
  const sym = symbol?.toUpperCase() ?? ''
  if (sym === 'USDC' || sym === 'USDT' || sym === 'DAI' || sym === 'USDBC' || sym === 'EURC') return amount < 100
  if (sym === 'WETH' || sym === 'ETH') return amount < 0.01
  return amount <= 0
}

function isLikelyApproval(category: string | null, rawValue: string | null, amountToken: number | null): boolean {
  const cat = (category ?? '').toLowerCase()
  if (cat.includes('approval') || cat.includes('allowance')) return true
  if (amountToken !== null) return false
  return rawValue === '0' || rawValue === '0x0'
}

function shouldEnrichCandidate(symbol: string | null, amountToken: number | null, category: string | null): boolean {
  const sym = symbol?.toUpperCase() ?? null
  const cat = (category ?? '').toLowerCase()
  const nonRouting = sym !== null && !ROUTING_ONLY_SYMBOLS.has(sym)
  const aboveThreshold = amountToken !== null && !isBelowSymbolThreshold(sym, amountToken)
  const meaningfulType = cat.includes('swap') || cat.includes('transfer') || cat.includes('erc20')
  return nonRouting || aboveThreshold || meaningfulType
}

export type WebhookCandidateResult = {
  candidates: Record<string, unknown>[]
  earlySkipped: number
  duplicateSkipped: number
  relevantForEnrichment: number
}

/**
 * Identity matches the sync producer so both converge on one row per movement:
 *  - wallet_address is the tracked wallet's stored address (not the payload's casing);
 *  - native ETH (category external, no contract) uses NATIVE_ETH_SENTINEL as token_address;
 *  - one candidate per (tx, wallet, token, side): a swap's two legs are two candidates, while a
 *    payload repeating the same leg yields one.
 */
export function buildWebhookCandidates(
  activity: readonly unknown[],
  wallets: readonly WebhookTrackedWallet[],
  occurredAt: string,
): WebhookCandidateResult {
  const walletMap = new Map<string, WebhookTrackedWallet>()
  for (const w of wallets) walletMap.set(w.address.toLowerCase(), w)

  const seenLegs = new Set<string>()
  const candidates: Record<string, unknown>[] = []
  let duplicateSkipped = 0
  let earlySkipped = 0
  let relevantForEnrichment = 0

  for (const raw of activity) {
    const item = (raw ?? {}) as AlchemyActivity
    const txHash = item.hash?.trim() ?? null
    if (!txHash) { earlySkipped += 1; continue }

    const tokenSymbol = item.asset?.toUpperCase() ?? null
    const contract = item.rawContract?.address?.trim().toLowerCase() || null
    const rawValue = item.rawContract?.rawValue ?? null
    const amountToken = typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null
    const isNative = contract === null && item.category === 'external' && (tokenSymbol === 'ETH' || tokenSymbol === null)
    const tokenAddress = contract ?? (isNative ? NATIVE_ETH_SENTINEL : null)

    if (isLikelyApproval(item.category ?? null, rawValue, amountToken)) { earlySkipped += 1; continue }

    const isInternal = item.category === 'internal'
    const isZeroValue = amountToken !== null && amountToken <= 0
    const isNativeDust = contract === null && (tokenSymbol === 'ETH' || tokenSymbol === null) && (amountToken === null || amountToken < 0.01)
    if (isZeroValue || isInternal || isNativeDust) { earlySkipped += 1; continue }

    const fromKey = item.fromAddress?.toLowerCase() ?? null
    const toKey = item.toAddress?.toLowerCase() ?? null
    const matches: Array<{ wallet: WebhookTrackedWallet; side: 'buy' | 'sell' }> = []
    const fromWallet = fromKey ? walletMap.get(fromKey) : undefined
    const toWallet = toKey ? walletMap.get(toKey) : undefined
    if (fromWallet) matches.push({ wallet: fromWallet, side: 'sell' })
    if (toWallet) matches.push({ wallet: toWallet, side: 'buy' })
    if (matches.length === 0) { earlySkipped += 1; continue }

    for (const match of matches) {
      const legKey = [txHash.toLowerCase(), match.wallet.address.toLowerCase(), tokenAddress ?? tokenSymbol ?? '', match.side].join('|')
      if (seenLegs.has(legKey)) { duplicateSkipped += 1; continue }
      seenLegs.add(legKey)
      if (!shouldEnrichCandidate(tokenSymbol, amountToken, item.category ?? null)) { earlySkipped += 1; continue }
      relevantForEnrichment += 1
      candidates.push({
        wallet_address: match.wallet.address,
        wallet_label: match.wallet.label ?? null,
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        token_name: null,
        owner_user_id: null,
        alert_type: 'token_transfer',
        side: match.side,
        amount_usd: null,
        amount_token: amountToken,
        tx_hash: txHash,
        chain: 'base',
        severity: null,
        summary: `Alchemy webhook: ${match.side} ${tokenSymbol ?? 'token'} via ${item.category ?? 'transaction'}`,
        occurred_at: occurredAt,
      })
    }
  }

  return { candidates, earlySkipped, duplicateSkipped, relevantForEnrichment }
}
