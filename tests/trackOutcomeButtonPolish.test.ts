// Regression tests for the Track Outcome CTA locked/unlocked presentation polish task.
//
// SCOPE, DISCLOSED: this task explicitly forbids a second tracking implementation — these tests
// exist specifically to PROVE that didn't happen: the real `TrackOutcomeButton` still gates on the
// SAME centralized `canTrackOutcome`/`OUTCOME_POLICY.minRisk`, its `save()` handler still calls the
// SAME real API, and no competing component/threshold/state was introduced anywhere in the repo.
// Static source checks (readFileSync + assertions), matching the existing convention already used
// in tests/token-outcomes.test.ts's own "outcome UI renders..."/"outcome storage remains
// separate..." tests for these same React component files — this codebase has no jsdom/testing-
// library rendering setup for a 'use client' component.
//
// Run directly with:
//   npx tsx --test tests/trackOutcomeButtonPolish.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

function listSourceFiles(rootDir: string): string[] {
  const skipDirs = new Set(['node_modules', '.next', '.git'])
  const results: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        walk(path.join(dir, entry.name))
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
      results.push(path.relative(rootDir, path.join(dir, entry.name)))
    }
  }
  walk(rootDir)
  return results
}

const buttonSrc = readFileSync(new URL('../components/outcomes/TrackOutcomeButton.tsx', import.meta.url), 'utf8')

test('locked/unlocked gating still uses the SAME centralized threshold — no competing constant', () => {
  assert.match(buttonSrc, /import \{ canTrackOutcome, OUTCOME_LOCK_COPY, OUTCOME_POLICY \} from '@\/lib\/tokenOutcomes'/, 'must import the real, centralized policy/eligibility check')
  assert.match(buttonSrc, /const eligible = canTrackOutcome\(score\)/, 'eligibility must still be canTrackOutcome(score) — unchanged')
  // Every place this file displays "50+" must derive it from OUTCOME_POLICY.minRisk, never a bare
  // hardcoded "50" literal — proves no second, competing threshold was introduced.
  assert.doesNotMatch(buttonSrc, /['"`][^'"`]*\b50\+/, 'the "50+" copy must never be a hardcoded literal — must always interpolate OUTCOME_POLICY.minRisk')
  const minRiskUses = (buttonSrc.match(/OUTCOME_POLICY\.minRisk/g) ?? []).length
  assert.ok(minRiskUses >= 2, 'OUTCOME_POLICY.minRisk must be reused for both the inline helper and the nearby caption/tooltip copy')
  assert.doesNotMatch(buttonSrc, /TRACK_OUTCOME_MIN_RISK_SCORE|MIN_RISK_SCORE\s*=\s*50/, 'must not declare a second, competing minimum-risk constant')
})

test('save() — the real tracking action — is byte-for-byte unchanged', () => {
  const saveMatch = buttonSrc.match(/async function save\(\) \{[\s\S]*?\n  \}/)
  assert.ok(saveMatch, 'could not locate save()')
  const save = saveMatch[0]
  assert.match(save, /if \(busy \|\| saved \|\| !eligible\) return/, 'the eligibility guard must be unchanged')
  assert.match(save, /if \(!receipt\) \{ setMessage\('Tracking proof unavailable\. Rescan while signed in; if this persists, outcome storage needs configuration\.'\); return \}/, 'the missing-receipt guard must be unchanged')
  assert.match(save, /const result = await outcomeRequest\('POST', \{ receipt \}\)/, 'must still POST the real receipt to the real outcomeRequest helper — never a placeholder')
  assert.match(save, /setSaved\(true\); setMessage\(result\.duplicate \? 'Already tracking this scan\.' : 'Original scan saved\.'\)/, 'success handling must be unchanged')
})

test('outcomeRequest still calls the real, unchanged API endpoint', () => {
  assert.match(buttonSrc, /fetch\(`\/api\/token-outcomes\$\{outcomeId \? `\?id=\$\{encodeURIComponent\(outcomeId\)\}` : ''\}`, \{ method,/, 'must still call the real /api/token-outcomes endpoint')
})

test('the unlocked button onClick is still save — never replaced with a no-op placeholder', () => {
  assert.match(buttonSrc, /onClick=\{save\}/, 'the button element must still wire onClick to the real save handler')
  assert.doesNotMatch(buttonSrc, /onClick=\{\(\) => \{\}\}/, 'must never be a no-op placeholder onClick')
})

test('locked state adds a lock icon, inline helper, and nearby caption — all sourced from the real policy, no fabricated data', () => {
  assert.match(buttonSrc, /function LockIcon/, 'must render a real lock icon')
  assert.match(buttonSrc, /Unlocks at \{OUTCOME_POLICY\.minRisk\}\+ risk/, 'inline helper text must read the exact required copy')
  assert.match(buttonSrc, /Available for higher-risk scans \(\{OUTCOME_POLICY\.minRisk\}\+\)/, 'nearby caption must read the exact required copy')
})

test('why-locked tooltip: exact required title/body, and a dynamic footer using the REAL score prop — never a hardcoded number', () => {
  assert.match(buttonSrc, /Why is this locked\?/, 'tooltip title must be exact')
  assert.match(buttonSrc, /Track Outcome is available for higher-risk scans \(\{OUTCOME_POLICY\.minRisk\}\+\) so ChainLens can measure what happened after the warning\./, 'tooltip body must be exact and use the real policy constant')
  assert.match(buttonSrc, /This token scored \$\{score\}\/100, so tracking is locked for this scan\./, 'tooltip footer must interpolate the real `score` prop this button was passed')
  assert.doesNotMatch(buttonSrc, /This token scored \d+\/100/, 'the footer must never contain a hardcoded score literal')
})

test('tooltip opens on desktop hover AND mobile tap, and closes on outside click', () => {
  assert.match(buttonSrc, /onMouseEnter=\{\(\) => \{ if \(!eligible\) setTooltipOpen\(true\) \}\}/, 'desktop hover-open must be wired')
  assert.match(buttonSrc, /onMouseLeave=\{\(\) => \{ if \(!eligible\) setTooltipOpen\(false\) \}\}/, 'desktop hover-close must be wired')
  assert.match(buttonSrc, /onClick=\{\(\) => \{ if \(!eligible\) setTooltipOpen\(\(o\) => !o\) \}\}/, 'mobile tap-toggle must be wired')
  assert.match(buttonSrc, /document\.addEventListener\('click', onDocClick\)/, 'click-outside-to-close must be wired for mobile')
})

test('locked tap can reach the tooltip toggle — the button itself is aria-disabled, never HTML disabled, when locked (native `disabled` blocks all clicks/taps, including bubbling to the wrapping span)', () => {
  assert.match(buttonSrc, /disabled=\{eligible && \(busy \|\| saved\)\}/, 'disabled must only ever be true on the eligible path (busy/saved) — never simply `!eligible`')
  assert.match(buttonSrc, /aria-disabled=\{!eligible \|\| busy \|\| saved\}/, 'aria-disabled must cover the locked case for accessibility')
})

test('no second Track Outcome component, no duplicate tracking state, anywhere in the repo', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const offenders: string[] = []
  for (const dir of ['app', 'components', 'lib']) {
    const base = path.join(repoRoot, dir)
    for (const relPath of listSourceFiles(base)) {
      const fullRelPath = path.join(dir, relPath)
      if (fullRelPath === path.join('components', 'outcomes', 'TrackOutcomeButton.tsx')) continue
      const contents = readFileSync(path.join(base, relPath), 'utf8')
      if (/function TrackOutcomeCta\b|TRACK_OUTCOME_MIN_RISK_SCORE|function TrackOutcomeWhyLockedTooltip\b/.test(contents)) offenders.push(fullRelPath)
    }
  }
  assert.deepEqual(offenders, [], `found a competing/duplicate Track Outcome implementation in: ${offenders.join(', ')}`)
})

test('Token Scanner still mounts only the real TrackOutcomeButton, at both existing call sites, unchanged', () => {
  const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
  assert.match(pageSrc, /import TrackOutcomeButton from '@\/components\/outcomes\/TrackOutcomeButton'/)
  const mounts = (pageSrc.match(/<TrackOutcomeButton\b/g) ?? []).length
  assert.equal(mounts, 2, 'Token Scanner must mount exactly the two existing real call sites (Solana overview + EVM result) — no new/duplicate mount added')
  assert.match(pageSrc, /<TrackOutcomeButton key=\{sr\.outcomeReceipt \?\? sr\.mintAddress\} score=\{overviewCx\.score\} receipt=\{sr\.outcomeReceipt\} \/>/)
  assert.match(pageSrc, /<TrackOutcomeButton key=\{result\.outcomeReceipt \?\? `\$\{result\.chain\}:\$\{result\.contract\}`\} score=\{result\.riskScore\} receipt=\{result\.outcomeReceipt\} \/>/)
})
