// PRODUCTION HARDENING — tracing
//
// Purely additive stage-duration tracing. No dependency on src/modules or src/pipeline, no
// provider calls. Feeds completed trace durations into metrics.recordExecutionTime (both files
// live in this same additive package — this is not a modification of any pipeline/module file).

import { recordExecutionTime } from './metrics'

export type CompletedTrace = { stageName: string; durationMs: number; startedAt: string; endedAt: string }

// A stack per stage name supports repeated/nested start-end calls for the same stage label
// (e.g. providerFetchWindow traced once per chain) without traces clobbering each other.
const openTraces = new Map<string, Array<{ startedAtMs: number; startedAtIso: string }>>()
const completedTraces: CompletedTrace[] = []

export function startTrace(stageName: string): void {
  const stack = openTraces.get(stageName) ?? []
  stack.push({ startedAtMs: performance.now(), startedAtIso: new Date().toISOString() })
  openTraces.set(stageName, stack)
}

// Returns the completed trace, or null if endTrace was called without a matching startTrace —
// never fabricates a duration for a trace that was never properly started.
export function endTrace(stageName: string): CompletedTrace | null {
  const stack = openTraces.get(stageName)
  const open = stack?.pop()
  if (!open) return null

  const durationMs = performance.now() - open.startedAtMs
  const trace: CompletedTrace = {
    stageName,
    durationMs,
    startedAt: open.startedAtIso,
    endedAt: new Date().toISOString(),
  }
  completedTraces.push(trace)
  recordExecutionTime(stageName, durationMs)
  return trace
}

export type TraceSummary = {
  completed: CompletedTrace[]
  stillOpenStageNames: string[]
  totalDurationMsByStage: Record<string, number>
}

export function getTraceSummary(): TraceSummary {
  const totalDurationMsByStage: Record<string, number> = {}
  for (const trace of completedTraces) {
    totalDurationMsByStage[trace.stageName] = (totalDurationMsByStage[trace.stageName] ?? 0) + trace.durationMs
  }
  const stillOpenStageNames = [...openTraces.entries()].filter(([, stack]) => stack.length > 0).map(([name]) => name)

  return { completed: [...completedTraces], stillOpenStageNames, totalDurationMsByStage }
}

export function resetTraces(): void {
  openTraces.clear()
  completedTraces.length = 0
}
