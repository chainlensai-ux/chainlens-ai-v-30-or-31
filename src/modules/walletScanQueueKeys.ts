const WALLET_SCAN_PENDING_KEY = 'walletScanPendingJobs'

export function walletScanJobKey(jobId: string): string {
  return `walletScanJob:${jobId}`
}

export function walletScanResultKey(jobId: string): string {
  return `walletScanResult:${jobId}`
}

export function walletScanPendingJobKey(jobId: string): string {
  return `walletScanPending:${jobId}`
}

export function walletScanPendingKey(): string {
  return WALLET_SCAN_PENDING_KEY
}
