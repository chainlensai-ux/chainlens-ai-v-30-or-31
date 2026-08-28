import assert from 'node:assert/strict'
import fs from 'node:fs'

const feedSrc = fs.readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const syncSrc = fs.readFileSync(new URL('../app/api/whale-alerts/sync/route.ts', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')
const planSrc = fs.readFileSync(new URL('../lib/usePlan.tsx', import.meta.url), 'utf8')
const authSrc = fs.readFileSync(new URL('../app/auth/page.tsx', import.meta.url), 'utf8')

assert.match(feedSrc, /export function clearWhaleFeedCache\(\)/, 'feed route must export clearWhaleFeedCache')
assert.match(syncSrc, /import \{ clearWhaleFeedCache \} from '@\/app\/api\/whale-alerts\/route'/, 'sync must import clearWhaleFeedCache')
assert.match(syncSrc, /clearWhaleFeedCache\(\)/, 'sync must call clearWhaleFeedCache after a successful run')
assert.match(pageSrc, /function syncWindowParam/, 'UI must map the visible window into a sync-supported window')
assert.match(pageSrc, /window: syncWindowParam\(windowValue\)/, 'runSync must pass the mapped UI window, not a hardcoded 7d')
assert.doesNotMatch(pageSrc, /window: '7d'/, 'runSync must not hardcode window: 7d')
assert.match(pageSrc, /AbortSignal\.timeout/, 'loadAlerts must abort the GET')
assert.match(pageSrc, /Not scanned yet/, 'page must contain Not scanned yet')
assert.match(planSrc, /GET_SESSION_TIMEOUT_MS/, 'usePlan must timeout getSession')
assert.match(authSrc, /getSession_timeout/, 'auth page must timeout getSession')

console.log('test-whale-feed-cache.mjs: all assertions passed')
