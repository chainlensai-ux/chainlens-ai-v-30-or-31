// MODULE — perfBenchmark/formatReport: renders the exact human-readable before/after report this
// benchmark exists to produce. PURE — takes two already-computed BenchmarkBuckets (old/baseline vs
// new/current), returns a plain-text report. No I/O, no formatting decisions hidden elsewhere.

import type { BenchmarkBuckets } from './buckets'

// Real percent change, rounded — `decimals` controls precision (0 for per-bucket lines matching the
// requested "-31%" style, 1 for the Overall line matching "-34.8%"). NEVER fabricates a number for
// an undefined case: if the baseline bucket was genuinely 0ms and the new run is ALSO 0ms, that's a
// real, honest 0% (nothing to compare, nothing changed). If the baseline was 0ms but the new run is
// NOT, percent change is mathematically undefined (division by zero) — reported as 'N/A (new work)'
// rather than a fabricated Infinity/NaN.
export function percentChange(oldMs: number, newMs: number, decimals: 0 | 1): string {
  if (oldMs === 0) {
    if (newMs === 0) return `${(0).toFixed(decimals)}%`
    return 'N/A (new work)'
  }
  const pct = ((newMs - oldMs) / oldMs) * 100
  const rounded = Math.round(pct * 10 ** decimals) / 10 ** decimals
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${rounded.toFixed(decimals)}%`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatBenchmarkReport(old: BenchmarkBuckets, current: BenchmarkBuckets): string {
  const lines: string[] = []
  lines.push(`Old scan: ${seconds(old.totalMs)}`)
  lines.push(`New scan: ${seconds(current.totalMs)}`)
  lines.push('Provider fetch:')
  lines.push(percentChange(old.providerFetch, current.providerFetch, 0))
  lines.push('Pricing:')
  lines.push(percentChange(old.pricing, current.pricing, 0))
  lines.push('Merge:')
  lines.push(percentChange(old.merge, current.merge, 0))
  lines.push('Recovery:')
  lines.push(percentChange(old.recovery, current.recovery, 0))
  // OTHER BUCKET, DISCLOSED: only printed when either run actually spent time in an unmapped stage
  // (e.g. dustSuppression, or receiptDecoding when it ran synchronously) — omitted when both are
  // zero so the report stays exactly the requested four-bucket shape for the common case, while
  // never silently hiding real time neither old nor new run had.
  if (old.other > 0 || current.other > 0) {
    lines.push('Other (unmapped stages):')
    lines.push(percentChange(old.other, current.other, 0))
  }
  lines.push('Overall:')
  lines.push(percentChange(old.totalMs, current.totalMs, 1))
  return lines.join('\n')
}
