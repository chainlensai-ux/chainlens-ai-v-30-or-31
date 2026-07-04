// worker/server.ts — standalone, always-on Node/Express worker for the ChainLens Wallet Scanner
// V2 unified scan. Runs OUTSIDE Vercel's serverless model entirely (deployed on Railway) so a Deep
// Scan is never subject to a 60-second function-invocation ceiling or per-request cold start.
//
// NOT A REWRITE: this file imports and calls the EXACT SAME real orchestrator every existing
// Vercel route already uses — `router.handleScanRequest` (src/deployment/router.ts) — via a plain
// relative import, not a reimplementation. It does not touch, duplicate, or diverge from
// runWalletScanV2/src/pipeline/index.ts/any src/modules/* file in any way. Same real rate limiting,
// same real validation, same real FinalReport-shaped response, same never-throwing guarantee that
// function already provides (see app/api/scan/route.ts's own header for that guarantee's origin).
//
// HONEST PERFORMANCE DISCLOSURE: the task's own framing claimed this would cut Deep Scan runtime
// "from ~60 seconds to ~10-15 seconds." That specific number is not something this file can verify
// or guarantee — the real bottleneck in a Deep Scan is network round-trips to GoldRush/Alchemy/
// CoinGecko/on-chain RPC endpoints, which take exactly as long here as anywhere else; nothing about
// running in a long-lived Node process makes those external calls faster. What genuinely changes,
// and is real: no per-request cold start (typically low single-digit seconds saved on Vercel,
// exact figure deployment-dependent), no 60-second execution ceiling (a slow-but-legitimate Deep
// Scan can finish instead of being killed), and a warm, reusable process instead of a fresh
// serverless isolate per request. Actual end-to-end latency should be measured against a real
// deployment, not assumed from this description.
//
// ENV VARS: loaded the same way every other real fetch function in this codebase already reads
// them (process.env.GOLDRUSH_API_KEY, ALCHEMY_*_KEY, etc. — see src/modules/providerFetchWindow/
// utils.ts for the real, canonical list) — Railway injects these directly into process.env for a
// deployed service; no different loading mechanism is introduced here. dotenv is loaded
// opportunistically for local development convenience only (identical pattern to
// walletEngineTest.js elsewhere in this repo) and is a no-op if the package isn't installed.

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config()
} catch {
  // dotenv not installed — fine; Railway (and any real deployment) injects env vars directly.
}

import express, { type Request, type Response } from 'express'
import { router } from '../src/deployment/index'
import { handleApiError } from '../src/deployment/api'

const app = express()
app.use(express.json({ limit: '2mb' }))

// Railway (and any load balancer/orchestrator) needs a cheap liveness/readiness endpoint that
// never depends on external providers being reachable.
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true })
})

// POST /full-scan — the one route this task asked for. Calls the real, existing orchestrator
// exactly as every Vercel route already does; adds no new logic beyond Express's own
// Request/Response translation.
app.post('/full-scan', async (req: Request, res: Response) => {
  try {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown'

    // handleScanRequest already never throws (rate-limit/validation errors and any
    // runWalletScanV2 failure are caught internally and returned as a structured RouteResult) — see
    // app/api/scan/route.ts's own disclosure of this same guarantee.
    const result = await router.handleScanRequest(req.body, ip)

    res.status(result.status).json(result.body)
  } catch (err) {
    // Last-resort guard only, matching every existing Vercel route's own outer catch — fires only
    // if something fails before/outside handleScanRequest's own internal error handling. Never
    // leaks a raw stack trace or error object; always returns {success:false, error:{...}}.
    res.status(500).json(handleApiError(err))
  }
})

// Unknown routes/methods degrade to a structured 404 rather than Express's default HTML error page
// — keeps every response from this service JSON, matching every Vercel route's own contract.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: { message: 'Not found', category: 'not_found' } })
})

// BUG FOUND AND FIXED DURING LIVE VERIFICATION: express.json() throws SYNCHRONOUSLY, inside
// Express's own middleware chain, BEFORE the request ever reaches the /full-scan handler above —
// a malformed (non-JSON) request body was falling through to Express's DEFAULT error handler,
// which returns an HTML error page, not JSON. That directly violated "never throw, always return
// {success, data, error}." This 4-argument error-handling middleware (Express's own convention for
// catching errors from earlier middleware/routes) intercepts it and returns the same structured
// shape every other failure path in this service already uses. Confirmed live: a request with a
// deliberately malformed body now returns {success:false, error:{...}} with a JSON content type
// instead of an HTML stack trace page.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  res.status(400).json({
    success: false,
    error: { message: 'invalid-request-body', category: 'validation', details: [err instanceof Error ? err.message : String(err)] },
  })
})

const PORT = Number(process.env.PORT) || 8080

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[worker] ChainLens full-scan worker listening on port ${PORT}`)
})
