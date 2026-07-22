import { kv as vercelKv } from '@vercel/kv'

export const kv: {
  get: <T = unknown>(key: string | null) => Promise<T | null>
  set: (key: string, value: unknown, opts?: { ex?: number }) => Promise<unknown>
} = {
  async get<T = unknown>(key: string | null): Promise<T | null> {
    if (key === null) return null
    return await vercelKv.get<T>(key)
  },
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> {
    return opts?.ex ? await vercelKv.set(key, value, { ex: opts.ex }) : await vercelKv.set(key, value)
  },
}
