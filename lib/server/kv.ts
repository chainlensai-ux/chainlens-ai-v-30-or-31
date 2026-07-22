import { kv as vercelKv } from '@vercel/kv'

// BOUNDED TIMEOUT, DISCLOSED: `@vercel/kv`'s get/set have no built-in timeout — an unbounded await
// on a slow/unreachable KV endpoint hangs every caller of this module (the wallet-scan job
// enqueue/poll store, src/modules/walletScanQueue.ts) until the platform's own outer function
// timeout fires. This module's callers already wrap every call in a try/catch that turns any
// thrown error into a real, honest 503 (WalletScanQueueUnavailableError/
// WalletScanStatusUnavailableError, see walletScanQueue.ts) — so making a hang surface as a timeout
// error, same as a real KV outage, is strictly safer than hanging indefinitely, and does not change
// behavior for a genuine immediate rejection (Promise.race resolves to whichever settles first).
const KV_CALL_TIMEOUT_MS = 2_000

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('kv_timeout')), KV_CALL_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export const kv: {
  get: <T = unknown>(key: string | null) => Promise<T | null>
  set: (key: string, value: unknown, opts?: { ex?: number }) => Promise<unknown>
} = {
  async get<T = unknown>(key: string | null): Promise<T | null> {
    if (key === null) return null
    return await withTimeout(vercelKv.get<T>(key))
  },
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> {
    return await withTimeout(opts?.ex ? vercelKv.set(key, value, { ex: opts.ex }) : vercelKv.set(key, value))
  },
}
