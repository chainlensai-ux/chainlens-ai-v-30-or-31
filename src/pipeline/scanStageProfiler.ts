// SCAN STAGE PROFILER, DISCLOSED, ADDITIVE (Wallet Scanner unexplained-latency audit).
//
// WHY THIS EXISTS: `startStageTimer` in src/pipeline/index.ts measures seven stages, all of which
// finish at `pricingAtTime`. Everything after that mark — synthetic pool pricing, boundary-dependent
// sell resolution, canonical sample selection (manifest read/replay/refresh/build/write + additive
// and diff audits), PnL reconciliation, ROI quote-leg proof persistence, the provider-window KV
// write settle — plus the per-chain holdings fetch that runs in runWalletScanV2 BEFORE
// runWalletScan is even called, was completely unmeasured. A production baseline showed a
// pipeline total of ~113.8s against ~40s of measured stages, leaving ~70s+ attributable to nothing.
// This module closes that gap by measuring the regions the old timer structurally could not see.
//
// PURE INSTRUMENTATION, DISCLOSED: every `stage()` call wraps an existing region and returns that
// region's own value unchanged. A stage that throws still records its sample (try/finally) and the
// error is rethrown untouched — this module can never swallow a failure, change a value, reorder an
// await, or alter fail-closed behavior. Counters are opt-in hints recorded by the call site; a
// region that reports none honestly reports 0, never a guess.
//
// BOUNDED, DISCLOSED: sample retention is hard-capped (MAX_SAMPLES). Once the cap is reached,
// further stages are counted and their duration summed into an overflow bucket rather than retained
// individually, so a pathological caller can never grow this unboundedly inside a serverless
// invocation.
//
// NESTING, DISCLOSED: stages may nest (canonicalSampleSelection runs INSIDE pnlReconciliation).
// Every sample records its `depth`; reconciliation sums ONLY depth-0 stages, so a nested stage is
// fully visible for attribution without being double-counted against the total.

export type ScanStageSample = {
  name: string
  /** Epoch ms (Date.now()) when this stage began — comparable across the whole job. */
  startedAt: number
  /** Epoch ms when this stage ended. */
  endedAt: number
  /** Wall-clock ms, measured with performance.now() so it is monotonic and clock-change safe. */
  durationMs: number
  /** Real provider/network calls this region reported. 0 when the region reported none. */
  providerCalls: number
  /** Real KV/store reads this region reported. 0 when the region reported none. */
  kvReads: number
  /** Real cache/memo hits this region reported. 0 when the region reported none. */
  cacheHits: number
  /**
   * True when this region's own internal awaits run one-after-another (a serial critical path),
   * false when it fans out concurrently. Declared by the call site from the real code shape — never
   * inferred, never guessed.
   */
  awaitedSerially: boolean
  /** 0 for a top-level stage; >0 when this stage ran inside another measured stage. */
  depth: number
  /** True when the wrapped region threw (the error is always rethrown; this only records it). */
  failed: boolean
}

export type ScanStageReconciliation = {
  /** Total job wall-clock the caller is reconciling against. */
  totalMs: number
  /** Sum of every depth-0 stage's durationMs. */
  measuredMs: number
  /** Caller-supplied pre/post-pipeline time measured outside any stage (0 when none). */
  knownPrePostMs: number
  /** totalMs - (measuredMs + knownPrePostMs), floored at 0. */
  unexplainedMs: number
  /** unexplainedMs as a percent of totalMs (0 when totalMs is 0). */
  unexplainedPercent: number
  /** True when unexplainedPercent <= 5 — the audit's own stated reconciliation target. */
  withinTolerance: boolean
  /** Count of depth-0 stages summed. */
  topLevelStageCount: number
  /** Count of stages dropped from retention by the MAX_SAMPLES cap (0 in every normal scan). */
  overflowStageCount: number
  /** Summed duration of the dropped stages, so the cap can never silently hide time. */
  overflowMs: number
}

export type ScanStageProfile = {
  samples: ScanStageSample[]
  reconciliation: ScanStageReconciliation
  /** Top-level stages ordered slowest first — the audit's "top N slowest stages" view. */
  slowest: Array<{ name: string; durationMs: number; percentOfTotal: number }>
}

const MAX_SAMPLES = 64

export type StageCounters = {
  providerCalls?: number
  kvReads?: number
  cacheHits?: number
}

export type StageOptions = {
  /** See ScanStageSample.awaitedSerially — declared from the real code shape by the call site. */
  awaitedSerially: boolean
}

export type ScanStageProfiler = {
  /** Wraps an async region. Returns its value unchanged; rethrows its error unchanged. */
  stage: <T>(name: string, options: StageOptions, fn: () => Promise<T>) => Promise<T>
  /** Wraps a synchronous region (pure stages like normalization/assembly still cost real ms). */
  stageSync: <T>(name: string, options: StageOptions, fn: () => T) => T
  /**
   * Records counters against the innermost currently-open stage. Safe to call with no stage open
   * (it is simply ignored), so a shared helper can report counts without knowing its caller.
   */
  count: (counters: StageCounters) => void
  /** Records an already-measured region this profiler did not itself wrap (e.g. a legacy timer). */
  record: (sample: Omit<ScanStageSample, 'depth' | 'failed'> & { depth?: number; failed?: boolean }) => void
  samples: () => ScanStageSample[]
  build: (params: { totalMs: number; knownPrePostMs?: number }) => ScanStageProfile
}

export function createScanStageProfiler(): ScanStageProfiler {
  const samples: ScanStageSample[] = []
  // Open stages, innermost last — drives both `depth` and counter attribution.
  const open: Array<{ name: string; counters: Required<StageCounters> }> = []
  let overflowStageCount = 0
  let overflowMs = 0

  function push(sample: ScanStageSample): void {
    if (samples.length >= MAX_SAMPLES) {
      overflowStageCount += 1
      // Only depth-0 overflow can affect the reconciliation sum; nested overflow is attribution
      // detail. Both are reported, but only top-level time is added to overflowMs.
      if (sample.depth === 0) overflowMs += sample.durationMs
      return
    }
    samples.push(sample)
  }

  // `awaitedSerially` is a DECLARED property of the region (its real code shape), not something
  // this function could observe at runtime — so it is passed straight through rather than patched
  // onto the pushed sample afterwards. Patching by index would be wrong whenever a nested stage
  // pushed after this one started, or whenever this sample was dropped by the MAX_SAMPLES cap.
  function finish(
    name: string, startedAt: number, startPerf: number, depth: number, failed: boolean, awaitedSerially: boolean,
  ): void {
    const frame = open.pop()
    const durationMs = Math.round(performance.now() - startPerf)
    push({
      name,
      startedAt,
      endedAt: startedAt + durationMs,
      durationMs,
      providerCalls: frame?.counters.providerCalls ?? 0,
      kvReads: frame?.counters.kvReads ?? 0,
      cacheHits: frame?.counters.cacheHits ?? 0,
      awaitedSerially,
      depth,
      failed,
    })
  }

  async function stage<T>(name: string, options: StageOptions, fn: () => Promise<T>): Promise<T> {
    const depth = open.length
    const startedAt = Date.now()
    const startPerf = performance.now()
    open.push({ name, counters: { providerCalls: 0, kvReads: 0, cacheHits: 0 } })
    try {
      const value = await fn()
      finish(name, startedAt, startPerf, depth, false, options.awaitedSerially)
      return value
    } catch (error) {
      finish(name, startedAt, startPerf, depth, true, options.awaitedSerially)
      throw error
    }
  }

  function stageSync<T>(name: string, options: StageOptions, fn: () => T): T {
    const depth = open.length
    const startedAt = Date.now()
    const startPerf = performance.now()
    open.push({ name, counters: { providerCalls: 0, kvReads: 0, cacheHits: 0 } })
    try {
      const value = fn()
      finish(name, startedAt, startPerf, depth, false, options.awaitedSerially)
      return value
    } catch (error) {
      finish(name, startedAt, startPerf, depth, true, options.awaitedSerially)
      throw error
    }
  }

  function count(counters: StageCounters): void {
    const frame = open[open.length - 1]
    if (!frame) return
    frame.counters.providerCalls += counters.providerCalls ?? 0
    frame.counters.kvReads += counters.kvReads ?? 0
    frame.counters.cacheHits += counters.cacheHits ?? 0
  }

  function record(sample: Omit<ScanStageSample, 'depth' | 'failed'> & { depth?: number; failed?: boolean }): void {
    push({ ...sample, depth: sample.depth ?? 0, failed: sample.failed ?? false })
  }

  function build(params: { totalMs: number; knownPrePostMs?: number }): ScanStageProfile {
    const knownPrePostMs = params.knownPrePostMs ?? 0
    const topLevel = samples.filter((s) => s.depth === 0)
    const measuredMs = topLevel.reduce((sum, s) => sum + s.durationMs, 0) + overflowMs
    const unexplainedMs = Math.max(0, Math.round(params.totalMs - (measuredMs + knownPrePostMs)))
    const unexplainedPercent = params.totalMs > 0
      ? Math.round((unexplainedMs / params.totalMs) * 1000) / 10
      : 0
    return {
      samples: [...samples],
      reconciliation: {
        totalMs: params.totalMs,
        measuredMs,
        knownPrePostMs,
        unexplainedMs,
        unexplainedPercent,
        withinTolerance: unexplainedPercent <= 5,
        topLevelStageCount: topLevel.length,
        overflowStageCount,
        overflowMs,
      },
      slowest: [...topLevel]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10)
        .map((s) => ({
          name: s.name,
          durationMs: s.durationMs,
          percentOfTotal: params.totalMs > 0 ? Math.round((s.durationMs / params.totalMs) * 1000) / 10 : 0,
        })),
    }
  }

  return { stage, stageSync, count, record, samples: () => [...samples], build }
}
