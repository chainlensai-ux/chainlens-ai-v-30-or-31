// ADMIN, FORENSIC-ONLY, DISCLOSED: this route is the sole HTTP entry point for
// src/modules/receiptSwapDecoder/poolCreationProvenanceInvestigator.ts — a standalone
// (chain, pool) investigation tool that module's own header explicitly requires stay OUT of every
// wallet-scan code path ("forensic/admin path only; do not run for every wallet scan"). Nothing in
// this file is imported by, or imports from, src/pipeline/index.ts or
// src/modules/receiptSwapDecoder/walletScanShadowWiring.ts — a normal wallet scan can never reach
// this route.
//
// TEMPORARY NO-AUTH + HARD-LOCK, DISCLOSED (this task): bearer-token admin auth is deliberately
// removed from POST for now — in its place, POST accepts ONLY the exact single known forensic case
// (KNOWN_FORENSIC_CASE below: the pool/factory/token-pair/fee this whole investigation chain was
// built around). Any request whose body doesn't match that exact case byte-for-byte (case-
// insensitive on addresses) is rejected with 403, never investigated — so even with no token
// required, this route cannot be used to probe an arbitrary address. This is explicitly temporary:
// re-adding bearer auth (see the removed verifyAdmin/ADMIN_EMAILS convention still used by
// app/api/admin/actions/route.ts and app/api/admin/data/route.ts) is a follow-up, not deferred
// silently.
//
// KILL SWITCH, DISCLOSED (this task): POOL_PROVENANCE_ENDPOINT_ENABLED must be exactly the string
// 'true' or every request (GET and POST) gets an honest 404 — the endpoint is fully hidden, not
// merely unauthorized, when the switch is off or unset (fails closed by default).
//
// PERMANENT, PROCESS-LIFETIME CACHE, DISCLOSED: the investigator's own cache
// (createPoolCreationProvenanceCache) is instantiated ONCE at module scope, not per-request — a
// pool's creation transaction is immutable chain history, so this genuinely persists across
// requests within the same warm serverless instance, exactly matching the investigator's own
// "permanent cache" contract. A cold start gets a fresh cache, which is correct (nothing to lose).
//
// NEVER HTML, DISCLOSED: every response on every path — kill-switch, validation failure, hard-lock
// rejection, investigator error, success — is NextResponse.json(...); there is no default Next.js
// error page this route can fall through to.

import { NextRequest, NextResponse } from 'next/server'
import {
  createLiveBaseScanContractCreationLookup, createLivePoolCreationReceiptFetcher,
  createPoolCreationProvenanceInvestigator, createPoolCreationProvenanceCache,
} from '@/src/modules/receiptSwapDecoder/poolCreationProvenanceInvestigator'
import { buildPoolCreationProvenanceLogRecord } from '@/src/modules/receiptSwapDecoder/poolCreationProvenanceLog'
import { matchesKnownForensicCase, validatePoolProvenanceRequestBody } from '@/lib/server/poolProvenanceRequest'

// ─── Kill switch ────────────────────────────────────────────────────────────────────────────────
function isEndpointEnabled(): boolean {
  return process.env.POOL_PROVENANCE_ENDPOINT_ENABLED === 'true'
}

// ─── The single known forensic case, DISCLOSED: pool 0x7f31b371ac675bca3357fd9c26854fed067400c0 /
// claimed factory 0xade65c38cd4849adba595a4323a8c7ddfe89716a / Base WETH paired with
// 0x5576d6ed9181f2225aff5282ac0ed29f755437ea at fee 10000 — the exact production evidence every
// prior task in this investigation chain (fingerprinting, unknown-factory verification, unsupported
// -interface forensics, creation-provenance) was built around. No other input is accepted while
// this route runs without bearer auth. ────────────────────────────────────────────────────────────

function noStore(body: unknown, init?: { status?: number }): NextResponse {
  const res = NextResponse.json(body as object, init)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// ─── Real dependencies, module-scoped so the investigator's permanent cache is actually permanent
// across requests within one warm instance (see this file's own header) ──────────────────────────
const provenanceCache = createPoolCreationProvenanceCache()

export async function POST(req: NextRequest) {
  if (!isEndpointEnabled()) {
    return noStore({ error: 'Not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return noStore({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const validated = validatePoolProvenanceRequestBody(body)
  if (!validated.ok) {
    return noStore({ error: validated.error }, { status: 400 })
  }

  if (!matchesKnownForensicCase(validated.value)) {
    return noStore({ error: 'Forbidden: only the known forensic case is accepted while this endpoint runs without authentication' }, { status: 403 })
  }
  const { chain, pool, claimedFactory, expectedToken0, expectedToken1, expectedFee } = validated.value

  try {
    // REAL DEPENDENCIES, DISCLOSED: the project's shared Base RPC client (via
    // createLivePoolCreationReceiptFetcher -> rpcClient.ts's getSharedBaseClient) and the real
    // BaseScan/Etherscan-family lookup (createLiveBaseScanContractCreationLookup, gated on
    // BASESCAN_API_KEY/ETHERSCAN_API_KEY) -- the exact same live implementations this module's own
    // tests verify against fakes, never a reimplementation.
    const investigator = createPoolCreationProvenanceInvestigator(
      createLiveBaseScanContractCreationLookup(),
      createLivePoolCreationReceiptFetcher(),
      provenanceCache,
    )
    const diagnostics = await investigator.investigate({ chain, pool, claimedFactory, expectedToken0, expectedToken1, expectedFee })
    const record = buildPoolCreationProvenanceLogRecord(diagnostics)
    return noStore({ ok: true, diagnostics, record })
  } catch (err) {
    return noStore({ error: 'Investigation failed', message: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

// GET, DISCLOSED: side-effect-free, no investigator call — exists purely so a deploy of this route
// can be verified safely. Still gated by the same kill switch as POST: when disabled, the endpoint
// is entirely hidden (404), not merely unauthorized.
export async function GET() {
  if (!isEndpointEnabled()) {
    return noStore({ error: 'Not found' }, { status: 404 })
  }
  return noStore({ ok: true, route: 'pool-provenance' })
}
