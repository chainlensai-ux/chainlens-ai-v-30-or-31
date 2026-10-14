// The whale cron runs once a day with a small time budget (one or two 10-wallet batches), and it
// previously always started at offset 0 — so the same first wallets were scanned every day and the
// rest of the system set never was. Rotating the start by UTC day spreads coverage over the whole
// set without any persisted cursor (the cron has no state store).

const DAY_MS = 24 * 60 * 60 * 1000

/** Wallets the cron expects to cover per run; the rotation advances by this much each day. */
export const CRON_WALLETS_PER_RUN = 20

export function cronRotationStart(nowMs: number, totalWallets: number, walletsPerRun = CRON_WALLETS_PER_RUN): number {
  if (!Number.isFinite(totalWallets) || totalWallets <= 0) return 0
  const day = Math.floor(nowMs / DAY_MS)
  return (day * Math.max(1, walletsPerRun)) % totalWallets
}

/**
 * Next offset after a batch ending at `nextOffset` (null when the batch reached the end of the
 * list). Wraps once to 0 when the run started mid-list, and returns null when the run has come back
 * around to its start (every wallet covered) — never revisits a wallet within one run.
 */
export function cronNextOffset(start: number, nextOffset: number | null, wrapped: boolean): { offset: number; wrapped: boolean } | null {
  if (nextOffset == null) {
    if (wrapped || start === 0) return null
    return { offset: 0, wrapped: true }
  }
  if (wrapped && nextOffset >= start) return null
  return { offset: nextOffset, wrapped }
}
