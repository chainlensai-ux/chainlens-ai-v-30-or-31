import assert from 'node:assert/strict'
import fs from 'node:fs'

// NO-AUTO-RETRY-ON-COLD-OUTAGE, DISCLOSED.
//
// Reported live: "it just started working but 30 seconds ago it came with nothing, I had to keep
// refreshing." Root cause: a cycle landing on a genuine provider outage (finalState
// 'providerUnavailable' — GeckoTerminal and its DexScreener fallback both failed, no last-good
// cache to serve) was left on-screen for the FULL 120s poll interval with zero automatic recovery
// — the only way back was a manual Refresh click, exactly what was reported.
//
// Static source assertions against the real page file, matching this repo's established
// convention for this component (test-base-radar-chain-strict.mjs).

const pageSrc = fs.readFileSync(new URL('../app/terminal/base-radar/page.tsx', import.meta.url), 'utf8')
const pageCode = pageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// Auto-retry must trigger ONLY on a genuine provider outage with zero tokens — never on an honest
// empty-after-filtering result (that's a real answer, not a failure, and retrying it would just
// hammer the backend for the same result).
assert.match(
  pageCode,
  /if \(rd\.finalState === 'providerUnavailable' && rd\.tokens\.length === 0 && autoRetryCountRef\.current < 2\) \{/,
  'auto-retry must only fire for a genuine providerUnavailable outage with zero tokens, never for an honest empty result',
)
// Bounded — must not retry forever (a real, longer outage still falls through to the normal 120s
// poll instead of hammering the backend indefinitely).
assert.match(pageCode, /autoRetryCountRef\.current < 2/, 'auto-retry must be bounded, not infinite')
assert.match(pageCode, /const delayMs = autoRetryCountRef\.current === 0 \? 8_000 : 20_000/, 'auto-retry must back off between attempts, not fire back-to-back')
// A real result (tokens present) or an honest empty state must reset the counter so a LATER
// genuine outage still gets its own retries.
assert.match(pageCode, /autoRetryCountRef\.current = 0/, 'a successful or honestly-empty result must reset the retry counter')

// Must not call fetchData recursively from inside its own initializer (self-reference) — uses the
// same ref-sync pattern already established in this file (effectiveRadarChainRef) instead.
assert.match(pageCode, /const fetchDataRef = useRef<\(\) => void>\(\(\) => \{\}\)/, 'the retry timeout must go through a ref, not a direct self-reference inside fetchData\'s own initializer')
assert.match(pageCode, /useEffect\(\(\) => \{ fetchDataRef\.current = \(\) => \{ void fetchData\(\) \} \}, \[fetchData\]\)/, 'fetchDataRef must be kept in sync with the latest fetchData')

// Manual refresh and a chain switch must both clear any pending auto-retry and reset the counter
// so they don't fight a stale timer or double-fire.
assert.match(pageCode, /function handleManualRefresh\(\) \{\s*\n\s*if \(fetchInFlightRef\.current\) return\s*\n\s*setCountdown\(120\)\s*\n\s*if \(autoRetryTimeoutRef\.current\) clearTimeout\(autoRetryTimeoutRef\.current\)\s*\n\s*autoRetryCountRef\.current = 0/, 'a manual refresh must clear any pending auto-retry timer and reset the counter')
assert.match(pageCode, /setLoadMoreExhausted\(false\)\s*\n\s*if \(autoRetryTimeoutRef\.current\) clearTimeout\(autoRetryTimeoutRef\.current\)\s*\n\s*autoRetryCountRef\.current = 0\s*\n\s*void fetchData\(\)/, 'a chain switch must clear any pending auto-retry timer before starting a fresh fetch for the new chain')

// Unmount must clear the pending retry timer, same as the existing abort-on-unmount fix.
assert.match(pageCode, /abortControllerRef\.current\?\.abort\(\)\s*\n\s*if \(autoRetryTimeoutRef\.current\) clearTimeout\(autoRetryTimeoutRef\.current\)/, 'unmounting mid-retry must clear the pending timer, not fire a fetch against an unmounted component')

console.log('test-base-radar-auto-retry.mjs: all assertions passed')
