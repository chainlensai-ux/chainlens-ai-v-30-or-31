// Token Scanner risk-label bands. Score math is unchanged; only the label mapping.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  riskLabelFromCanonicalScore,
  riskLabelCopy,
  normalizeRiskScore,
  coerceCanonicalRiskLabel,
  CAUTION_ELEVATED_COPY,
} from '../lib/riskScoreDirection.ts'

const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const helperSrc = readFileSync(new URL('../lib/riskScoreDirection.ts', import.meta.url), 'utf8')
const responseSrc = readFileSync(new URL('../lib/server/tokenPublicResponse.ts', import.meta.url), 'utf8')

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed += 1
}

check('20 = Low Risk', riskLabelFromCanonicalScore(20) === 'Low Risk')
check('40 = Moderate Risk', riskLabelFromCanonicalScore(40) === 'Moderate Risk')
check('58 = Caution', riskLabelFromCanonicalScore(58) === 'Caution')
check('58 is not High Risk', riskLabelFromCanonicalScore(58) !== 'High Risk')
check('61 = High Risk', riskLabelFromCanonicalScore(61) === 'High Risk')
check('75 = High Risk, not Extreme', riskLabelFromCanonicalScore(75) === 'High Risk')
check('76 = Extreme Risk', riskLabelFromCanonicalScore(76) === 'Extreme Risk')
check('High Risk only at 61+', riskLabelFromCanonicalScore(60) !== 'High Risk' && riskLabelFromCanonicalScore(61) === 'High Risk')
check('Extreme Risk only at 76+', riskLabelFromCanonicalScore(75) !== 'Extreme Risk' && riskLabelFromCanonicalScore(76) === 'Extreme Risk')

const caution = normalizeRiskScore({ rawScore: 58, rawScoreType: 'risk_score', confidence: 'high', source: 'token_scanner' })
check('58/100 label is Caution', caution.riskLabel === 'Caution')
check('58 copy is elevated-risk wording', caution.copy === CAUTION_ELEVATED_COPY)
check('58 copy helper matches UI copy', riskLabelCopy(caution.riskLabel) === 'Elevated risk — missing LP/dev verification')
check('confidence stays High and separate from label', caution.confidence === 'high' && caution.riskLabel !== caution.confidence)

check('legacy Medium Risk remaps to Moderate Risk', coerceCanonicalRiskLabel('Medium Risk') === 'Moderate Risk')
check('legacy Critical Risk remaps to Extreme Risk', coerceCanonicalRiskLabel('Critical Risk') === 'Extreme Risk')

check('Overview uses normalizeRiskScore helper', /displayLocation: 'overview'/.test(pageSrc))
check('Risk Engine uses normalizeRiskScore helper', /displayLocation: 'risk_engine_tab'/.test(pageSrc))
check('Sidebar uses normalizeRiskScore helper', /displayLocation: 'right_rail'/.test(pageSrc))
check('CORTEX Safety Read uses same risk label helper', /Risk label:/.test(pageSrc) && /riskLabelCopy\(normalizedRisk\.riskLabel\)/.test(pageSrc))
check('Risk Engine uses riskLabelCopy', /riskLabelCopy\(displayCortexVerdict\)/.test(pageSrc))
check('Sidebar uses riskLabelCopy', /riskLabelCopy\(sidebarRisk\.riskLabel\)/.test(pageSrc))
check('confidence badge is separate from risk label', /CONFIDENCE/.test(pageSrc) && /riskLabelCopy/.test(pageSrc))
check('public CORTEX copy uses the same score helper', /riskLabelFromCanonicalScore\(score\)/.test(responseSrc))
check('helper owns the new bands', /score <= 20/.test(helperSrc) && /score <= 40/.test(helperSrc) && /score <= 60/.test(helperSrc) && /score <= 75/.test(helperSrc))

console.log(`test-risk-label-bands: ${passed} checks passed`)
