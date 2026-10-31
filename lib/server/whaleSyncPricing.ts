// PRICE AT INGESTION. Whale alerts were stored with amount_usd = null and re-priced on every feed read
// (historical provider calls per alert, lost on every new server instance). The sync now prices what
// it can prove when it stores the alert:
//   - a verified stablecoin (by contract address): its amount, exactly;
//   - any other token whose transaction is at most SYNC_PRICE_MAX_AGE_MS old: amount × the token's
//     current DexScreener price, which is the market price at the trade within that age. Stored values
//     of non-stablecoins are labelled "estimated" by the feed (whaleUsdPricing.ts), never "verified".
// Older transactions, unknown amounts and unpriced tokens stay null; the feed's historical lookup
// handles them. Nothing is guessed.

import { getBaseStablecoinShortcut } from './whaleUsdPricing'
import { pricingAddressFor } from './whaleAlertIdentity'

export const SYNC_PRICE_MAX_AGE_MS = 30 * 60_000

type AlertRow = Record<string, unknown>
export type SyncPricingResult = { stablecoin: number; market: number; tooOld: number; unpriced: number }

const amountOf = (row: AlertRow) => (typeof row.amount_token === 'number' && Number.isFinite(row.amount_token) && row.amount_token > 0 ? row.amount_token : null)

export async function priceAlertsAtIngestion(
  alerts: AlertRow[],
  now: number,
  fetchPrices: (addresses: string[]) => Promise<Map<string, number>>,
): Promise<SyncPricingResult> {
  const result: SyncPricingResult = { stablecoin: 0, market: 0, tooOld: 0, unpriced: 0 }
  const needMarket: Array<{ row: AlertRow; address: string; amount: number }> = []
  for (const row of alerts) {
    const amount = amountOf(row)
    if (amount == null || row.amount_usd != null) continue
    const address = pricingAddressFor(row.token_address, row.token_symbol)
    if (getBaseStablecoinShortcut({ tokenAddress: address, symbol: row.token_symbol })?.sourceUsed === 'stablecoin_address_shortcut') {
      row.amount_usd = Math.round(amount * 100) / 100
      result.stablecoin += 1
      continue
    }
    const at = typeof row.occurred_at === 'string' ? Date.parse(row.occurred_at) : Number.NaN
    if (!Number.isFinite(at) || now - at < 0 || now - at > SYNC_PRICE_MAX_AGE_MS) { result.tooOld += 1; continue }
    if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) { result.unpriced += 1; continue }
    needMarket.push({ row, address: address.toLowerCase(), amount })
  }
  if (needMarket.length === 0) return result
  const prices = await fetchPrices([...new Set(needMarket.map((n) => n.address))]).catch(() => new Map<string, number>())
  for (const { row, address, amount } of needMarket) {
    const price = prices.get(address)
    const value = price != null && price > 0 ? Math.round(amount * price * 100) / 100 : null
    if (value != null && Number.isFinite(value) && value > 0) { row.amount_usd = value; result.market += 1 }
    else result.unpriced += 1
  }
  return result
}
