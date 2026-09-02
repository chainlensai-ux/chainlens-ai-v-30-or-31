// Token Scanner shared evidence state.
// Holders / Dev / Risk / Wallet Detail must use the same classifier. No faked proof.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classifyTokenScannerEvidence,
  linkedWalletGraphLabel,
  cautionRiskCopy,
  tokenScannerEvidenceChainId,
  isRobinhoodEvidenceChain,
  evidenceLabelsAreSpecific,
  DEV_SUPPLY_DEPLOYER_UNRESOLVED,
  NOT_IN_INDEXED_HOLDER_ROWS,
  GRAPH_RAN_NONE_LABEL,
  GRAPH_NOT_RUN_PREFIX,
  CAUTION_HOLDERS_VERIFIED_COPY,
  CAUTION_ELEVATED_COPY,
  ROBINHOOD_EVIDENCE_CHAIN_ID,
} from '../lib/tokenScannerEvidence.ts'
import { riskLabelCopy, riskLabelFromCanonicalScore } from '../lib/riskScoreDirection.ts'
import { buildDevMapUiLabels, emptyDevClusterDiagnosisAudit, linkedWalletDisplayLabel } from '../lib/devClusterDiagnosis.ts'
import { resolveDeployerWalletIntel } from '../lib/deployerWalletIntel.ts'

const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DEPLOYER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed += 1
}

const holderRows = [
  { address: OTHER, percent: 12.5, rank: 1 },
  { address: '0x3333333333333333333333333333333333333333', percent: 8.2, rank: 2 },
]

// ── 1. holders verified + deployer unresolved ──────────────────────────────
{
  const ev = classifyTokenScannerEvidence({
    holdersVerified: true,
    holderRows,
    deployerAddress: null,
    graphStatus: 'not_run',
    graphFailureReason: 'Alchemy invalid param — skipped',
    chainId: 8453,
    chainSlug: 'base',
  })
  check('holders verified + deployer unresolved uses exact supply copy', ev.labels.supplyControl === DEV_SUPPLY_DEPLOYER_UNRESOLVED)
  check('does not say Unknown', !/unknown/i.test(ev.labels.currentHolder) && ev.labels.currentHolder !== 'Unknown')
  check('does not say Needs holder evidence', !/needs holder evidence/i.test(ev.labels.supplyControl))
  check('deployer status is not_checked, not unknown display', ev.deployerStatus === 'not_checked')

  const intel = resolveDeployerWalletIntel({
    chainSlug: 'base',
    tokenAddress: TOKEN,
    deployerAddress: null,
    holdersVerified: true,
    holderSnapshot: { available: true, topHolders: holderRows },
  }).intel
  check('Wallet Detail unresolved deployer uses same helper copy', intel.supplyLabel === DEV_SUPPLY_DEPLOYER_UNRESOLVED)
  check('Wallet Detail current-holder label is not Unknown', intel.isCurrentHolderLabel === DEV_SUPPLY_DEPLOYER_UNRESOLVED)
  check('Wallet Detail does not finish as open_check when holders verified', intel.confidence !== 'open_check')
}

// ── 2. holders verified + wallet absent from rows ──────────────────────────
{
  const ev = classifyTokenScannerEvidence({
    holdersVerified: true,
    holderRows,
    deployerAddress: DEPLOYER,
    selectedWallet: DEPLOYER,
    graphStatus: 'ran_none',
    chainId: 8453,
    chainSlug: 'base',
  })
  check('absent wallet is Not in indexed holder rows', ev.labels.walletSupply === NOT_IN_INDEXED_HOLDER_ROWS)
  check('wallet status is not_in_indexed_holder_rows', ev.walletStatus === 'not_in_indexed_holder_rows')
  check('current holder is not Unknown', ev.labels.currentHolder === NOT_IN_INDEXED_HOLDER_ROWS)

  const intel = resolveDeployerWalletIntel({
    chainSlug: 'base',
    tokenAddress: TOKEN,
    deployerAddress: DEPLOYER,
    holdersVerified: true,
    holderSnapshot: { available: true, topHolders: holderRows },
  }).intel
  check('Wallet Detail absent wallet uses same helper', intel.supplyLabel === NOT_IN_INDEXED_HOLDER_ROWS)
  check('Wallet Detail holder rank uses same helper', intel.holderRankLabel === NOT_IN_INDEXED_HOLDER_ROWS)
  check('Wallet Detail current-holder label is not Unknown', intel.isCurrentHolderLabel === NOT_IN_INDEXED_HOLDER_ROWS)
}

// ── 3. graph not run vs graph ran and found none ───────────────────────────
{
  const notRun = linkedWalletGraphLabel('not_run', 'Alchemy invalid param — skipped', null)
  const ranNone = linkedWalletGraphLabel('ran_none', null, 0)
  check('graph not run uses Linked wallet graph not run prefix', notRun.startsWith(GRAPH_NOT_RUN_PREFIX))
  check('graph not run includes reason', notRun.includes('Alchemy invalid param — skipped'))
  check('graph not run is not 0 mapped', !notRun.includes('0 mapped'))
  check('graph ran none is 0 confirmed', ranNone === GRAPH_RAN_NONE_LABEL)

  const audit = emptyDevClusterDiagnosisAudit(8453, 'base', TOKEN)
  audit.linkedWalletGraph.graphStatus = 'not_run'
  audit.linkedWalletGraph.failureReason = 'Alchemy invalid param — skipped'
  const labels = buildDevMapUiLabels(audit, { holdersVerified: true, holderRowsReturned: 20, top10Pct: 29.5 })
  check('Dev Map graph-not-run uses shared label', labels.linkedLabel.startsWith(GRAPH_NOT_RUN_PREFIX))
  check('linkedWalletDisplayLabel matches helper', linkedWalletDisplayLabel(audit.linkedWalletGraph) === notRun)

  audit.linkedWalletGraph.graphStatus = 'ran_none'
  audit.linkedWalletGraph.walletsMapped = 0
  audit.linkedWalletGraph.failureReason = null
  check('Dev Map ran-none is 0 confirmed', buildDevMapUiLabels(audit).linkedLabel === '0 confirmed')
}

// ── 4. no generic Unknown / Open check / Pending without reason ────────────
{
  const ev = classifyTokenScannerEvidence({
    holdersVerified: true,
    holderRows,
    deployerAddress: null,
    selectedWallet: DEPLOYER,
    graphStatus: 'not_run',
    graphFailureReason: 'timeout',
    chainId: 8453,
  })
  for (const [k, v] of Object.entries(ev.labels)) {
    check(`label ${k} is specific: ${v}`, evidenceLabelsAreSpecific(String(v)))
  }
}

// ── 5. Risk copy does not say holder evidence missing when holders verified ─
{
  check('58 is Caution', riskLabelFromCanonicalScore(58) === 'Caution')
  const copy = riskLabelCopy('Caution', { holdersVerified: true })
  check('verified-holders Caution copy is exact', copy === CAUTION_HOLDERS_VERIFIED_COPY)
  check('does not say missing holder evidence', !/missing holder/i.test(copy ?? ''))
  check('does not use generic missing LP/dev verification', copy !== CAUTION_ELEVATED_COPY)
  check('cautionRiskCopy matches', cautionRiskCopy({ holdersVerified: true }) === CAUTION_HOLDERS_VERIFIED_COPY)
  check('unverified holders keep generic copy', riskLabelCopy('Caution', { holdersVerified: false }) === CAUTION_ELEVATED_COPY)
}

// ── 6. Wallet Detail uses the same helper ──────────────────────────────────
{
  check('page imports classifyTokenScannerEvidence', pageSrc.includes("from '@/lib/tokenScannerEvidence'"))
  check('Wallet Detail uses isCurrentHolderLabel', pageSrc.includes('deployerIntel.isCurrentHolderLabel'))
  check('Wallet Detail uses receivedSupplyAtLaunchLabel', pageSrc.includes('deployerIntel.receivedSupplyAtLaunchLabel'))
  check('Wallet Detail uses transferredOrSoldLabel', pageSrc.includes('deployerIntel.transferredOrSoldLabel'))
  check('ClusterMapPanel passes clusterAudit into helper', pageSrc.includes('clusterAudit={clusterAudit}'))
  check('Dev tab overlays holder-tab evidence', pageSrc.includes('holdersVerified: holderState.kind === \'rowsWithPercent\''))
  check('Overview/Risk/Sidebar pass scanEvidence into riskLabelCopy', pageSrc.includes('riskLabelCopy(normalizedRisk.riskLabel, scanEvidence)') && pageSrc.includes('riskLabelCopy(displayCortexVerdict, scanEvidence)') && pageSrc.includes('riskLabelCopy(sidebarRisk.riskLabel, scanEvidence)'))
}

// ── 7. Robinhood chain isolation ───────────────────────────────────────────
{
  check('Robinhood chainId is 4663', ROBINHOOD_EVIDENCE_CHAIN_ID === 4663)
  check('robinhood slug maps to 4663', tokenScannerEvidenceChainId('robinhood', null) === 4663)
  check('explicit 4663 stays 4663', tokenScannerEvidenceChainId('base', 4663) === 4663)
  check('Base is not Robinhood', isRobinhoodEvidenceChain(8453, 'base') === false)
  check('Robinhood isolated flag', classifyTokenScannerEvidence({ holdersVerified: true, holderRows, chainId: 4663, chainSlug: 'robinhood' }).robinhoodIsolated === true)
  check('Base evidence is not robinhoodIsolated', classifyTokenScannerEvidence({ holdersVerified: true, holderRows, chainId: 8453, chainSlug: 'base' }).robinhoodIsolated === false)
}

console.log(`test-token-scanner-evidence: ${passed} checks passed`)
