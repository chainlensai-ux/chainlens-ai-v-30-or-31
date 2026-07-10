// GET /api/scan-health — 3-layer health check for the scan pipeline: liveness (is the worker route
// reachable), trigger delivery (does a QStash-published job actually reach the worker), and a
// minimal end-to-end pipeline run (does a noop job reach 'completed' via GET /api/scan-status).
// Diagnostic-only — never touches a real scan job, never runs runWalletScanV2Worker, never affects
// app/api/scan-start's request path.
//
// SELF-CONTAINED QSTASH CLIENT, DISCLOSED: constructs its own QStash client here rather than
// reusing src/modules/scanJobCreation.ts's internal (unexported) getQstashClient()/
// sanitizeEnvValue(). Deliberate: this endpoint exists to independently verify the real trigger
// path works, so it shouldn't share a bug in that path's own client construction — the same
// env-value whitespace/quote sanitization is duplicated here for the same reason it was added
// there (a very common real cause of "invalid token" from a dashboard-pasted secret).

import { NextResponse } from 'next/server'
import { Client as QStashClient } from '@upstash/qstash'
import { getScanJob } from '@/src/modules/scanJobs'

export const maxDuration = 30

function resolveBaseUrl(): string {
  const endpoint = process.env.WORKER_ENDPOINT
  if (endpoint) return endpoint
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3000'
}

function sanitizeEnvValue(value: string | undefined | null): string | undefined {
  if (value == null) return undefined
  let v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim()
  }
  return v.length > 0 ? v : undefined
}

function getHealthQstashClient(): QStashClient | null {
  const token = sanitizeEnvValue(process.env.QSTASH_TOKEN)
  if (!token) return null
  const baseUrl = sanitizeEnvValue(process.env.QSTASH_URL)
  try {
    return new QStashClient({ token, ...(baseUrl != null ? { baseUrl } : {}) })
  } catch (err) {
    console.error('[scan-health] QStash client construction failed', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function checkLiveness(workerUrl: string): Promise<boolean> {
  try {
    const res = await fetch(workerUrl, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return false
    const json = (await res.json().catch(() => null)) as { ok?: boolean } | null
    return json?.ok === true
  } catch (err) {
    console.error('[scan-health] liveness check failed', err instanceof Error ? err.message : String(err))
    return false
  }
}

// Trigger check: polls the job store directly (this route holds no HTTP connection to wait on —
// QStash, not this request, is the one that calls the worker) for the marker the worker's
// test===true short-circuit writes on receipt.
async function pollTriggerReceived(jobId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await getScanJob(jobId)
    if (job && job.status === 'completed' && job.result === 'trigger-check-ok') return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

// Pipeline check: polls the REAL GET /api/scan-status route (not the job store directly) so this
// check exercises the same path a real client polling a scan would use.
async function pollScanStatusUntilOk(baseUrl: string, jobId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/scan-status?jobId=${encodeURIComponent(jobId)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      })
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { status?: string; result?: unknown } | null
        if (json?.status === 'completed' && json.result === 'ok') return true
      }
    } catch (err) {
      console.error('[scan-health] pipeline-check poll failed', err instanceof Error ? err.message : String(err))
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

export async function GET(): Promise<Response> {
  const baseUrl = resolveBaseUrl()
  const workerUrl = `${baseUrl}/api/scan-v2/worker`
  const timestamp = Date.now()

  const workerReachable = await checkLiveness(workerUrl)

  let qstashPublish = false
  let workerReceivesJobs = false
  let pipelineComplete = false

  const client = getHealthQstashClient()
  if (!client) {
    console.warn('[scan-health] QSTASH_TOKEN not configured — skipping trigger-check and pipeline-check; workerReachable is still meaningful')
  } else {
    // LAYER 2: TRIGGER CHECK
    const triggerJobId = `health-trigger-${crypto.randomUUID()}`
    try {
      await client.publishJSON({ url: workerUrl, body: { jobId: triggerJobId, test: true } })
      qstashPublish = true
    } catch (err) {
      console.error('[scan-health] trigger-check publish failed', err instanceof Error ? err.message : String(err))
    }
    if (qstashPublish) {
      workerReceivesJobs = await pollTriggerReceived(triggerJobId, 10_000)
    }

    // LAYER 3: PIPELINE CHECK
    const pipelineJobId = `health-pipeline-${crypto.randomUUID()}`
    try {
      await client.publishJSON({ url: workerUrl, body: { jobId: pipelineJobId, wallet: 'health-check', mode: 'noop' } })
      pipelineComplete = await pollScanStatusUntilOk(baseUrl, pipelineJobId, 15_000)
    } catch (err) {
      console.error('[scan-health] pipeline-check publish failed', err instanceof Error ? err.message : String(err))
    }
  }

  return NextResponse.json({
    workerReachable,
    qstashPublish,
    workerReceivesJobs,
    pipelineComplete,
    timestamp,
  })
}
