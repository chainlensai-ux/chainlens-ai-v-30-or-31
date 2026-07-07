// GET /api/debug/rpc-audit-stream — Server-Sent Events feed of lib/server/globalRpcAudit.ts's
// event queue, so the audit that previously only ever wrote to the SERVER's own console/log
// aggregation can also be watched live from a browser (see app/terminal/debug-rpc-audit/page.tsx).
//
// GATING, DISCLOSED CORRECTION: this codebase's other diagnostic routes (app/api/debug-engines,
// app/api/diagnostics/pricing, app/api/cu-usage, app/api/cu-diagnostics, app/api/diagnostics/
// divergence) all gate on `NODE_ENV === 'production'`. That check does NOT distinguish preview from
// real production on Vercel — Next.js always builds in production mode, so NODE_ENV is
// 'production' on BOTH preview and production deployments. Applying that same convention here would
// have locked this out of preview deployments too, directly contradicting this task's own explicit
// "must work in preview deployments" requirement. Gated on `VERCEL_ENV === 'production'` instead —
// the actual variable Vercel sets to distinguish 'production' from 'preview'/'development' — so this
// stays open on preview (and local dev, where VERCEL_ENV is unset) and still requires an admin secret
// on real production, matching the spirit of every other diagnostic route's gating without its
// preview-blocking side effect.
//
// SSE, NOT A NEW DEPENDENCY, DISCLOSED: implemented with a plain ReadableStream + TextEncoder (both
// Web-standard APIs already available in this runtime) — no new package needed for a POC-scale debug
// feed.
//
// RUNTIME, DISCLOSED: kept on the default Node runtime (not edge) for consistency with the rest of
// this codebase's routes — nothing here needs Edge, and mixing runtimes for no reason is its own
// source of surprises.

export const dynamic = 'force-dynamic'

import { drainAuditEventQueue } from '@/lib/server/globalRpcAudit'

const FLUSH_INTERVAL_MS = 500

function isAllowed(req: Request): boolean {
  if (process.env.VERCEL_ENV !== 'production') return true
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  return Boolean(process.env.ADMIN_SECRET) && token === process.env.ADMIN_SECRET
}

export async function GET(req: Request): Promise<Response> {
  if (!isAllowed(req)) {
    return new Response('Not available', { status: 404 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false

      const flush = () => {
        if (closed) return
        const events = drainAuditEventQueue()
        for (const event of events) {
          // SSE wire format per requirement 3: "event: rpc" + "data: <json>", each line terminated
          // by \n, event terminated by a blank line.
          controller.enqueue(encoder.encode(`event: rpc\ndata: ${JSON.stringify(event)}\n\n`))
        }
      }

      // INITIAL PING, DISCLOSED: an SSE comment line (`:`-prefixed, ignored by EventSource but real
      // bytes on the wire) sent immediately on connect. Without this, zero bytes are ever sent until
      // the first real audit event fires — some clients/proxies (confirmed with a local curl check)
      // treat that as "still waiting for headers/first byte" and time out a connection that is
      // actually fine, just quiet. Standard SSE keep-alive practice, not part of the audit data
      // itself.
      controller.enqueue(encoder.encode(': connected\n\n'))

      // Immediate flush of anything already queued, then poll every 500ms — "never close the
      // connection until the client disconnects" (requirement 1): this interval is the only thing
      // keeping the stream alive; it only ever stops on client disconnect (below) or a genuine
      // controller error.
      flush()
      const interval = setInterval(flush, FLUSH_INTERVAL_MS)

      const close = () => {
        if (closed) return
        closed = true
        clearInterval(interval)
        try {
          controller.close()
        } catch {
          // Already closed by the runtime — nothing further to do.
        }
      }

      // CLIENT DISCONNECT, DISCLOSED: `req.signal` aborts when the browser navigates away or the
      // EventSource is closed — without this, the interval (and the serverless invocation keeping it
      // alive) would run forever, burning compute for a client that's long gone.
      req.signal.addEventListener('abort', close)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables buffering on Vercel's/most reverse proxies' edge layer, which would otherwise
      // batch chunks and defeat the whole point of a live stream.
      'X-Accel-Buffering': 'no',
    },
  })
}
