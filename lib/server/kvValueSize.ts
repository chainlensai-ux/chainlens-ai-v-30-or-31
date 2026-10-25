// Upstash rejects any request over its max request size (10 MB on the free plan) and emails the owner
// each time. Every KV write goes through this check first: a value too large to store is skipped with
// one log line naming the key family and size, and the write throws — every caller already treats a
// failed write as "not cached", so nothing is lost but the cache entry.

/** Kept well under the 10 MB request limit to leave room for the key and the request envelope. */
export const KV_MAX_VALUE_BYTES = 8_000_000

export class KvValueTooLargeError extends Error {
  constructor(readonly key: string, readonly bytes: number) {
    super(`kv_value_too_large: ${bytes} bytes`)
    this.name = 'KvValueTooLargeError'
  }
}

/** JSON size of `value` in bytes; -1 when it cannot be serialized (the client will fail on it anyway). */
export function kvValueBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') } catch { return -1 }
}

/** The key without per-wallet/per-token parts, so the log says which writer it was without leaking ids. */
function keyFamily(key: string): string {
  return key.split(':').filter((part) => !/^0x[0-9a-f]{6,}$/i.test(part) && !/^[0-9a-f-]{16,}$/i.test(part) && !/^\d{6,}$/.test(part)).slice(0, 4).join(':')
}

export function assertKvValueWithinLimit(key: string, value: unknown, maxBytes: number = KV_MAX_VALUE_BYTES): void {
  const bytes = kvValueBytes(value)
  if (bytes <= maxBytes) return
  console.warn('[kv-oversize-write-skipped]', { keyFamily: keyFamily(key), bytes, maxBytes })
  throw new KvValueTooLargeError(key, bytes)
}
