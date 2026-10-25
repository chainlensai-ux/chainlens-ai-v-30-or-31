// The latest COMPLETE wallet-scan result per (user, wallet, mode), so opening a wallet that was scanned
// recently — by the user or by the scheduled pre-scan of their watchlist — shows that result at once
// instead of running a 3-minute scan again. Only a full result is recorded: never a partial/timed-out
// one, never one whose PnL is still processing in a follow-up job. The pointer names a job; the poll
// route already serves that job's stored result to its owner, so nothing is copied or re-derived.
import { kv } from '@/lib/server/kv'
import { walletScanJobKey, walletScanResultKey } from '@/src/modules/walletScanQueueKeys'

export type WalletScanMode = 'normal' | 'deep'
export type LatestWalletScan = { jobId: string; completedAt: number; scanMode: WalletScanMode }

/** How old a stored result may be and still be served instead of a new scan (env WALLET_SCAN_REUSE_MAX_AGE_MINUTES). */
export function walletScanReuseMaxAgeMs(): number {
  const minutes = Number.parseInt(process.env.WALLET_SCAN_REUSE_MAX_AGE_MINUTES ?? '', 10)
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 90) * 60_000
}

const POINTER_TTL_SECONDS = 24 * 60 * 60

export function walletScanLatestKey(userId: string, wallet: string, scanMode: WalletScanMode): string {
  return `walletScanLatest:v1:${userId}:${wallet.toLowerCase()}:${scanMode}`
}

/** PURE. A result fit to stand as "the latest scan": succeeded, not partial, PnL not deferred to a follow-up job. */
export function isCompleteWalletScanResult(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as { success?: unknown; partial?: unknown; pnlStillProcessing?: unknown; pnlFollowUpJobId?: unknown; data?: { pnlFollowUpJobId?: unknown } }
  if (b.success !== true || b.partial === true || b.pnlStillProcessing === true) return false
  return !b.pnlFollowUpJobId && !b.data?.pnlFollowUpJobId
}

export async function recordLatestWalletScan(params: { userId: string; wallet: string; scanMode: WalletScanMode; jobId: string; completedAt: number }): Promise<void> {
  try {
    await kv.set(walletScanLatestKey(params.userId, params.wallet, params.scanMode), { jobId: params.jobId, completedAt: params.completedAt, scanMode: params.scanMode } satisfies LatestWalletScan, { ex: POINTER_TTL_SECONDS })
  } catch (err) {
    console.warn('[wallet-scan-latest] pointer write failed', { jobId: params.jobId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The newest complete result this user may reuse for `wallet`, no older than `maxAgeMs`: a normal scan may
 * use a deep result (deep covers more), a deep scan only a deep one. Null when none, when stale, or when the
 * job's stored result is gone. Never throws.
 */
export async function readReusableWalletScan(params: { userId: string; wallet: string; scanMode: WalletScanMode; now?: number; maxAgeMs?: number }): Promise<(LatestWalletScan & { result: unknown }) | null> {
  const now = params.now ?? Date.now()
  const maxAgeMs = params.maxAgeMs ?? walletScanReuseMaxAgeMs()
  const modes: WalletScanMode[] = params.scanMode === 'deep' ? ['deep'] : ['normal', 'deep']
  try {
    const pointers = await Promise.all(modes.map((mode) => kv.get<LatestWalletScan>(walletScanLatestKey(params.userId, params.wallet, mode))))
    const fresh = pointers
      .filter((p): p is LatestWalletScan => !!p && typeof p.jobId === 'string' && typeof p.completedAt === 'number' && now - p.completedAt <= maxAgeMs && p.completedAt <= now + 60_000)
      .sort((a, b) => b.completedAt - a.completedAt)
    for (const pointer of fresh) {
      const [job, result] = await Promise.all([
        kv.get<{ userId?: string; status?: string }>(walletScanJobKey(pointer.jobId)),
        kv.get<unknown>(walletScanResultKey(pointer.jobId)),
      ])
      if (job?.userId === params.userId && job.status === 'done' && result != null && isCompleteWalletScanResult(result)) return { ...pointer, result }
    }
    return null
  } catch {
    return null
  }
}

export type WatchlistRow = { user_id: string; address: string; saved_at?: string | null }

/** PURE. One entry per (user, wallet), newest-saved first, valid 0x addresses only. */
export function prescanCandidates(rows: readonly WatchlistRow[]): Array<{ userId: string; wallet: string }> {
  const seen = new Set<string>()
  const out: Array<{ userId: string; wallet: string }> = []
  for (const row of rows) {
    const wallet = typeof row.address === 'string' ? row.address.trim().toLowerCase() : ''
    if (!row.user_id || !/^0x[0-9a-f]{40}$/.test(wallet)) continue
    const key = `${row.user_id}:${wallet}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ userId: row.user_id, wallet })
  }
  return out
}
