// lib/server/cache/redisClient.ts — Redis client for the background-job system
// (app/api/scan-v2/full-scan-job/*).
//
// CLIENT CHOICE, DISCLOSED (verified before writing this file, not assumed): the original spec for
// this file asked for `@upstash/redis` (an HTTPS REST client) constructed with `url:
// process.env.REDIS_URL`. Checked directly against @upstash/redis's own type definitions
// (node_modules/@upstash/redis's Redis class constructor doc comment): that client requires an
// https:// REST endpoint (its own documented example is `UPSTASH_REDIS_REST_URL`), not a `redis://`
// TCP connection string. `REDIS_URL`, as Vercel's native Redis/Upstash marketplace integration
// provisions it, is confirmed (per this session's direction) to be the raw `redis://` TCP
// connection string — the two are incompatible; pairing them would compile cleanly but fail to
// connect at runtime. `ioredis` is the correct client for a genuine `redis://` connection string
// (a real TCP Redis client, not an HTTP one), so it's used here instead.
//
// ENV VARS, UNCHANGED PER INSTRUCTION ("do not rename any environment variables"):
//   - REDIS_URL is the sole connection string ioredis needs — a `redis://` (or `rediss://` for
//     TLS) URL already carries its own auth (username/password) embedded in the URL itself, per
//     the standard Redis connection-string format. That's a real, structural difference from a
//     REST client, which needs a separate bearer token — it's not this file dropping or ignoring
//     KV_REST_API_TOKEN/KV_REST_API_READ_ONLY_TOKEN, those two vars simply have no equivalent
//     concept in a TCP client's connection model. They are read and exported below (via
//     `restTokensConfigured`) purely as an honest diagnostic signal — e.g. to tell whether this
//     deployment still has REST-style Redis vars set alongside REDIS_URL — but they are never
//     passed into the ioredis client itself, since there is nowhere in ioredis's API for a REST
//     bearer token to go.
//
// FAIL-OPEN, DISCLOSED: `lazyConnect: true` means ioredis does not attempt a connection until the
// first real command — so importing this module never blocks or throws just because REDIS_URL is
// unset (e.g. local dev without Redis configured at all). A `maxRetriesPerRequest` cap and an
// attached `'error'` listener are both required specifically because ioredis otherwise (a) retries
// forever by default, which would leave a request hanging, and (b) emits unhandled `'error'` events
// that crash the Node process if nothing is listening for them — both are real ioredis behaviors,
// not hypothetical.

import Redis from 'ioredis'
import { kv } from '@vercel/kv'

const REDIS_URL = process.env.REDIS_URL ?? ''

// Diagnostic only — see file header. Never passed to the ioredis client itself.
export function restTokensConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN)
}

export function redisConfigured(): boolean {
  return Boolean(REDIS_URL || (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN))
}

let client: Redis | null = null
let criticalClient: Redis | null = null

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function createRedisClient(kind: 'normal' | 'critical'): Redis | null {
  if (!REDIS_URL) return null
  return new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    commandTimeout: positiveInt(
      kind === 'critical' ? process.env.REDIS_FINAL_WRITE_COMMAND_TIMEOUT_MS : process.env.REDIS_COMMAND_TIMEOUT_MS,
      kind === 'critical' ? 10000 : 2000,
    ),
    connectTimeout: positiveInt(
      kind === 'critical' ? process.env.REDIS_FINAL_WRITE_CONNECT_TIMEOUT_MS : process.env.REDIS_CONNECT_TIMEOUT_MS,
      kind === 'critical' ? 5000 : 2000,
    ),
    retryStrategy: null,
    enableOfflineQueue: false,
  })
}

function attachRedisErrorLogger(c: Redis, kind: 'normal' | 'critical'): Redis {
  c.on('error', (err) => {
    console.warn('[redisClient] connection error', { kind, message: err instanceof Error ? err.message : String(err) })
  })
  return c
}

function getClient(): Redis | null {
  if (!REDIS_URL) return null
  if (client) return client

  client = createRedisClient('normal')
  return client ? attachRedisErrorLogger(client, 'normal') : null
}

function getCriticalClient(): Redis | null {
  if (!REDIS_URL) return null
  if (criticalClient) return criticalClient
  criticalClient = createRedisClient('critical')
  return criticalClient ? attachRedisErrorLogger(criticalClient, 'critical') : null
}

// Thin, disclosed adapter matching the small subset of the API this codebase's job routes use —
// JSON-serializes on write, JSON-parses on read, so callers don't need to know this is ioredis
// rather than a REST client with built-in object (de)serialization.
export const redis = {
  async get<T = unknown>(key: string): Promise<T | null> {
    const c = getClient()
    if (c) {
      const raw = await c.get(key)
      if (raw == null) return null
      try {
        return JSON.parse(raw) as T
      } catch {
        return null // malformed stored value — treat as a miss, never throw
      }
    }
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null
    return await kv.get<T>(key)
  },
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const c = getClient()
    if (c) {
      const serialized = JSON.stringify(value)
      if (opts?.ex) {
        await c.set(key, serialized, 'EX', opts.ex)
      } else {
        await c.set(key, serialized)
      }
      return
    }
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) throw new Error('redis_client_unavailable')
    if (opts?.ex) {
      await kv.set(key, value, { ex: opts.ex })
    } else {
      await kv.set(key, value)
    }
  },
  async setCritical(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const c = getCriticalClient()
    if (c) {
      const serialized = JSON.stringify(value)
      if (opts?.ex) {
        await c.set(key, serialized, 'EX', opts.ex)
      } else {
        await c.set(key, serialized)
      }
      return
    }
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) throw new Error('redis_critical_client_unavailable')
    if (opts?.ex) {
      await kv.set(key, value, { ex: opts.ex })
    } else {
      await kv.set(key, value)
    }
  },
}
