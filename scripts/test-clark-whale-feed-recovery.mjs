// WHALE FEED RECOVERY LADDER — static source regression checks.
//
// WHY STATIC, DISCLOSED: the ladder lives inside app/api/clark/route.ts's handleClarkWhaleToolCall,
// a Next.js route module whose real dependency graph (Supabase auth, Anthropic, the whale-alerts +
// sync routes, session memory) can't be stood up in a plain unit test — and a route file shouldn't
// export its internals just to be testable. Same "read the real source, assert on it directly"
// convention already used elsewhere in this repo for large orchestration files
// (src/pipeline/*.staticCheck.test.ts). The behavioral half of this fix — intent routing — IS
// covered by real assertions in scripts/test-clark-radar-whale-toolcalls.mjs.
//
// Run: npx tsx scripts/test-clark-whale-feed-recovery.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')

// ── The ladder itself exists and is diagnostics-driven, not a blind retry ──
assert.match(src, /async function resolveClarkWhaleFeed\(/, 'the shared whale recovery ladder must exist')
assert.match(
  src,
  /const rawCount = diag\?\.rawCount \?\? diag\?\.rawRows \?\? 0/,
  'the ladder must read the real /api/whale-alerts diagnostics to decide its next step, never blind-retry',
)
assert.match(
  src,
  /const hiddenByFilters = \(diag\?\.hiddenAsBoring \?\? 0\) \+ \(diag\?\.hiddenByFilter \?\? 0\) \+ \(diag\?\.hiddenAsDust \?\? 0\)/,
  'filter-hidden rows must be counted from real diagnostics fields',
)

// ── Step 2: broaden only when rows genuinely exist but were filtered out ──
assert.match(
  src,
  /if \(rawCount > 0 \|\| hiddenByFilters > 0\) \{/,
  'broadening must be gated on real evidence that rows exist, not attempted unconditionally',
)
assert.match(src, /readFeed\(false\)/, 'the broadened read must actually request interesting=false')

// ── Step 3: sync only when nothing is stored, and never twice ──
assert.match(src, /if \(!syncRan\) \{\n\s*const ok = await runSync\(\)/, 'a sync must run when nothing is stored, and only if one has not already run this call')
assert.match(
  src,
  /POST",\n\s*signal: AbortSignal\.timeout\(15000\),/,
  'the sync call must keep its bounded timeout',
)

// ── Plan/rate-limit handling must be reported, never retried around ──
assert.match(src, /if \(syncRes\.status === 403\) \{ planGated = true/, 'a 403 from sync must be recorded as plan-gated, not retried')
assert.match(src, /syncRes\.status === 429/, 'a 429 cooldown from sync must be handled explicitly')

// ── The dead-end message this fix removes must not come back ──
// Checked against code with `//` comment lines stripped: the phrase legitimately survives inside
// this fix's own root-cause disclosure comment, and asserting over raw source would match that
// comment forever and make this check meaningless.
const codeOnly = src
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')
assert.doesNotMatch(
  codeOnly,
  /No whale alerts matched the current filters\./,
  'the old generic dead-end message must be gone from live code — it blamed filters even when the real cause was an empty store, and told the user to do manually what the ladder now does for them',
)
assert.match(src, /emptyReason: "no_stored_activity" \| "all_filtered" \| "sync_unavailable" \| null/, 'an empty result must carry a real, specific reason')

// ── Honest empties: each reason must state what was actually tried ──
assert.match(src, /I re-read with all filters off and still found nothing tradeable/, 'the all_filtered case must say broadening was already attempted')
assert.match(src, /including in the sync I just ran/, 'the post-sync empty case must say the sync already ran')

// ── "What it's doing" step feed ──
assert.match(src, /function formatClarkWhaleSteps\(/, 'the visible step log must exist')
assert.match(src, /steps\.map\(\(s\) => `\$\{s\.ok \? "✓" : "·"\} \$\{s\.step\} — \$\{s\.detail\}`\)/, 'steps must render from real executed steps')

// ── Directional grouping must never fabricate a side ──
assert.match(src, /function groupClarkWhaleFlow\(/, 'directional grouping must exist')
assert.match(
  src,
  /if \(side === "unknown"\) \{ unknownSide \+= 1; continue \}/,
  'a row with no verified direction must be counted separately, never folded into the requested side',
)
assert.match(src, /unknownSide > 0 \? \["unverified_direction"\] : \[\]/, 'unverified direction must be surfaced as real missing evidence')

// ── Memory reuse must be time-bounded, so stale rows are never shown as live ──
assert.match(src, /const MEMORY_REUSE_WINDOW_MS = 2 \* 60 \* 1000/, 'directional follow-up memory reuse must be time-bounded')
assert.match(
  src,
  /const memoryFresh = sessionMem\.lastWhaleAlertsRows != null/,
  'memory reuse must check real stored rows',
)
assert.match(src, /sessionMem\.lastWhaleAlertsRows = rawAlerts/, 'the real feed rows must be stored for the directional follow-up')

console.log('test-clark-whale-feed-recovery.mjs: all assertions passed')
