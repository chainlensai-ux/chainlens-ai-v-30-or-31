// MODULE — swapNormalizer: transferClassifier()
//
// Classifies a single transfer relative to the scanned wallet and (optionally) a known router
// address for this transaction. Pure, deterministic: same inputs always produce the same label.

import type { RawTransfer } from './types'

export type TransferClass = 'TRANSFER_IN' | 'TRANSFER_OUT' | 'INTERNAL' | 'ROUTER_IN' | 'ROUTER_OUT'

// classifyTransfer() — see module header.
//
// Priority (deliberate, documented):
//   1. Neither side is the wallet -> INTERNAL. This is what lets multi-hop legs between a router
//      and intermediate pools (which never touch the wallet's own address) get combined into a
//      single trade instead of being misread as unrelated noise.
//   2. Wallet sends TO the known router -> ROUTER_IN (wallet's tokenIn leg going into the router).
//   3. Wallet receives FROM the known router -> ROUTER_OUT (the router's output leg to the wallet).
//   4. Otherwise, a direct wallet-facing transfer not involving the known router -> TRANSFER_IN /
//      TRANSFER_OUT (covers direct pool-to-user transfers, and plain non-swap transfers).
export function classifyTransfer(
  transfer: RawTransfer,
  walletAddress: string,
  routerAddress?: string | null,
): TransferClass {
  const wallet = walletAddress.toLowerCase()
  const from = transfer.from.toLowerCase()
  const to = transfer.to.toLowerCase()
  const router = routerAddress ? routerAddress.toLowerCase() : null

  const walletIsSender = from === wallet
  const walletIsRecipient = to === wallet

  if (!walletIsSender && !walletIsRecipient) return 'INTERNAL'

  if (walletIsSender && router && to === router) return 'ROUTER_IN'
  if (walletIsRecipient && router && from === router) return 'ROUTER_OUT'

  if (walletIsRecipient) return 'TRANSFER_IN'
  return 'TRANSFER_OUT'
}

export function classifyTransfers(
  transfers: RawTransfer[],
  walletAddress: string,
  routerAddress?: string | null,
): Array<{ transfer: RawTransfer; class: TransferClass }> {
  return transfers.map((transfer) => ({ transfer, class: classifyTransfer(transfer, walletAddress, routerAddress) }))
}
