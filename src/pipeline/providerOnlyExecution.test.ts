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
  assert.match(assemblyCall, /resolvedPrices: pricingAtTime,/)
  assert.match(assemblyCall, /attribution: scanPricingRoutes,/)
  assert.doesNotMatch(assemblyCall, /if\s*\([^)]*(?:provider|diagnostic)/i)
})
