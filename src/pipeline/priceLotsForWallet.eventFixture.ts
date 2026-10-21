// Shared by the priceLotsForWallet tests: the integer amount a provider would report for a human
// `amount` at `decimals`. Quote-leg pricing verifies amount == amountRaw / 10^decimals and rejects
// any leg where they disagree (quote_amount_normalization_mismatch), so fixtures must keep the
// two consistent instead of hard-coding one raw value for every event.
export function rawAmountFor(amount: number, decimals: number): string {
  const [whole, fraction = ''] = amount.toFixed(Math.min(decimals, 100)).split('.')
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals)).toString()
}
