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

function fallbackRestUrl(): string {
  return process.env.UPSTASH_REDIS_REST_URL_FALLBACK ?? process.env.UPSTASH_REDIS_GLOBAL_REST_URL ?? process.env.VERCEL_KV_REST_API_URL ?? ''
}

function fallbackRestToken(): string {
  return process.env.UPSTASH_REDIS_REST_TOKEN_FALLBACK ?? process.env.UPSTASH_REDIS_GLOBAL_REST_TOKEN ?? process.env.VERCEL_KV_REST_API_TOKEN ?? ''
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

export function redisFallbackConfigured(): boolean {
  return Boolean(fallbackRestUrl() && fallbackRestToken())
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

export function isRedisRestRateLimited(error: unknown): boolean {
  const details = errorDetails(error)
  const message = details.message.toLowerCase()
  return details.code === 'budget_exceeded' || message.includes('budget_exceeded') || message.includes('rate limit') || message.includes('too many requests') || message.includes('max requests') || message.includes('bandwidth')
}

export function logRedisRestUsageDiagnostics(label: string, error?: unknown): void {
  const err = error as { remainingRps?: unknown; remainingBandwidth?: unknown; remainingPipelineBudget?: unknown; latencyMs?: unknown; clusterHealth?: unknown; headers?: { get?: (name: string) => string | null } } | null
  const headers = err?.headers
  console.warn(label, {
    remainingRps: err?.remainingRps ?? headers?.get?.('x-ratelimit-remaining') ?? 'unknown',
    remainingBandwidth: err?.remainingBandwidth ?? headers?.get?.('x-upstash-remaining-bandwidth') ?? 'unknown',
    remainingPipelineBudget: err?.remainingPipelineBudget ?? headers?.get?.('x-upstash-remaining-pipeline') ?? 'unknown',
    regionLatencyMs: err?.latencyMs ?? 'unknown',
    clusterHealth: err?.clusterHealth ?? (redisRegionAligned() ? 'aligned' : 'region-mismatch'),
    endpoint: redisEndpoint(),
    fallbackConfigured: redisFallbackConfigured(),
    region: redisRegion(),
    deploymentRegion: deploymentRegion(),
  })
}

let client: Redis | null = null
let fallbackClient: Redis | null = null

function getClient(): Redis | null {
  if (!redisConfigured()) return null
  if (client) return client
  client = new Redis({ url: restUrl(), token: restToken() })
  if (!redisRegionAligned()) {
    console.warn('[redis-rest] region-mismatch', { endpoint: redisEndpoint(), region: redisRegion(), expectedRegion: EXPECTED_REDIS_REGION, vercelRegion: deploymentRegion() })
  }
  return client
}

function getFallbackClient(): Redis | null {
  if (!redisFallbackConfigured()) return null
  if (fallbackClient) return fallbackClient
  fallbackClient = new Redis({ url: fallbackRestUrl(), token: fallbackRestToken() })
  console.warn('[redis-rest] fallback-client-enabled', { endpoint: fallbackRestUrl() ? new URL(fallbackRestUrl()).origin : undefined, region: 'global' })
  return fallbackClient
}

async function withFallback<T>(label: string, primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary()
  } catch (err) {
    logRedisRestUsageDiagnostics(`[redis-rest] ${label} primary failure diagnostics`, err)
    const c = getFallbackClient()
    if (!c) throw err
    console.warn('[redis-rest] using fallback kv write path', { label, fallbackRegion: 'global' })
    return await fallback()
  }
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
    return await withFallback(`get:${key}`, () => withTimeout(c.get<T>(key), 'normal'), async () => { const f = getFallbackClient(); if (!f) throw new RedisRestUnavailableError('redis_rest_fallback_unavailable'); return await withTimeout(f.get<T>(key), 'normal') })
  },
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const c = getClient()
    if (!c) throw new RedisRestUnavailableError('redis_rest_client_unavailable', { endpoint: redisEndpoint() })
    await withFallback(`set:${key}`, () => opts?.ex ? withTimeout(c.set(key, value, { ex: opts.ex }), 'normal') : withTimeout(c.set(key, value), 'normal'), async () => { const f = getFallbackClient(); if (!f) throw new RedisRestUnavailableError('redis_rest_fallback_unavailable'); return opts?.ex ? await withTimeout(f.set(key, value, { ex: opts.ex }), 'normal') : await withTimeout(f.set(key, value), 'normal') })
  },
  async setCritical(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    const c = getClient()
    if (!c) throw new RedisRestUnavailableError('redis_rest_client_unavailable', { endpoint: redisEndpoint() })
    await withFallback(`setCritical:${key}`, () => opts?.ex ? withTimeout(c.set(key, value, { ex: opts.ex }), 'critical') : withTimeout(c.set(key, value), 'critical'), async () => { const f = getFallbackClient(); if (!f) throw new RedisRestUnavailableError('redis_rest_fallback_unavailable'); return opts?.ex ? await withTimeout(f.set(key, value, { ex: opts.ex }), 'critical') : await withTimeout(f.set(key, value), 'critical') })
  },
}
