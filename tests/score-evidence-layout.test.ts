import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import TokenRiskEvidenceNotice from '../components/TokenRiskEvidenceNotice'

test('coverage and methodology are collapsed; limited confidence remains visible without a coverage banner', () => {
  const html = renderToStaticMarkup(React.createElement(TokenRiskEvidenceNotice, { coverage: 25, confidence: 'low', methodology: 'evm_token_risk_score:v2', missingChecks: ['LP ownership: unverified', 'Trading simulation: unavailable'] }))
  const beforeDetails = html.split('<details>')[0]
  assert.match(beforeDetails, /Low.*confidence/)
  assert.doesNotMatch(beforeDetails, /25%|border:|padding:/)
  assert.match(html, /<summary[^>]*>Evidence &amp; Confidence<\/summary>/)
  assert.doesNotMatch(html, /<details[^>]* open/)
  assert.match(html, /25% coverage/)
  assert.match(html, /evm_token_risk_score:v2/)
  assert.match(html, /LP ownership: unverified/)
  const page = readFileSync('app/terminal/token-scanner/page.tsx', 'utf8')
  assert.ok(page.indexOf('<TokenRiskEvidenceNotice coverage={result.riskEvidenceCoveragePercent}') > page.indexOf('className="risk-score-hero"'))
})
