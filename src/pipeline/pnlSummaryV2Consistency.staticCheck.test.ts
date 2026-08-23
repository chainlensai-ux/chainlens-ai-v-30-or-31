import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'

const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

it('pipeline never overwrites alternate pnlSummaryV2 totals with canonical reconciliation values', () => {
  const start = source.indexOf('const reconciledPnlSummaryV2: PnlSummaryResult')
  const end = source.indexOf('const priceRecoveryMap', start)
  const block = source.slice(start, end)
  assert.match(block, /\.\.\.adaptedPnlSummary/)
  assert.ok(!block.includes('reconciledPnlSummary.realizedPnlUsd'))
  assert.ok(!block.includes('reconciledPnlSummary.missingEvidenceCount'))
})
