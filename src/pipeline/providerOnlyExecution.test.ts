import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pipelineSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function position(label: string, source: string): number {
  const index = pipelineSource.indexOf(source)
  assert.notEqual(index, -1, `${label} must remain in the pipeline`)
  return index
}

const normalizedEventsPosition = position(
  'normalized events',
  'const { normalizedEvents, normalizationErrors } = normalizeEvents(allRawEvents, params.walletAddress)',
)
const pricingAtTimePosition = position(
  'pricingAtTime',
  'const pricingAtTime = await safeRunPricingAtTime({',
)
const resolvePipelinePricePosition = position(
  'resolvePipelinePrice',
  'const resolved = (await resolvePipelinePrice(entry.timestamp, {',
)
const syntheticPnlAssemblyPosition = position(
  'syntheticPnlAssembly',
  'const syntheticPnl = syntheticPnlAssembly({',
)
const finalReportPosition = position(
  'final report assembly',
  'const finalReport = safeAssembleReport({',
)

const topSyntheticPnlSummaryPosition = position(
  'top syntheticPnl summary',
  `logSyntheticPnlSummary(syntheticPnl)

  // Deferred until after the mandatory synthetic-PnL summary above;`,
)
const providerFetchWindowDiagnosticsLogPosition = position(
  'providerFetchWindowDiagnostics log',
  "console.warn('[pipeline] providerFetchWindowDiagnostics', providerFetchWindowDiagnostics)",
)
const normalizedEventsTraceLogPosition = position(
  'normalizedEvents trace log',
  "console.warn('[debug] normalizedEvents trace', normalizedEventsTrace)",
)
const bottomSyntheticPnlSummaryPosition = position(
  'bottom syntheticPnl summary',
  `logSyntheticPnlSummary(syntheticPnl)

  return { ...finalReport, normalizationErrors, walletConditionMessages }`,
)
const finalReturnPosition = position(
  'final return',
  'return { ...finalReport, normalizationErrors, walletConditionMessages }',
)

test('provider-only scans cannot return after normalization before pricingAtTime', () => {
  const postNormalizationPrefix = pipelineSource.slice(normalizedEventsPosition, pricingAtTimePosition)

  // A provider/diagnostics shortcut used to return from runWalletScan in this interval. Restrict
  // this check to two-space indentation so returns belonging to nested callbacks/helpers do not
  // produce false positives.
  assert.doesNotMatch(postNormalizationPrefix, /^  return\b/m)
  assert.ok(normalizedEventsPosition < pricingAtTimePosition)
})

test('provider-only scans resolve pipeline prices and assemble synthetic PnL in order', () => {
  assert.ok(pricingAtTimePosition < resolvePipelinePricePosition)
  assert.ok(resolvePipelinePricePosition < syntheticPnlAssemblyPosition)
  assert.ok(syntheticPnlAssemblyPosition < finalReportPosition)
})

test('provider-only scans use the assembly boundary that always prints the synthetic PnL summary', () => {
  const assemblyCall = pipelineSource.slice(syntheticPnlAssemblyPosition, finalReportPosition)

  assert.match(assemblyCall, /normalizedEvents,/)
  assert.match(assemblyCall, /priceLotsForWalletOutput: walletPriceLookups,/)
  assert.match(assemblyCall, /resolvedPrices: pricingAtTime,/)
  assert.match(assemblyCall, /poolData: syntheticPoolData,/)
  assert.match(assemblyCall, /attribution: scanPricingRoutes,/)
  assert.doesNotMatch(assemblyCall, /if\s*\([^)]*(?:provider|diagnostic)/i)
})

test('syntheticPnl summary prints at the top before truncation-prone diagnostics', () => {
  assert.ok(syntheticPnlAssemblyPosition < topSyntheticPnlSummaryPosition)
  assert.ok(topSyntheticPnlSummaryPosition < providerFetchWindowDiagnosticsLogPosition)
  assert.ok(topSyntheticPnlSummaryPosition < normalizedEventsTraceLogPosition)
})

test('syntheticPnl summary prints again at the bottom after all stages', () => {
  assert.ok(finalReportPosition < bottomSyntheticPnlSummaryPosition)
  assert.ok(bottomSyntheticPnlSummaryPosition < finalReturnPosition)
})

test('extremely large normalizedEvents logs cannot precede the first syntheticPnl summary', () => {
  assert.ok(position('normalizedEvents trace object', 'const normalizedEventsTrace = {') < syntheticPnlAssemblyPosition)
  assert.ok(topSyntheticPnlSummaryPosition < normalizedEventsTraceLogPosition)
})

test('provider-only, diagnostics, and full scans share the same syntheticPnl assembly path', () => {
  const runBodyBeforeAssembly = pipelineSource.slice(normalizedEventsPosition, syntheticPnlAssemblyPosition)
  const runBodyThroughReturn = pipelineSource.slice(normalizedEventsPosition, finalReturnPosition)

  assert.doesNotMatch(runBodyBeforeAssembly, /^  return\b/m)
  assert.doesNotMatch(runBodyThroughReturn, /if\s*\([^)]*params\.scanMode[^)]*\)\s*return/m)
  assert.match(runBodyThroughReturn, /scanMode: params\.scanMode,/)
})
