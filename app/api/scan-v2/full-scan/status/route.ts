// GET /api/scan-v2/full-scan/status?jobId=... — poll a `normal`-mode job's status/result.
//
// DELEGATION, DISCLOSED: app/api/scan-status/route.ts's GET handler is already fully generic — it
// reads a ScanJob by id from the one shared job store (src/modules/scanJobs.ts) regardless of what
// scanMode the job was created with. Re-implementing the same jobId-lookup/response-shape logic
// here would be pure duplication for zero behavior difference, so this route re-exports that exact
// handler rather than copying it. Deep Scan's own polling (app/api/scan-status) is untouched.

export { GET } from '@/app/api/scan-status/route'
