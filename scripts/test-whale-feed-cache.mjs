import assert from 'node:assert/strict'
import fs from 'node:fs'

const feedSrc = fs.readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const syncSrc = fs.readFileSync(new URL('../app/api/whale-alerts/sync/route.ts', import.meta.url), 'utf8')
const pageSrc = fs.readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

assert.match(feedSrc, /export function clearWhaleFeedCache\(\)/, 'feed route must export clearWhaleFeedCache')
assert.match(syncSrc, /import \{ clearWhaleFeedCache \} from '@\/app\/api\/whale-alerts\/route'/, 'sync must import clearWhaleFeedCache')
assert.match(syncSrc, /clearWhaleFeedCache\(\)/, 'sync must call clearWhaleFeedCache after a successful run')
assert.match(pageSrc, /function syncWindowParam/, 'UI must map the visible window into a sync-supported window')
assert.match(pageSrc, /window: syncWindowParam\(windowValue\)/, 'runSync must pass the mapped UI window, not a hardcoded 7d')
assert.doesNotMatch(pageSrc, /window: '7d'/, 'runSync must not hardcode window: \'7d\'')

console.log('test-whale-feed-cache.mjs: all assertions passed')
