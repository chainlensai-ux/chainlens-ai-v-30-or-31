import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CLARK_DAILY_BY_PLAN, CLARK_DAILY_LIMITS } from '../lib/pricingPlans.ts'
import { clarkDailyLimit, clarkDailyQuotaKey, peekClarkDailyQuota, commitClarkDailyQuota, __resetClarkDailyQuotaForTest } from '../lib/clarkDailyQuota.ts'

// Clark/CORTEX audit Item 9: daily Clark quota is durable (KV with process fallback),
// per-user, sourced from pricingPlans, and must survive a process-local Map reset.

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const quotaSrc = fs.readFileSync(new URL('../lib/clarkDailyQuota.ts', import.meta.url), 'utf8')
assert.match(quotaSrc, /CLARK_DAILY_BY_PLAN/, 'daily limits are sourced from pricingPlans, never hardcoded twice')
assert.match(routeSrc, /from '@\/lib\/clarkDailyQuota'/, 'Clark route must consume the durable daily quota helper')
assert.match(routeSrc, /async function checkClarkRate\(/, 'checkClarkRate peeks durable daily usage')
assert.match(routeSrc, /await peekClarkDailyQuota\(actor, planKey\)/, 'daily check is durable, not a process-local Map')
assert.match(routeSrc, /commitDaily: async \(\) => \{ await commitClarkDailyQuota\(actor, planKey\) \}/, 'daily commit is durable')
assert.match(routeSrc, /await rateResult\.commitDaily\(\)/, 'successful quota-consuming replies await the durable commit')
assert.doesNotMatch(routeSrc, /const clarkRateDaily = new Map/, 'process-local daily Map must be gone')
assert.match(routeSrc, /const clarkRateMinute = new Map/, 'short-term per-minute limiter may stay process-local')

assert.equal(clarkDailyLimit('free'), CLARK_DAILY_LIMITS.free)
assert.equal(clarkDailyLimit('pro'), CLARK_DAILY_LIMITS.pro)
assert.equal(clarkDailyLimit('elite'), CLARK_DAILY_LIMITS.elite)
assert.equal(clarkDailyLimit('unauth'), CLARK_DAILY_BY_PLAN.unauth)
assert.equal(clarkDailyLimit('free'), CLARK_DAILY_BY_PLAN.free)

__resetClarkDailyQuotaForTest()
const actor = `quota-test-${Date.now()}`
const first = await peekClarkDailyQuota(actor, 'free')
assert.equal(first.count, 0)
assert.equal(first.limit, CLARK_DAILY_LIMITS.free)
assert.equal(first.remaining, CLARK_DAILY_LIMITS.free)

const committed = await commitClarkDailyQuota(actor, 'free')
assert.equal(committed.count, 1)
assert.equal(committed.remaining, CLARK_DAILY_LIMITS.free - 1)

const peeked = await peekClarkDailyQuota(actor, 'free')
assert.equal(peeked.count, committed.count)

assert.match(clarkDailyQuotaKey('user-1', 'pro'), /^clark:daily:pro:user-1:\d{4}-\d{2}-\d{2}$/)

console.log('test-clark-daily-quota.mjs: all assertions passed')
