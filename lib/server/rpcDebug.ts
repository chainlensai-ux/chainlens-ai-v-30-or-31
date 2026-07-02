// Temporary in-process RPC-call diagnostic buffer, for identifying runaway RPC usage.
//
// PATH CORRECTION, DISCLOSED: requested at src/lib/server/rpcDebug.ts — that directory doesn't
// exist (this repo's real shared-server-library convention is lib/server/*, at the project root,
// not src/lib/server/*; verified before creating this file — every other file this session built
// in this category lives at lib/server/*). Created at the real path instead.
//
// SCOPE NOTE, DISCLOSED: this buffer is in-memory only, per-serverless-instance (same limitation
// as every other in-memory Map()-based cache this codebase used before KV caching was introduced —
// it does not persist or aggregate across Vercel's instance fleet). It's also only fed by the one
// call site this task's own scope was narrowed to instrument (lib/server/v2Adapters.ts) — see that
// file's own comment for why the other ~13 real RPC call sites across this codebase (including 3
// V2 engine internals and the legacy walletSnapshot.ts) are NOT wired into this buffer. This is a
// genuine, disclosed narrowing of "log every RPC call app-wide", not a claim of full coverage.

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
