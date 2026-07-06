// lib/server/alchemyAudit.ts — non-intrusive Alchemy RPC audit layer.
//
// NO GENERIC `provider.send`/`.request`/`._send` CLIENT EXISTS, DISCLOSED: the task's own wrapping
// example assumed an ethers-style provider object with a `.send(method, params)` method. Verified
// by search before writing this file: this codebase makes every real Alchemy call as a plain
// `fetch()` POST with a hand-built JSON-RPC body (`{jsonrpc, id, method, params}`), in three real,
// live call sites — src/modules/providerFetchWindow/utils.ts (fetchAlchemyRawEvents, every scan),
// src/modules/holdings/utils.ts (fetchAlchemyHoldings, every scan), and
// src/modules/recoveryPolicy/utils.ts (fetchAlchemyTokenHistory, deep-scan only). There is no
// central client to instrument once — auditRPC() below is called individually at each of those
// three real sites instead (see their own headers for the disclosure).
//
// REAL METHODS, DISCLOSED: the task's own example log lines named eth_getBlockByNumber/
// eth_getLogs/eth_getTransactionReceipt — none of those are actually called anywhere in the real
// Deep Scan flow. The real methods are alchemy_getAssetTransfers and alchemy_getTokenBalances.
//
// GLOBAL REGISTRY, DISCLOSED: kept as a plain module-level object, matching the task's own literal
// design, because auditRPC() must NOT change any wrapped function's signature (per this task's own
// rule) — so a request-scoped object can't be threaded through without adding a new parameter.
// This means the registry persists across requests within one warm serverless instance unless
// explicitly reset; resetAlchemyAudit() is called once per request from
// app/api/scan-v2/full-scan/route.ts (a route file, not the worker/pipeline this task says not to
// touch) right before dispatching to the worker, so each Deep Scan's own printed summary reflects
// only that request's calls.

export type AlchemyAuditCall = { method: string; params: unknown }

export const alchemyAudit: { calls: AlchemyAuditCall[]; summary: Record<string, number> } = {
  calls: [],
  summary: {},
}

export function auditRPC(method: string, params: unknown): void {
  alchemyAudit.calls.push({ method, params })
  if (!alchemyAudit.summary[method]) {
    alchemyAudit.summary[method] = 0
  }
  alchemyAudit.summary[method]++
  // eslint-disable-next-line no-console
  console.log('[ALC-AUDIT] call', method, JSON.stringify(params))
}

// Called once per request (app/api/scan-v2/full-scan/route.ts) so each Deep Scan's printed summary
// reflects only that request's own calls, not everything accumulated since this instance's last
// cold start.
export function resetAlchemyAudit(): void {
  alchemyAudit.calls = []
  alchemyAudit.summary = {}
}

export function printAlchemyAuditSummary(): void {
  // eslint-disable-next-line no-console
  console.log('[ALC-AUDIT] summary', JSON.stringify(alchemyAudit.summary, null, 2))
}
