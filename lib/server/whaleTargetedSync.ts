// TARGETED SYNC (FOMO + Add): one wallet the caller already tracks, scanned right away instead of
// waiting for its turn in the full rotation. Its own small limit — once per wallet per 30s per user —
// so it never resets or competes with the shared batch cooldown.
export const TARGETED_SYNC_COOLDOWN_MS = 30_000
const targetedSyncRate = new Map<string, number>()

export function targetedSyncAllowed(userId: string, wallet: string, now = Date.now()): { ok: boolean; retryAfterMs?: number } {
  const key = `${userId}:${wallet.toLowerCase()}`
  const last = targetedSyncRate.get(key)
  if (last != null && now - last < TARGETED_SYNC_COOLDOWN_MS) return { ok: false, retryAfterMs: TARGETED_SYNC_COOLDOWN_MS - (now - last) }
  if (targetedSyncRate.size > 5_000) targetedSyncRate.clear()
  targetedSyncRate.set(key, now)
  return { ok: true }
}
