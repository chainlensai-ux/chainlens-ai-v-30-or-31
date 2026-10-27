// EARLY BUYERS — POST /api/token/early-buyers request handler.
//
// Same flow as before (auth → stored evidence → free cached-only → paid reservation → analysis →
// settle). This module adds a server-side request id, diagnostic headers and exactly one structured
// log line per request, including 400/401/429/500 outcomes. Dependencies are injectable for tests;
// the route passes none.

import { NextResponse } from 'next/server'
import { requireAuthenticatedUser, unauthorizedResponse } from '../requireAuth'
import { analyzeEarlyBuyers, type EarlyBuyerDiagnostics } from './analyze'
import { readEarlyBuyerEvidenceWithSource } from './store'
import { reserveEarlyBuyerAnalysis } from './limits'
import { EarlyBuyerRpcError } from './rpc'
import { logEarlyBuyerRequest, newEarlyBuyerRequestId, withEarlyBuyerDiagnostics, type EarlyBuyerRequestLog, type EarlyBuyerRequestSource } from './requestLog'
import { EARLY_BUYER_WINDOW_SCOPE, type EarlyBuyerChain, type EarlyBuyerIntel } from './types'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const NO_STORE = { 'Cache-Control': 'no-store' }

export type EarlyBuyersHandlerDeps = {
  authenticate: typeof requireAuthenticatedUser
  analyze: typeof analyzeEarlyBuyers
  readEvidence: typeof readEarlyBuyerEvidenceWithSource
  reserve: typeof reserveEarlyBuyerAnalysis
  log: (line: string) => void
  now: () => number
  sharedWaitMs: number
  sharedPollMs: number
}

const defaults: EarlyBuyersHandlerDeps = {
  authenticate: requireAuthenticatedUser,
  analyze: analyzeEarlyBuyers,
  readEvidence: readEarlyBuyerEvidenceWithSource,
  reserve: reserveEarlyBuyerAnalysis,
  log: (line) => console.info(line),
  now: () => Date.now(),
  sharedWaitMs: 24_000,
  sharedPollMs: 800,
}

export async function handleEarlyBuyersRequest(request: Request, overrides: Partial<EarlyBuyersHandlerDeps> = {}): Promise<Response> {
  const deps = { ...defaults, ...overrides }
  const startedAt = deps.now()
  const requestId = newEarlyBuyerRequestId()
  const entry: EarlyBuyerRequestLog = { requestId, status: 500, source: 'error', durationMs: 0, access: 'anonymous' }
  const diagnostics: EarlyBuyerDiagnostics = {}
  const finish = <R extends Response>(response: R, source: EarlyBuyerRequestSource, intel?: EarlyBuyerIntel | null): R => {
    entry.status = response.status
    entry.source = source
    entry.intel = intel ?? null
    entry.holdingsSource = diagnostics.holdingsSource ?? null
    entry.durationMs = Math.max(0, deps.now() - startedAt)
    return withEarlyBuyerDiagnostics(response, entry)
  }
  const respond = (intel: EarlyBuyerIntel, source: EarlyBuyerRequestSource) => finish(NextResponse.json({ earlyBuyerIntel: intel }, { headers: NO_STORE }), source, intel)
  const storedSource = (): EarlyBuyerRequestSource => diagnostics.evidenceSource ?? 'none'

  try {
    const user = await deps.authenticate(request)
    if (!user) return finish(unauthorizedResponse(), 'unauthorized')
    entry.access = user.plan === 'free' ? 'free' : 'paid'
    let body: { chain?: unknown; contract?: unknown }
    try { body = await request.json() as typeof body } catch { return finish(NextResponse.json({ error: 'invalid_json' }, { status: 400 }), 'invalid_request') }
    entry.chain = typeof body.chain === 'string' ? body.chain : null
    if (body.chain !== 'base' && body.chain !== 'eth') {
      const intel: EarlyBuyerIntel = { status: 'unsupported_chain', launch: { status: 'unavailable', block: null, pool: null, creationTx: null, liquidityTx: null }, window: { startBlock: null, endBlock: null, pools: [], buysObserved: 0 }, buyers: [], groups: [], sameBlockCount: 0, launchDistributions: [], coverage: { capped: false, reasons: ['base_and_ethereum_only'], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE }, budget: { calls: 0, cu: 0 } }
      return respond(intel, 'unsupported_chain')
    }
    if (typeof body.contract !== 'string' || !ADDRESS.test(body.contract)) return finish(NextResponse.json({ error: 'invalid_contract' }, { status: 400 }), 'invalid_request')
    const chain = body.chain as EarlyBuyerChain
    const token = body.contract.toLowerCase()
    entry.token = token
    const cached = await deps.readEvidence(chain, token)
    if (cached) {
      const intel = await deps.analyze(chain, token, { cachedOnly: true, refreshHoldings: user.plan !== 'free', diagnostics })
      return respond(intel, storedSource())
    }
    if (user.plan === 'free') {
      const intel = await deps.analyze(chain, token, { cachedOnly: true, diagnostics })
      return respond(intel, storedSource())
    }
    const reservation = await deps.reserve(user.userId, user.plan, chain, token)
    if (!reservation.allowed) {
      entry.rejection = reservation.reason
      if (reservation.reason === 'token_in_progress') {
        const until = deps.now() + deps.sharedWaitMs
        while (deps.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, deps.sharedPollMs))
          const shared = await deps.readEvidence(chain, token)
          if (shared) return respond(shared.intel, `shared_wait_${shared.source}`)
        }
      }
      return finish(NextResponse.json({ error: reservation.reason }, { status: 429, headers: NO_STORE }), 'quota_rejected')
    }
    let cu = 2_000
    try {
      const intel = await deps.analyze(chain, token, { diagnostics })
      cu = intel.budget.cu
      return respond(intel, storedSource())
    } finally {
      await reservation.settle(cu)
    }
  } catch (error) {
    // Only a code is logged: provider error messages can contain RPC URLs with API keys.
    entry.errorCode = error instanceof EarlyBuyerRpcError ? error.reason : 'unexpected_error'
    return finish(NextResponse.json({ error: 'early_buyers_failed' }, { status: 500, headers: NO_STORE }), 'error')
  } finally {
    logEarlyBuyerRequest(entry, deps.log)
  }
}
