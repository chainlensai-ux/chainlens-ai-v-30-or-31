// GET /api/wallet-scan/prescan — scheduled background scans of watchlisted wallets.
//
// Called on a schedule (Upstash QStash or Vercel Cron) with Authorization: Bearer <PRESCAN_SECRET or
// CRON_SECRET>. For each watchlisted (user, wallet) whose latest complete scan is older than
// PRESCAN_STALE_MINUTES, it queues the same full scan the Wallet Scanner runs, owned by that user — so
// when they open the wallet, the finished result is served at once (src/modules/walletScanLatest.ts).
// Nothing about the scan is reduced; it only runs earlier.
//
// Bounded: at most PRESCAN_MAX_JOBS scans per call (default 3), a wallet already being scanned is
// skipped (same in-flight slot a user's own scan uses, so the two can never run twice), and a call
// with no secret configured or a wrong one answers 404.
import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { confirmWalletScanInFlight, enqueueWalletScanJob, releaseWalletScanInFlight, reserveWalletScanInFlight, walletScanRedisConfigured } from '@/src/modules/walletScanQueue'
import { prescanCandidates, readReusableWalletScan, type WatchlistRow } from '@/src/modules/walletScanLatest'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'
import { markRobinhoodScanQueued, markRobinhoodScanEnqueueFailed } from '@/lib/server/robinhoodScanCoordinator'

export const runtime = 'nodejs'
export const preferredRegion = 'iad1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const notAvailable = () => new Response('Not available', { status: 404 })

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function secretMatches(given: string): boolean {
  for (const expected of [process.env.PRESCAN_SECRET, process.env.CRON_SECRET]) {
    if (!expected || !given) continue
    const a = Buffer.from(given)
    const b = Buffer.from(expected)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

export async function GET(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization') ?? ''
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : new URL(req.url).searchParams.get('secret') ?? ''
  if (!secretMatches(given)) return notAvailable()
  if (!walletScanRedisConfigured()) return NextResponse.json({ ok: false, error: 'queue_unavailable' }, { status: 503 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 })
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await db.from('watchlist_wallets').select('user_id, address, saved_at').order('saved_at', { ascending: false }).limit(500)
  if (error) return NextResponse.json({ ok: false, error: 'watchlist_read_failed' }, { status: 500 })

  const maxJobs = envInt('PRESCAN_MAX_JOBS', 3)
  const staleMs = envInt('PRESCAN_STALE_MINUTES', 60) * 60_000
  const robinhood = isRobinhoodChainAvailable()
  const queued: string[] = []
  const skipped = { fresh: 0, inFlight: 0, failed: 0 }

  for (const { userId, wallet } of prescanCandidates((data ?? []) as WatchlistRow[])) {
    if (queued.length >= maxJobs) break
    // Still fresh enough: the next open is already instant.
    if (await readReusableWalletScan({ userId, wallet, scanMode: 'normal', maxAgeMs: staleMs })) { skipped.fresh += 1; continue }
    const jobId = crypto.randomUUID()
    const reservation = await reserveWalletScanInFlight(userId, wallet, 'normal', jobId)
    if (reservation.kind !== 'owner') { skipped.inFlight += 1; continue }
    const confirmed = await confirmWalletScanInFlight(reservation)
    if (!confirmed) { skipped.inFlight += 1; continue }
    const queuedAt = Date.now()
    if (robinhood) await markRobinhoodScanQueued(wallet, jobId, queuedAt).catch(() => {})
    try {
      await enqueueWalletScanJob(jobId, { jobId, userId, walletAddress: wallet, chains: ['base', 'eth'], scanMode: 'normal', ip: 'prescan', includeRobinhoodRequested: robinhood })
      queued.push(jobId)
    } catch {
      skipped.failed += 1
      if (robinhood) await markRobinhoodScanEnqueueFailed(wallet, jobId, queuedAt).catch(() => {})
      await releaseWalletScanInFlight(confirmed)
    }
  }

  console.warn('[wallet-scan-prescan]', { candidates: (data ?? []).length, queued: queued.length, ...skipped, maxJobs, staleMinutes: staleMs / 60_000 })
  return NextResponse.json({ ok: true, queued: queued.length, skipped })
}
