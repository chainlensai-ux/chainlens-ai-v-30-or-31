// SHARED GUARD — dev-only paid-provider test/diagnostic routes.
//
// CU-LEAK AUDIT HARDENING, DISCLOSED (this task): the previous pass gated
// app/api/test/alchemy-multichain behind NODE_ENV==='production' + an ADMIN_SECRET bypass — but any
// bypass, however gated, is still a live path to a real paid-provider call in production. This task
// explicitly requires the stronger rule: these routes must ALWAYS return 404 in production, making
// ZERO provider calls there, with NO exception — usable only in local development
// (NODE_ENV !== 'production'). Applied uniformly to every /api/test/* route that can call a paid
// provider (Alchemy, Covalent/GoldRush, Zerion) so none of them is a weaker, inconsistent exception
// to the others.
//
// NEVER HTML, DISCLOSED: the blocked response is always NextResponse.json with
// Cache-Control: no-store, matching every other route in this codebase's own convention.

import { NextResponse } from 'next/server'

// PURE — no I/O, directly unit-testable.
export function isDevOnlyProviderRouteAllowed(): boolean {
  return process.env.NODE_ENV !== 'production'
}

export function devOnlyProviderRouteBlockedResponse(): NextResponse {
  return NextResponse.json({ error: 'Not available' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
}
