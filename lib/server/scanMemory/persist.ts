/**
 * Post-response memory writer. Server-only: imported by the token scan route, never by client code.
 * Disabled unless CORTEX_SCAN_MEMORY_ENABLED is exactly "true". The request path then returns
 * before extraction, after(), or any Supabase call. Database work cannot change the HTTP response.
 * The SQL migration is not applied by the build or by this module.
 */
import { after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/userSettings'
import { extractScanMemory, type ScanMemoryPayload, type ScanMemorySkipReason } from './extract'

export type ScanMemoryOutcome = 'accepted' | 'deduplicated' | 'capped' | 'skipped' | 'failed'
export type ScanMemoryLogReason = ScanMemorySkipReason | 'no_request_scope' | 'db_unavailable' | 'db_timeout' | 'db_error' | 'extract_error' | 'invalid_signal'

const TIMEOUT_MS = 800
const SCAN_MEMORY_FLAG = 'CORTEX_SCAN_MEMORY_ENABLED'

/** Only the exact string "true" enables memory. Unset, "false", "TRUE" and "1" stay off. */
export function scanMemoryEnabled(): boolean {
  return process.env[SCAN_MEMORY_FLAG] === 'true'
}

export function logScanMemory(outcome: ScanMemoryOutcome, reason?: ScanMemoryLogReason): void {
  const line = JSON.stringify(reason ? { event: 'scan_memory', outcome, reason } : { event: 'scan_memory', outcome })
  if (outcome === 'failed') console.error(line)
  else console.info(line)
}

type PersistDeps = {
  after?: (work: () => Promise<void> | void) => void
  rpc?: (payload: ScanMemoryPayload) => Promise<{ outcome?: string; reason?: string } | null>
  nowMs?: number
}

async function defaultRpc(payload: ScanMemoryPayload): Promise<{ outcome?: string; reason?: string } | null> {
  const client = createServiceRoleClient()
  if (!client) {
    logScanMemory('failed', 'db_unavailable')
    return null
  }
  const { data, error } = await client.rpc('record_scan_memory', { p_payload: payload })
  if (error) throw new Error('scan_memory_rpc')
  return data as { outcome?: string; reason?: string } | null
}

export async function persistScanMemoryPayload(payload: ScanMemoryPayload, rpc: PersistDeps['rpc'] = defaultRpc): Promise<void> {
  if (!scanMemoryEnabled()) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      rpc(payload),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS) }),
    ])
    if (result == null) return
    if (result.outcome === 'accepted' || result.outcome === 'deduplicated' || result.outcome === 'capped') {
      logScanMemory(result.outcome)
      return
    }
    logScanMemory('skipped', result.reason === 'invalid_signal' || result.reason === 'invalid_observed_at' ? result.reason : 'invalid_signal')
  } catch (error) {
    logScanMemory('failed', error instanceof Error && error.message === 'timeout' ? 'db_timeout' : 'db_error')
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Schedules one memory write. Never throws and never waits for the database. */
export function scheduleScanMemory(scan: unknown, deps: PersistDeps = {}): void {
  if (!scanMemoryEnabled()) return
  let payload: ScanMemoryPayload
  try {
    const extracted = extractScanMemory(scan, deps.nowMs)
    if (!extracted.ok) {
      logScanMemory('skipped', extracted.reason)
      return
    }
    payload = extracted.payload
  } catch {
    logScanMemory('failed', 'extract_error')
    return
  }
  const hook = deps.after ?? after
  const rpc = deps.rpc
  try {
    hook(() => { void persistScanMemoryPayload(payload, rpc).catch(() => logScanMemory('failed', 'db_error')) })
  } catch {
    logScanMemory('skipped', 'no_request_scope')
  }
}