// How much history a wallet scan actually read. A busy wallet's deep scan can cover only the last few
// days of its configured window, so the earliest activity found is the start of the scan, not the
// wallet's real first transaction.
export type ScanWindowSource = {
  windowCoverage?: { realDataDays?: number | null } | null
  scanMetadata?: { provider_fetch_window_days?: number | null; scanMode?: string | null } | null
}

export type ScanWindow = {
  /** Days of history the scan read; null when the report doesn't say. */
  windowDays: number | null
  /** True when the scan read less than its configured window (history was cut short). */
  narrowed: boolean
  deepScan: boolean
}

export function selectScanWindow(report: ScanWindowSource | null | undefined): ScanWindow {
  const realDays = report?.windowCoverage?.realDataDays
  const configuredDays = report?.scanMetadata?.provider_fetch_window_days
  const windowDays = typeof realDays === 'number' && Number.isFinite(realDays) && realDays > 0 ? realDays : null
  const narrowed = windowDays != null && typeof configuredDays === 'number' && Number.isFinite(configuredDays) && windowDays < configuredDays
  return { windowDays, narrowed, deepScan: report?.scanMetadata?.scanMode === 'deep' }
}
