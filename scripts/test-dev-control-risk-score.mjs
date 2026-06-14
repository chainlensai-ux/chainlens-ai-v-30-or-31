import assert from 'node:assert/strict'
import { calculateDevControlRisk } from '../lib/server/devControlRisk.ts'

const cases = [
  ['clusterSupply 0 + top20 60.2 => score > 5', { clusterSupplyPercent: 0, top20Percent: 60.2 }, r => assert.ok(r.score > 5)],
  ['top10 48.2 => score at least Watch', { clusterSupplyPercent: 0, top10Percent: 48.2 }, r => assert.ok(r.score >= 21)],
  ['creator in top holders => score >= 45', { clusterSupplyPercent: 0, creatorInTopHolders: true }, r => assert.ok(r.score >= 45)],
  ['linked wallet supply >= 10 => score >= 65', { clusterSupplyPercent: 0, linkedWalletSupplyPercent: 10 }, r => assert.ok(r.score >= 65)],
  ['partial holder evidence prevents false minimal score', { clusterSupplyPercent: 0, holderEvidencePartial: true }, r => assert.ok(r.score >= 30)],
  ['true no-risk/no-cluster/no-concentration remains low', { clusterSupplyPercent: 0, top10Percent: 12, top20Percent: 20 }, r => assert.equal(r.label, 'low')],
]

for (const [name, input, check] of cases) {
  const result = calculateDevControlRisk(input)
  check(result)
  console.log(`ok - ${name}: ${result.score}/${result.label}`)
}
