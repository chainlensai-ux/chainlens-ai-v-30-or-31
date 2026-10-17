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

/** NX lock: exactly one worker invocation may claim and run a job. */
export function walletScanClaimLockKey(jobId: string): string {
  return `walletScanClaim:${jobId}`
}

/** The one live job per (user, wallet, scan mode); a repeat scan joins it instead of starting another. */
export function walletScanInFlightKey(userId: string, wallet: string, scanMode: 'normal' | 'deep'): string {
  return `walletScanInFlight:${userId}:${wallet.toLowerCase()}:${scanMode}`
}

/** Worker liveness (heartbeat + stage progress), kept off the job record so it can never overwrite it. */
export function walletScanJobLiveKey(jobId: string): string {
  return `walletScanJobLive:${jobId}`
}
