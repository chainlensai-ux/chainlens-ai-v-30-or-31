import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const helperSource = readFileSync(new URL('../lib/server/whaleAlertScope.ts', import.meta.url), 'utf8')
assert.match(helperSource, /return `\$\{column\}\.is\.null,\$\{column\}\.eq\.\$\{userId\}`/)
assert.match(helperSource, /error\.code === '42703' \|\| error\.code === 'PGRST204'/)
assert.match(helperSource, /missingColumnCode && columns\.some/)
assert.match(helperSource, /const seen = new Set<string>\(\)/)
assert.match(helperSource, /seen\.has\(address\)/)

const feed = readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const sync = readFileSync(new URL('../app/api/whale-alerts/sync/route.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

assert.match(feed, /userOrSystemScope\('owner_user_id', userId\)/)
assert.match(feed, /owner_user_id unavailable; used legacy system-feed read/)
assert.match(sync, /userOrSystemScope\('user_id', authenticatedUser\.userId\)/)
assert.match(sync, /dedupeTrackedWallets/)
assert.match(page, /if \(!res\.ok \|\| !json \|\| json\.ok === false\) \{[\s\S]*?setSyncError[\s\S]*?return/)
assert.match(page, /whale_alerts_last_sync_state_v2/)

console.log('test-whale-alert-scope.mjs: all assertions passed')
