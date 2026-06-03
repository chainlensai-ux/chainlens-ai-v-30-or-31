// Persistent Wallet Scanner cache backed by Supabase.
// Survives Vercel serverless cold-starts; shared across all function instances.
// Table DDL: supabase/wallet-scan-cache.sql
//
// scan_mode = 'deep' | 'basic' | 'historical' → cache rows (payload populated)
// scan_mode = 'cooldown'                       → cooldown rows (payload null)

import { createServiceRoleClient } from '@/lib/supabase/userSettings'

const TABLE = 'wallet_scan_cache'

export function walletScanPersistentCacheAvailable(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export type PersistentCacheEntry = {
  payload: unknown
  createdAt: Date
  expiresAt: Date
}

// Read a non-expired cache entry.
export async function readPersistentWalletCache(
  cacheKey: string,
): Promise<PersistentCacheEntry | null> {
  if (!walletScanPersistentCacheAvailable()) return null
  const client = createServiceRoleClient()
  if (!client) return null
  try {
    const { data, error } = await client
      .from(TABLE)
      .select('payload, created_at, expires_at')
      .eq('cache_key', cacheKey)
      .neq('scan_mode', 'cooldown')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (error || !data) return null
    const row = data as { payload: unknown; created_at: string; expires_at: string }
    return {
      payload: row.payload,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at),
    }
  } catch {
    return null
  }
}

// Read the most-recent cache entry regardless of expiry — stale fallback during cooldown.
export async function readStalePersistentWalletCache(
  cacheKey: string,
): Promise<PersistentCacheEntry | null> {
  if (!walletScanPersistentCacheAvailable()) return null
  const client = createServiceRoleClient()
  if (!client) return null
  try {
    const { data, error } = await client
      .from(TABLE)
      .select('payload, created_at, expires_at')
      .eq('cache_key', cacheKey)
      .neq('scan_mode', 'cooldown')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    const row = data as { payload: unknown; created_at: string; expires_at: string }
    return {
      payload: row.payload,
      createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at),
    }
  } catch {
    return null
  }
}

// Write or replace a cache entry.  Returns true on success.
export async function writePersistentWalletCache(
  cacheKey: string,
  address: string,
  scanMode: string,
  chainKey: string,
  payload: unknown,
  ttlMs: number,
): Promise<boolean> {
  if (!walletScanPersistentCacheAvailable()) return false
  const client = createServiceRoleClient()
  if (!client) return false
  try {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlMs)
    const { error } = await client.from(TABLE).upsert(
      {
        cache_key: cacheKey,
        address,
        scan_mode: scanMode,
        chain_key: chainKey,
        payload,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: 'cache_key' },
    )
    return !error
  } catch {
    return false
  }
}

export type PersistentCooldownEntry = { expiresAt: Date }

// Read a non-expired cooldown entry.
export async function readPersistentCooldown(
  cooldownKey: string,
): Promise<PersistentCooldownEntry | null> {
  if (!walletScanPersistentCacheAvailable()) return null
  const client = createServiceRoleClient()
  if (!client) return null
  try {
    const { data, error } = await client
      .from(TABLE)
      .select('expires_at')
      .eq('cache_key', cooldownKey)
      .eq('scan_mode', 'cooldown')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (error || !data) return null
    return { expiresAt: new Date((data as { expires_at: string }).expires_at) }
  } catch {
    return null
  }
}

// Write or replace a cooldown entry.  Returns true on success.
export async function writePersistentCooldown(
  cooldownKey: string,
  address: string,
  chainKey: string,
  ttlMs: number,
): Promise<boolean> {
  if (!walletScanPersistentCacheAvailable()) return false
  const client = createServiceRoleClient()
  if (!client) return false
  try {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlMs)
    const { error } = await client.from(TABLE).upsert(
      {
        cache_key: cooldownKey,
        address,
        scan_mode: 'cooldown',
        chain_key: chainKey,
        payload: null,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: 'cache_key' },
    )
    return !error
  } catch {
    return false
  }
}
