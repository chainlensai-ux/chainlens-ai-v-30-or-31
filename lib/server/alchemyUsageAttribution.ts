// MODULE — temporary Alchemy usage attribution diagnostics.
//
// CU-LEAK AUDIT, DISCLOSED (this task): a structured, bounded, in-memory (per-instance, same
// limitation as lib/server/rpcDebug.ts's own buffer) record per real Alchemy call, carrying exactly
// the fields this task requires — requestId, route, feature, method, chain, call count, cache hit/
// miss, estimated CU (via alchemyCallBudget.ts's own cost table, restated not re-derived), an
// authenticated/anonymous classification, and a source category (explicit_scan / page_load / admin
// / background / fallback). NEVER logs wallet addresses' contents, token balances, secrets, or API
// keys — only the shape of the call itself.
//
// TEMPORARY, DISCLOSED: this is diagnostic-only, additive instrumentation for this investigation —
// it never gates, blocks, or changes any call's outcome (that's alchemyCallBudget.ts's job); it only
// records what already happened for later aggregation.

export type AlchemySourceCategory = 'explicit_scan' | 'page_load' | 'admin' | 'background' | 'fallback'
export type AlchemyUserClassification = 'authenticated' | 'anonymous'

export type AlchemyUsageRecord = {
  timestamp: number
  requestId: string
  route: string
  feature: string
  method: string
  chain: string
  callCount: number
  cacheHit: boolean
  estimatedCu: number
  userClassification: AlchemyUserClassification
  sourceCategory: AlchemySourceCategory
}

export type RecordAlchemyUsageInput = {
  requestId: string
  route: string
  feature: string
  method: string
  chain: string
  cacheHit: boolean
  userClassification: AlchemyUserClassification
  sourceCategory: AlchemySourceCategory
  estimatedCu: number
}

// BOUNDED, DISCLOSED: same discipline as every other in-memory diagnostic buffer in this codebase
// (rpcDebugLog, receiptForensics, etc.) — capped so a runaway caller can never grow this without
// bound; oldest entries are dropped first (FIFO), matching the "recent activity, not an unbounded
// dump" convention used throughout this codebase's other debug buffers.
export const MAX_ALCHEMY_USAGE_RECORDS = 2000

export const alchemyUsageLog: AlchemyUsageRecord[] = []

// MUST NOT throw, DISCLOSED: recording a diagnostic can never itself break the real call it's
// describing — same convention as lib/server/rpcDebug.ts's own logRpcCall.
export function recordAlchemyUsage(input: RecordAlchemyUsageInput): void {
  try {
    alchemyUsageLog.push({ timestamp: Date.now(), callCount: 1, ...input })
    if (alchemyUsageLog.length > MAX_ALCHEMY_USAGE_RECORDS) {
      alchemyUsageLog.splice(0, alchemyUsageLog.length - MAX_ALCHEMY_USAGE_RECORDS)
    }
  } catch {
    // Never throws, never surfaces to the caller.
  }
}

export type AlchemyUsageAggregate = {
  totalCalls: number
  totalEstimatedCu: number
  cacheHits: number
  cacheMisses: number
  byRoute: Record<string, { calls: number; estimatedCu: number }>
  byMethod: Record<string, { calls: number; estimatedCu: number }>
  topRequestIds: Array<{ requestId: string; calls: number; estimatedCu: number }>
}

const MAX_TOP_REQUEST_IDS = 10

// PURE, DISCLOSED: aggregates an already-captured list of records — never reads `alchemyUsageLog`
// directly, so it's independently testable against any fixture, and a caller can aggregate a bounded
// time slice (e.g. `alchemyUsageLog.slice(snapshotIndex)`) rather than the whole buffer.
export function aggregateAlchemyUsage(records: readonly AlchemyUsageRecord[]): AlchemyUsageAggregate {
  const byRoute: Record<string, { calls: number; estimatedCu: number }> = {}
  const byMethod: Record<string, { calls: number; estimatedCu: number }> = {}
  const byRequestId = new Map<string, { calls: number; estimatedCu: number }>()
  let cacheHits = 0
  let cacheMisses = 0
  let totalEstimatedCu = 0

  for (const r of records) {
    const route = byRoute[r.route] ?? { calls: 0, estimatedCu: 0 }
    route.calls += 1
    route.estimatedCu += r.estimatedCu
    byRoute[r.route] = route

    const method = byMethod[r.method] ?? { calls: 0, estimatedCu: 0 }
    method.calls += 1
    method.estimatedCu += r.estimatedCu
    byMethod[r.method] = method

    const req = byRequestId.get(r.requestId) ?? { calls: 0, estimatedCu: 0 }
    req.calls += 1
    req.estimatedCu += r.estimatedCu
    byRequestId.set(r.requestId, req)

    if (r.cacheHit) cacheHits += 1
    else cacheMisses += 1
    totalEstimatedCu += r.estimatedCu
  }

  const topRequestIds = [...byRequestId.entries()]
    .map(([requestId, v]) => ({ requestId, ...v }))
    .sort((a, b) => b.estimatedCu - a.estimatedCu)
    .slice(0, MAX_TOP_REQUEST_IDS)

  return { totalCalls: records.length, totalEstimatedCu, cacheHits, cacheMisses, byRoute, byMethod, topRequestIds }
}
