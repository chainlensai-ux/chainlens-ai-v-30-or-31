export type JobErrorShape = { message: string; category: string; details?: string[] }

export type FullScanJobResult =
  | { status: 'pending' }
  | { status: 'done'; success: true; data: unknown }
  | { status: 'done'; success: false; error: JobErrorShape }

/** Shared by the start and status handlers; not exported from a route module. */
export function fullScanJobKey(jobId: string): string {
  return `v2:full-scan-job:${jobId}`
}
