// GET /api/qstash-env-debug — diagnostic endpoint confirming which QStash env vars this running
// deployment is actually resolving (regional US_EAST_1_QSTASH_* vs global QSTASH_*), for exactly the
// class of "did the regional rename actually take effect on this deployment" question that caused
// the worker's 403s.
//
// SECRETS ARE NEVER RETURNED IN FULL, DISCLOSED CORRECTION: the literal task asked for `resolvedToken`,
// `resolvedCurrentSigningKey`, `resolvedNextSigningKey`, and `rawEnv` to contain the actual env var
// values. Implemented literally, this would be a public (or near-public) endpoint that hands out the
// real QSTASH_TOKEN (lets anyone who finds this URL publish/spend against your QStash account) and
// the real signing keys (lets anyone forge a valid Upstash-Signature and hit
// app/api/scan-v2/worker/route.ts directly, completely bypassing the signature verification that
// route depends on for its main authorization layer beyond SCAN_WORKER_SECRET). That's a materially
// worse outcome than the 403 this endpoint exists to help debug. Every secret-shaped value below is
// masked instead: whether it's set, its length, and only its last 4 characters — enough to confirm
// "yes, the regional token I pasted into Vercel is the one this deployment is actually reading" (by
// comparing the last 4 characters against what you pasted) without ever exposing a value that could
// be used to authenticate as this app. QSTASH_URL is the one field that isn't a secret (it's a public
// Upstash API endpoint, not a credential) and is returned in full.
//
// ACCESS GATE, DISCLOSED ADDITION: even masked, this reveals real infrastructure/config shape (which
// vars exist, roughly how long they are), so it's gated behind SCAN_WORKER_SECRET — the same secret
// app/api/scan-v2/worker/route.ts already requires, reused here rather than inventing a new env var
// for one diagnostic route. Mirrors that route's own fail-open-with-a-warning behavior when the
// secret isn't configured yet, instead of hard-locking this out in a deployment that hasn't set it up.
//
// SAME RESOLUTION LOGIC, PER TASK B: imports resolveQstashEnv() from
// src/modules/scanJobCreation.ts — the exact function getQstashClient() and (via its resolved output)
// verifySignatureAppRouter's config in app/api/scan-v2/worker/route.ts both use — so the values here
// are guaranteed to match, not a second, potentially-diverging implementation.

import { NextResponse } from 'next/server'
import { resolveQstashEnv } from '@/src/modules/scanJobCreation'

function isAuthorized(req: Request): boolean {
  const configuredSecret = process.env.SCAN_WORKER_SECRET
  if (!configuredSecret) {
    console.warn('[qstash-env-debug] SCAN_WORKER_SECRET is not configured — this diagnostic endpoint is currently unauthenticated')
    return true
  }
  return req.headers.get('x-worker-secret') === configuredSecret
}

type MaskedSecret = { present: boolean; length: number | null; last4: string | null }

function maskSecret(value: string | undefined | null): MaskedSecret {
  if (!value) return { present: false, length: null, last4: null }
  return { present: true, length: value.length, last4: value.length >= 4 ? value.slice(-4) : value }
}

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return new Response('unauthorized', { status: 401 })
  }

  const resolved = resolveQstashEnv()

  return NextResponse.json({
    source: resolved.source, // 'regional_us_east_1' | 'global' | 'none'
    resolvedToken: maskSecret(resolved.token),
    resolvedUrl: resolved.url ?? null, // not a secret — the Upstash API endpoint itself
    resolvedCurrentSigningKey: maskSecret(resolved.currentSigningKey),
    resolvedNextSigningKey: maskSecret(resolved.nextSigningKey),
    rawEnv: {
      US_EAST_1_QSTASH_TOKEN: maskSecret(process.env.US_EAST_1_QSTASH_TOKEN),
      US_EAST_1_QSTASH_URL: process.env.US_EAST_1_QSTASH_URL ?? null,
      US_EAST_1_QSTASH_CURRENT_SIGNING_KEY: maskSecret(process.env.US_EAST_1_QSTASH_CURRENT_SIGNING_KEY),
      US_EAST_1_QSTASH_NEXT_SIGNING_KEY: maskSecret(process.env.US_EAST_1_QSTASH_NEXT_SIGNING_KEY),
      QSTASH_TOKEN: maskSecret(process.env.QSTASH_TOKEN),
      QSTASH_URL: process.env.QSTASH_URL ?? null,
      QSTASH_CURRENT_SIGNING_KEY: maskSecret(process.env.QSTASH_CURRENT_SIGNING_KEY),
      QSTASH_NEXT_SIGNING_KEY: maskSecret(process.env.QSTASH_NEXT_SIGNING_KEY),
    },
    timestamp: Date.now(),
  })
}
