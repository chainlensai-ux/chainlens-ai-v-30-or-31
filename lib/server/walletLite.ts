// V1 ENGINE REPLACED WITH LIGHTWEIGHT, ZERO-RPC FALLBACKS.
//
// Both functions below previously lived inline in app/api/portfolio/route.ts and
// lib/server/walletScannerRunner.ts respectively (each calling fetchWalletSnapshot() from
// lib/server/walletSnapshot.ts, which fires Alchemy RPC calls) — consolidated here into one
// shared module so there is exactly one place defining what "lite" wallet/portfolio data is.
//
// Both are honest empty placeholders — empty arrays/objects, never a fabricated balance,
// position, or identity field — not a real data source. Real GoldRush/Zerion/ENS wiring is NOT
// implemented here (out of scope for this task); flagged explicitly so this isn't mistaken for
// "wallet/portfolio data actually works now." Neither function ever calls an RPC/provider, and
// neither can throw — both are synchronous logic wrapped in a resolved Promise, so there is no
// I/O, no external call, and no failure mode to catch.

export type WalletLiteResult = {
  ok: true
  address: string
  balances: unknown[]
  positions: unknown[]
  chains: unknown[]
  identity: Record<string, unknown>
  labels: Record<string, unknown>
}

export async function getWalletLite(address: string): Promise<WalletLiteResult> {
  return {
    ok: true,
    address,
    balances: [],
    positions: [],
    chains: [],
    identity: {},
    labels: {},
  }
}

export async function getPortfolioLite(address: string): Promise<WalletLiteResult> {
  return {
    ok: true,
    address,
    balances: [],
    positions: [],
    chains: [],
    identity: {},
    labels: {},
  }
}
