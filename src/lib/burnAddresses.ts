// Addresses a token transfer can be sent to only to destroy it. A transfer to one of these returns nothing
// to the sender, so it is never a sale and never part of a swap.
export const BURN_ADDRESSES: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
])

export function isBurnAddress(address: string | null | undefined): boolean {
  return typeof address === 'string' && BURN_ADDRESSES.has(address.toLowerCase())
}
