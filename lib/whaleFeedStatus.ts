// HONEST-WHALE-FEED-STATUS, DISCLOSED: KPI unknown-vs-zero copy for Whale Alerts.
// Extracted from app/terminal/whale-alerts/page.tsx so the ~84k page only imports
// these helpers, and so "0 + Quiet this window" cannot ship as a first-paint lie
// before any scan/GET has measured empty.

export type WhaleKpiMode = 'checking' | 'not_scanned' | 'unavailable' | 'quiet' | 'ready'

export const WHALE_KPI_EM_DASH = '—'
export const WHALE_KPI_NOT_SCANNED = 'Not scanned yet'
export const WHALE_KPI_CHECKING = 'Checking…'
export const WHALE_KPI_UNAVAILABLE = 'Unavailable'

export type WhaleDiagnosticsLike = {
  rawRows?: number
} | null | undefined

export function whaleHasScanEvidence(args: {
  syncState: unknown
  alertCount: number
  diagnostics?: WhaleDiagnosticsLike
}): boolean {
  if (args.syncState) return true
  if (Number(args.alertCount) > 0) return true
  const raw = args.diagnostics?.rawRows
  // A successful GET that measured rows (even if later filtered to empty) is evidence
  // the feed has been scanned/read, not the initial unknown state.
  if (typeof raw === 'number' && raw > 0) return true
  return false
}

export type WhaleKpiTileResult = { display: string | number; sub: string; mode: WhaleKpiMode }

export function whaleKpiTile(args: {
  loading: boolean
  feedError: boolean
  hasScanEvidence: boolean
  feedSettled: boolean
  value: number | string
  zeroSub: string | null
  readySub: string
}): WhaleKpiTileResult {
  // Tracked-wallets tile is a fixed label, never a measured 0.
  if (typeof args.value === 'string') {
    return { display: args.value, sub: args.readySub, mode: 'ready' }
  }

  if (args.feedError && !args.hasScanEvidence) {
    return { display: WHALE_KPI_EM_DASH, sub: WHALE_KPI_UNAVAILABLE, mode: 'unavailable' }
  }
  if ((args.loading || !args.feedSettled) && !args.hasScanEvidence) {
    return { display: WHALE_KPI_EM_DASH, sub: WHALE_KPI_CHECKING, mode: 'checking' }
  }
  if (!args.hasScanEvidence) {
    return { display: WHALE_KPI_EM_DASH, sub: WHALE_KPI_NOT_SCANNED, mode: 'not_scanned' }
  }
  if (args.value === 0) {
    return { display: 0, sub: args.zeroSub ?? args.readySub, mode: 'quiet' }
  }
  return { display: args.value, sub: args.readySub, mode: 'ready' }
}
