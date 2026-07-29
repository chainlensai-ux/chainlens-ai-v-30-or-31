// ADMIN, FORENSIC-ONLY, DISCLOSED: this route is the sole HTTP entry point for
// src/modules/receiptSwapDecoder/poolCreationProvenanceInvestigator.ts — a standalone
// (chain, pool) investigation tool that module's own header explicitly requires stay OUT of every
// wallet-scan code path ("forensic/admin path only; do not run for every wallet scan"). Nothing in
// this file is imported by, or imports from, src/pipeline/index.ts or
// src/modules/receiptSwapDecoder/walletScanShadowWiring.ts — a normal wallet scan can never reach
// this route.
//
// AUTH, DISCLOSED: same admin-gate convention as app/api/admin/actions/route.ts /
// app/api/admin/data/route.ts — a Supabase-issued bearer token whose user email is in the
// ADMIN_EMAILS allowlist. No new auth mechanism introduced.
//
// PERMANENT, PROCESS-LIFETIME CACHE, DISCLOSED: the investigator's own cache
// (createPoolCreationProvenanceCache) is instantiated ONCE at module scope, not per-request — a
// pool's creation transaction is immutable chain history, so this genuinely persists across
// requests within the same warm serverless instance, exactly matching the investigator's own
// "permanent cache" contract. A cold start gets a fresh cache, which is correct (nothing to lose).
//
// NEVER HTML, DISCLOSED: every response on every path — success, validation failure, auth failure,
// investigator error — is NextResponse.json(...); there is no default Next.js error page this route
// can fall through to.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  createLiveBaseScanContractCreationLookup, createLivePoolCreationReceiptFetcher,
  createPoolCreationProvenanceInvestigator, createPoolCreationProvenanceCache,
} from '@/src/modules/receiptSwapDecoder/poolCreationProvenanceInvestigator'
import { buildPoolCreationProvenanceLogRecord } from '@/src/modules/receiptSwapDecoder/poolCreationProvenanceLog'

// ─── Admin access list (same convention as app/api/admin/actions/route.ts) ────────────────────────
function getAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS
  if (raw) return new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
  return new Set()
}
const ADMIN_EMAILS = getAdminEmails()

function makeAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function verifyAdmin(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return null

  const anon = makeAnonClient()
  if (!anon) return null

  try {
    const { data } = await anon.auth.getUser(token)
    const email = (data.user?.email ?? '').toLowerCase()
    if (!email || !ADMIN_EMAILS.has(email)) return null
    return email
  } catch {
    return null
  }
}

// ─── Request validation ─────────────────────────────────────────────────────────────────────────
export type PoolProvenanceRequestBody = {
  chain: 'base'
  pool: string
  claimedFactory: string
  expectedToken0: string
  expectedToken1: string
  expectedFee: number
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// PURE, DISCLOSED: no I/O — directly unit-testable independent of NextRequest/auth/the investigator.
export function validatePoolProvenanceRequestBody(body: unknown): { ok: true; value: PoolProvenanceRequestBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid JSON body' }
  const { chain, pool, claimedFactory, expectedToken0, expectedToken1, expectedFee } = body as Record<string, unknown>

  if (chain !== 'base') return { ok: false, error: 'chain must be "base"' }
  if (typeof pool !== 'string' || !ADDRESS_RE.test(pool)) return { ok: false, error: 'pool must be a valid address' }
  if (typeof claimedFactory !== 'string' || !ADDRESS_RE.test(claimedFactory)) return { ok: false, error: 'claimedFactory must be a valid address' }
  if (typeof expectedToken0 !== 'string' || !ADDRESS_RE.test(expectedToken0)) return { ok: false, error: 'expectedToken0 must be a valid address' }
  if (typeof expectedToken1 !== 'string' || !ADDRESS_RE.test(expectedToken1)) return { ok: false, error: 'expectedToken1 must be a valid address' }
  if (typeof expectedFee !== 'number' || !Number.isInteger(expectedFee) || expectedFee < 0) {
    return { ok: false, error: 'expectedFee must be a non-negative integer' }
  }

  return { ok: true, value: { chain, pool, claimedFactory, expectedToken0, expectedToken1, expectedFee } }
}

function noStore(body: unknown, init?: { status?: number }): NextResponse {
  const res = NextResponse.json(body as object, init)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

// ─── Real dependencies, module-scoped so the investigator's permanent cache is actually permanent
// across requests within one warm instance (see this file's own header) ──────────────────────────
const provenanceCache = createPoolCreationProvenanceCache()

export async function POST(req: NextRequest) {
  const adminEmail = await verifyAdmin(req)
  if (!adminEmail) {
    return noStore({ error: 'Unauthorized' }, { status: 401 })
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

// GET, DISCLOSED: unauthenticated, side-effect-free, no investigator call — exists purely so a
// deploy of this route can be verified safely (per this task's own requirement) without needing an
// admin bearer token or triggering any external provider call.
export async function GET() {
  return noStore({ ok: true, route: 'pool-provenance' })
}
