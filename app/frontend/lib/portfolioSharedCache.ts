// Shared, session-scoped cache bridging Wallet Scanner's completed scan result into Portfolio —
// per the audit's explicit requirement: "If Wallet Scanner cached result exists for same wallet,
// Portfolio can use it immediately." Wallet Scanner keeps its scan result in plain React state
// only (no cross-page store existed before this), so a Portfolio-page visit right after a Wallet
// Scanner scan had no way to see it at all. sessionStorage is the right tool here — it survives
// client-side navigation within the tab (a real `<Link>`/router.push between /terminal/wallet-
// scanner and /terminal/portfolio never reloads the page), is per-tab/per-origin (never leaks
// across users or devices), and needs no new backend/DB table for what is genuinely just a UX
// hand-off, not durable data.
'use client'

import type { WalletV2Report } from '@/app/terminal/wallet-scanner/page'
import type { RobinhoodWalletScanResponse } from '@/lib/walletScan/canonicalWalletSelectors'

const STORAGE_PREFIX = 'cl_portfolio_scan_cache:'
const FRESH_MS = 15 * 60 * 1000 // 15 minutes — long enough for a normal page hop, short enough to never show a stale total as if it were live

type CachedEntry = {
  report: WalletV2Report
  robinhoodResult: RobinhoodWalletScanResponse | null
  cachedAt: number
}

function key(address: string): string {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`
}

export function savePortfolioScanResult(address: string, report: WalletV2Report, robinhoodResult: RobinhoodWalletScanResponse | null): void {
  if (!address) return
  try {
    const entry: CachedEntry = { report, robinhoodResult, cachedAt: Date.now() }
    window.sessionStorage.setItem(key(address), JSON.stringify(entry))
  } catch {
    // sessionStorage can throw (private browsing, quota) — this is a best-effort UX hand-off, not
    // a source of truth, so a write failure is silently ignored rather than surfaced as an error.
  }
}

export function readPortfolioScanResult(address: string, maxAgeMs: number = FRESH_MS): CachedEntry | null {
  if (!address) return null
  try {
    const raw = window.sessionStorage.getItem(key(address))
    if (!raw) return null
    const entry = JSON.parse(raw) as CachedEntry
    if (!entry || typeof entry.cachedAt !== 'number') return null
    if (Date.now() - entry.cachedAt > maxAgeMs) return null
    return entry
  } catch {
    return null
  }
}

export function clearPortfolioScanResult(address: string): void {
  if (!address) return
  try {
    window.sessionStorage.removeItem(key(address))
  } catch {
    // best-effort — see savePortfolioScanResult's own note.
  }
}
