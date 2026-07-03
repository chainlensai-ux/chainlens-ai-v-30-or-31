// Temporary in-process RPC-call diagnostic buffer, for identifying runaway RPC usage.
//
// PATH CORRECTION, DISCLOSED: requested at src/lib/server/rpcDebug.ts — that directory doesn't
// exist (this repo's real shared-server-library convention is lib/server/*, at the project root,
// not src/lib/server/*; verified before creating this file — every other file this session built
// in this category lives at lib/server/*). Created at the real path instead.
//
// SCOPE NOTE, DISCLOSED: this buffer is in-memory only, per-serverless-instance (same limitation
// as every other in-memory Map()-based cache this codebase used before KV caching was introduced —
// it does not persist or aggregate across Vercel's instance fleet).
//
// COVERAGE (kept current — update this note whenever a new call site is instrumented, so it never
// goes stale again the way the first version of this comment did): as of this update, every real
// Alchemy/GoldRush/Covalent call site in the codebase logs here — lib/server/v2Adapters.ts,
// lib/server/walletSnapshot.ts, lib/server/lpProof.ts, the 3 V2 engine fetch modules
// (src/modules/providerFetchWindow, holdings, recoveryPolicy), src/modules/pricingAtTimeEngine's
// basedex.ts (viem RPC) and goldrushPriceSource.ts (GoldRush SDK), and 7 legacy app/api/* routes
// (token, clark, dev-wallet, scan-holder, whale-alerts, test/alchemy, test/alchemy-multichain) plus
// app/api/whale-alerts/sync, app/api/proxy/goldrush, app/api/test/goldrush, app/api/test/covalent.

export type RpcDebugEntry = {
  timestamp: number
  chain?: string
  method?: string
  route?: string
  stack?: string
}

export const rpcDebugLog: RpcDebugEntry[] = []

// MUST NOT throw — pushing onto an in-memory array cannot realistically fail, but this is wrapped
// anyway so a caller can invoke it unconditionally without a try/catch of its own.
export function logRpcCall(info: Omit<RpcDebugEntry, 'timestamp'>): void {
  try {
    rpcDebugLog.push({ timestamp: Date.now(), ...info })
  } catch {
    // Never throws, never surfaces to the caller.
  }
}
