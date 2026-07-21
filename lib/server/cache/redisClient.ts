// lib/server/cache/redisClient.ts — Upstash Redis REST client for serverless-safe job storage.
//
// Vercel Serverless Functions cannot reliably use long-lived Redis TCP sockets. This module is
// intentionally limited to @upstash/redis's HTTPS REST client and never imports ioredis or any
// TCP-based Redis client. Configure the database with a REST endpoint/token in the same region as
// the Vercel deployment (`iad1`) or use an Upstash Global database.

import { Redis } from '@upstash/redis'

const EXPECTED_REDIS_REGION = 'iad1'

function restUrl(): string {
  return process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? ''
}

function restToken(): string {
  return process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? ''
}

function readOnlyRestToken(): string {
  return process.env.UPSTASH_REDIS_REST_READ_ONLY_TOKEN ?? process.env.KV_REST_API_READ_ONLY_TOKEN ?? ''
}

function deploymentRegion(): string {
  return process.env.VERCEL_REGION ?? EXPECTED_REDIS_REGION
}

export type RedisRestErrorLog = {
  code?: string
  name?: string
  message: string
  endpoint?: string
  region: string
}

export class RedisRestUnavailableError extends Error {
  code?: string
  endpoint?: string
  region: string

  constructor(message: string, details?: { code?: string; endpoint?: string; region?: string; cause?: unknown }) {
    super(message)
    this.name = 'RedisRestUnavailableError'
    this.code = details?.code
    this.endpoint = details?.endpoint
    this.region = details?.region ?? redisRegion()
    if (details?.cause) this.cause = details.cause
  }
}

export function restTokensConfigured(): boolean {
  return Boolean(restToken() || readOnlyRestToken())
}

export function redisConfigured(): boolean {
  return Boolean(restUrl() && restToken())
}

export function redisEndpoint(): string | undefined {
  const endpoint = restUrl()
  if (!endpoint) return undefined
  try {
    const url = new URL(endpoint)
    return url.origin
  } catch {
    return endpoint
  }
}

export function redisRegion(): string {
  const configured = process.env.UPSTASH_REDIS_REGION ?? process.env.KV_REST_API_REGION
  if (configured) return configured
  const endpoint = redisEndpoint()?.toLowerCase() ?? ''
  if (endpoint.includes('global')) return 'global'
  const match = endpoint.match(/\b([a-z]{3}\d)\b/)
  return match?.[1] ?? EXPECTED_REDIS_REGION
}

export function redisRegionAligned(): boolean {
  const region = redisRegion()
  return region === 'global' || region === deploymentRegion()
}

function timeoutMs(kind: 'normal' | 'critical'): number {
  const raw = kind === 'critical' ? process.env.REDIS_FINAL_WRITE_COMMAND_TIMEOUT_MS : process.env.REDIS_COMMAND_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : kind === 'critical' ? 10_000 : 2_000
}

function errorDetails(error: unknown): RedisRestErrorLog {
  const err = error as { code?: unknown; name?: unknown; message?: unknown } | null
  return {
    code: typeof err?.code === 'string' ? err.code : undefined,
    name: typeof err?.name === 'string' ? err.name : undefined,
    message: String(err?.message ?? error),
    endpoint: redisEndpoint(),
    region: redisRegion(),
  }
}

export function logRedisRestError(label: string, error: unknown): RedisRestErrorLog {
  const details = errorDetails(error)
  console.error(label, details)
  return details
}

export function isRedisRestTimeout(error: unknown): boolean {
  const details = errorDetails(error)
  const message = details.message.toLowerCase()
  return details.code === 'ETIMEDOUT' || details.name === 'TimeoutError' || message.includes('timeout') || message.includes('timed out')
}

let client: Redis | null = null

function getClient(): Redis | null {
  if (!redisConfigured()) return null
  if (client) return client
  client = new Redis({ url: restUrl(), token: restToken() })
  if (!redisRegionAligned()) {
    console.warn('[redis-rest] region-mismatch', { endpoint: redisEndpoint(), region: redisRegion(), expectedRegion: EXPECTED_REDIS_REGION, vercelRegion: deploymentRegion() })
  }
  return client
}

async function withTimeout<T>(promise: Promise<T>, kind: 'normal' | 'critical'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new RedisRestUnavailableError('redis_rest_timeout', { code: 'ETIMEDOUT' })), timeoutMs(kind))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const redis = {
  async get<T = unknown>(key: string): Promise<T | null> {
    const c = getClient()
    if (!c) throw new RedisRestUnavailableError('redis_rest_client_unavailable', { endpoint: redisEndpoint() })
    return await withTimeout(c.get<T>(key), 'normal')
  },
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const c = getClient()
    if (!c) throw new RedisRestUnavailableError('redis_rest_client_unavailable', { endpoint: redisEndpoint() })
    if (opts?.ex) await withTimeout(c.set(key, value, { ex: opts.ex }), 'normal')
    else await withTimeout(c.set(key, value), 'normal')
  },
  async setCritical(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const c = getClient()
    if (!c) throw new RedisRestUnavailableError('redis_rest_client_unavailable', { endpoint: redisEndpoint() })
    if (opts?.ex) await withTimeout(c.set(key, value, { ex: opts.ex }), 'critical')
    else await withTimeout(c.set(key, value), 'critical')
  },
}
