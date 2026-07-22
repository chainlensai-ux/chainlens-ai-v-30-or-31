import { kv as vercelKv } from '@vercel/kv'

// BOUNDED TIMEOUT, DISCLOSED: `@vercel/kv`'s get/set have no built-in timeout — an unbounded await
// on a slow/unreachable KV endpoint hangs every caller of this module (the wallet-scan job
// enqueue/poll store, src/modules/walletScanQueue.ts) until the platform's own outer function
// timeout fires. This module's callers already wrap every call in a try/catch that turns any
// thrown error into a real, honest 503 (WalletScanQueueUnavailableError/
// WalletScanStatusUnavailableError, see walletScanQueue.ts) — so making a hang surface as a timeout
// error, same as a real KV outage, is strictly safer than hanging indefinitely, and does not change
// behavior for a genuine immediate rejection (Promise.race resolves to whichever settles first).
//
// SEPARATE GET/SET BUDGETS, DISCLOSED (confirmed bug — real production evidence): a single flat
// 2000ms timeout applied to every set() call too, including publishFinal's final scan-result write
// (src/modules/walletScanWorker.ts) — a genuinely large payload (the full V2 report: matched lots,
// pricing maps, ayri attribution records) that legitimately needs more than 2s to write over a
// REST call, especially given this deployment's real, measured cross-region latency (Sydney to
// Upstash). A real run confirmed the pipeline itself now finishes in ~30s (after this session's
// earlier pnlReconciliation fix), only to have publishFinal's own result write time out at 2s and
// mark the job failed — the exact opposite of what a generous "critical write" budget already
// established elsewhere in this codebase (lib/server/cache/redisClient.ts's own
// REDIS_FINAL_WRITE_COMMAND_TIMEOUT_MS, 10s default) is for. Reads (polling, status checks) stay at
// the faster 2s budget — a slow read should fail fast, not stall a poll request — while writes get
// the same 10s budget redisClient.ts already uses for its own critical/final writes.
const KV_GET_TIMEOUT_MS = 2_000
const KV_SET_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('kv_timeout')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export const kv: {
  get: <T = unknown>(key: string | null) => Promise<T | null>
  set: (key: string, value: unknown, opts?: { ex?: number }) => Promise<unknown>
} = {
  async get<T = unknown>(key: string | null): Promise<T | null> {
    if (key === null) return null
    return await withTimeout(vercelKv.get<T>(key), KV_GET_TIMEOUT_MS)
  },
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> {
    return await withTimeout(opts?.ex ? vercelKv.set(key, value, { ex: opts.ex }) : vercelKv.set(key, value), KV_SET_TIMEOUT_MS)
  },
}
