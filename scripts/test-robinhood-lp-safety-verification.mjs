// Robinhood LP Safety verification-never-fires — regression tests.
//
// Root cause (diagnosis): app/api/token/route.ts's lpProof branch selection used to gate the
// Robinhood-specific branch (which reads _robinhoodLpProofResult — the classification actually
// backed by real Blockscout/RPC evidence) behind `!_proofApplicableEarly`, a check derived from
// `lpControl.proofApplicability` — a value set by the chain-agnostic dex/pool-type classifier
// EARLIER in the pipeline, which the Robinhood overlay never touches. For a niche/new chain whose
// DEX the generic classifier doesn't recognize, proofApplicability silently stayed 'unknown'
// instead of 'applicable' even when resolveRobinhoodLpProof() (called unconditionally for every
// Robinhood scan) had already proven a real burn/lock/wallet-controlled state — so every Robinhood
// scan fell into the generic "skip, proof not applicable" branch regardless of what evidence
// robinhoodLpProof actually found. Verified evidence could never surface: LP Safety always showed
// "LP lock not confirmed" / "LP controller not verified" / Exit Risk "Open Check" / "Partial
// Evidence" even for genuinely burned/wallet-controlled LP.
//
// Fix: the `chain === 'robinhood'` branch is now checked FIRST, independent of the generic
// applicability gate — Robinhood's own resolver already judges its own applicability (chain-
// confirmed pool, concentrated vs. not, LP token resolved vs. not) from real evidence.
//
// A second, related bug: enrichContractFlags() resolved isContract for the first 8 holder rows in
// arbitrary provider order, not ranked by share — so a genuinely dominant holder outside that
// arbitrary slice never got its contract-vs-wallet proof resolved, and classification fell through
// to a generic "contract-vs-wallet proof did not resolve" partial_evidence result even when a
// single extra RPC call would have resolved it. Fixed by sorting unknown rows by pct descending
// before slicing.
//
// Verified (by source contract + pure-logic replication, since these are module-private):
//   1. The Robinhood lpProof branch in route.ts is NOT gated behind the generic applicability
//      check — it is the first branch checked, independent of `_proofApplicableEarly`.
//   2. The generic (eth/base/bnb) applicability-skip behavior is unchanged (regression guard).
//   3. enrichContractFlags-style prioritization resolves the highest-share unknown-isContract row
//      first, never dropping the dominant holder in favor of minor ones when more than 8 rows are
//      unknown.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const routeSrc = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
const proofSrc = readFileSync(new URL('../lib/server/robinhoodLpProof.ts', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ }
  else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

console.log('Section A: the Robinhood lpProof branch is not gated behind the generic applicability check')

// The branch selection block starts at `let lpProof: {...}` and ends at the closing brace before
// `const { lpLockStatus, ... } = lpProof`. Extract it so branch order is checked, not just presence.
const blockStart = routeSrc.indexOf('let lpProof: { lpLockStatus:')
const blockEnd = routeSrc.indexOf('const { lpLockStatus, lpLockAmount, lpUnlockTime, lpLockProvider, lpController: _lpControllerFromProof } = lpProof')
assert.ok(blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart, 'lpProof branch-selection block must be found in route.ts')
const block = routeSrc.slice(blockStart, blockEnd)

const robinhoodBranchIdx = block.indexOf("if (chain === 'robinhood') {")
const genericSkipBranchIdx = block.indexOf('} else if (!_proofApplicableEarly) {')
const ethBaseBnbBranchIdx = block.indexOf("} else if (chain === 'eth' || chain === 'base' || chain === 'bnb') {")

check('the robinhood branch exists in the block', robinhoodBranchIdx !== -1)
check('the generic applicability-skip branch exists in the block', genericSkipBranchIdx !== -1)
check('the eth/base/bnb branch exists in the block', ethBaseBnbBranchIdx !== -1)
check(
  'the robinhood branch is checked BEFORE the generic applicability-skip branch (the actual fix)',
  robinhoodBranchIdx !== -1 && genericSkipBranchIdx !== -1 && robinhoodBranchIdx < genericSkipBranchIdx
)
check(
  'the eth/base/bnb branch still comes after the generic applicability-skip branch (unchanged for other chains)',
  genericSkipBranchIdx !== -1 && ethBaseBnbBranchIdx !== -1 && genericSkipBranchIdx < ethBaseBnbBranchIdx
)
check(
  'the robinhood branch reads _robinhoodLpProofResult.classification directly, not lpProofApplicability',
  /if \(chain === 'robinhood'\) \{[\s\S]*?_robinhoodLpProofResult\?\.classification === 'verified_burned'/.test(block)
)

console.log('\nSection B: the generic applicability-skip logic itself is unchanged for eth/base/bnb')
check(
  'generic skip still sets reasonCode proofNotApplicable',
  block.includes("lpProof = { lpLockStatus: 'unverified', lpLockAmount: null, lpUnlockTime: null, lpLockProvider: null, lpController: 'unknown', reasonCode: 'proofNotApplicable' }")
)
check(
  'generic skip still distinguishes unknown vs. not_applicable vs. no-pool reasons',
  block.includes("lpProofApplicability === 'unknown'") && block.includes("lpProofApplicability === 'not_applicable'")
)

console.log('\nSection C: enrichContractFlags prioritizes the highest-share unknown row')
check(
  'enrichContractFlags sorts unknown rows by pct descending before slicing',
  /const unknown = \[\.\.\.rows\]\s*\n\s*\.filter\(\(row\) => row\.isContract == null && !BURN_ADDRESSES_SET\.has\(row\.address\)\)\s*\n\s*\.sort\(\(a, b\) => \(b\.pct \?\? 0\) - \(a\.pct \?\? 0\)\)\s*\n\s*\.slice\(0, 8\)/.test(proofSrc)
)

// Pure replication of the fixed enrichContractFlags row-selection logic (the RPC call itself is
// mocked out — this only proves which rows get selected for enrichment).
function selectRowsForEnrichment(rows, burnAddresses) {
  const burnSet = new Set(burnAddresses)
  return [...rows]
    .filter((row) => row.isContract == null && !burnSet.has(row.address))
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
    .slice(0, 8)
}

const manyUnknownRows = Array.from({ length: 12 }, (_, i) => ({
  address: `0xholder${String(i).padStart(3, '0')}`,
  balanceRaw: null,
  pct: i === 11 ? 92 : (i + 1), // the dominant holder (92%) is deliberately LAST in provider order
  isContract: null,
}))
const selected = selectRowsForEnrichment(manyUnknownRows, [])
check('dominant 92% holder is included in the first 8 rows selected for enrichment even though it was last in provider order', selected.some((r) => r.pct === 92))
check('exactly 8 rows are selected when more than 8 are unknown', selected.length === 8)
check('the selected rows are the 8 highest-share rows, not the first 8 in provider order', selected.every((r) => r.pct >= 5))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
