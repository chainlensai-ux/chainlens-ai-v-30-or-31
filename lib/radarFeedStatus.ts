// HONEST-RADAR-FEED-STATUS, DISCLOSED: empty-state / failed-refresh copy and tile mode for
// Base Radar. Extracted from app/terminal/base-radar/page.tsx so the 161k page only imports
// these helpers, and so they can be unit-tested without rewriting the page.

export type RadarFeedLike = {
  tokens?: unknown
} | null | undefined

export function radarHasVisibleFeed(data: RadarFeedLike): boolean {
  return Array.isArray(data?.tokens) && data.tokens.length > 0
}

export function radarErrorMessage(status: number, hasData: boolean): string {
  const suffix = hasData ? 'Showing last available read.' : 'Try refreshing or scanning a token directly.'
  if (status === 429) return `Radar is getting a lot of requests right now — please wait a moment. ${suffix}`
  if (status === 403) return `Radar needs Pro or Elite access. If you already have it, try reconnecting your account. ${suffix}`
  if (status === 504 || status === 408) return `The radar request timed out. ${suffix}`
  return `Radar refresh failed. ${suffix}`
}

export function radarTimeoutMessage(hasData: boolean): string {
  const suffix = hasData ? 'Showing last available read.' : 'Try refreshing or scanning a token directly.'
  return `The radar request timed out. ${suffix}`
}

function readAudit(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null
  const audit = (payload as any).baseRadarLoadAudit
  if (!audit || typeof audit !== 'object') return null
  return audit
}

function readProviderSources(audit: any) {
  if (!audit || !Array.isArray(audit.providerErrors)) return []
  const names = []
  for (const entry of audit.providerErrors) {
    const source = entry && entry.source
    if (typeof source === 'string' && source.trim()) names.push(source.trim())
  }
  return names
}

export function radarVisibleErrorFromPayload(payload: unknown, status: number, hasData: boolean): string {
  const audit = readAudit(payload)
  if (audit && typeof audit.userVisibleError === 'string' && audit.userVisibleError.trim()) {
    return audit.userVisibleError.trim()
  }
  if (status === 504 || status === 408) return radarTimeoutMessage(hasData)
  const sources = readProviderSources(audit)
  if (sources.length > 0) {
    const suffix = hasData ? 'Showing last available read.' : 'Try refreshing or scanning a token directly.'
    return `Radar refresh failed (${sources.join(', ')}). ${suffix}`
  }
  return radarErrorMessage(status, hasData)
}

export type RadarStatTileMode = 'checking' | 'unavailable' | 'ready'

export function radarStatTileMode(args: {
  loading: boolean
  hasData: boolean
  error: string | null | undefined
}): RadarStatTileMode {
  if (args.hasData) return 'ready'
  if (args.error) return 'unavailable'
  if (args.loading) return 'checking'
  return 'unavailable'
}
