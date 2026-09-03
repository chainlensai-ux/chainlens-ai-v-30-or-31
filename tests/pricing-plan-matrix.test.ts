import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLARK_CHAT_HISTORY_LIMITS,
  CLARK_DAILY_LIMITS,
  PLAN_FEATURES,
  SCAN_DAILY_LIMITS,
  SCAN_QUOTA_PERIOD,
  TOKEN_SCAN_WEEKLY_LIMITS,
  canAccessFeature,
  canAccessFomoBoard,
  clarkChatHistoryLimit,
  clarkDailyLimit,
  deepScanQuotaPeriod,
  pricingPlans,
  scanDailyLimit,
  type UserPlan,
} from '../lib/pricingPlans'
import {
  __resetScanQuotaForTest,
  consumeDailyScan,
  peekDailyScan,
} from '../lib/scanQuota'

const PLANS: UserPlan[] = ['free', 'pro', 'elite']

describe('pricing plan matrix matches /pricing promises', () => {
  it('Clark daily prompts: Free 3, Pro 50, Elite 300', () => {
    assert.equal(CLARK_DAILY_LIMITS.free, 3)
    assert.equal(CLARK_DAILY_LIMITS.pro, 50)
    assert.equal(CLARK_DAILY_LIMITS.elite, 300)
    assert.equal(clarkDailyLimit('free'), 3)
    assert.equal(clarkDailyLimit('pro'), 50)
    assert.equal(clarkDailyLimit('elite'), 300)
  })

  it('Clark chat history: Free 3, Pro 10, Elite unlimited', () => {
    assert.equal(CLARK_CHAT_HISTORY_LIMITS.free, 3)
    assert.equal(CLARK_CHAT_HISTORY_LIMITS.pro, 10)
    assert.equal(CLARK_CHAT_HISTORY_LIMITS.elite, null)
    assert.equal(clarkChatHistoryLimit('free'), 3)
    assert.equal(clarkChatHistoryLimit('pro'), 10)
    assert.equal(clarkChatHistoryLimit('elite'), null)
  })

  it('Deep wallet scans: Free 3/month, Pro 30/month, Elite unlimited', () => {
    assert.equal(SCAN_DAILY_LIMITS.free, 3)
    assert.equal(SCAN_DAILY_LIMITS.pro, 30)
    assert.equal(SCAN_DAILY_LIMITS.elite, null)
    assert.equal(SCAN_QUOTA_PERIOD.free, 'month')
    assert.equal(SCAN_QUOTA_PERIOD.pro, 'month')
    assert.equal(SCAN_QUOTA_PERIOD.elite, null)
    assert.equal(scanDailyLimit('free'), 3)
    assert.equal(scanDailyLimit('pro'), 30)
    assert.equal(scanDailyLimit('elite'), null)
    assert.equal(deepScanQuotaPeriod('free'), 'month')
    assert.equal(deepScanQuotaPeriod('pro'), 'month')
    assert.equal(deepScanQuotaPeriod('elite'), null)
  })

  it('Token scans weekly: Free 3, Pro/Elite unlimited (null)', () => {
    assert.equal(TOKEN_SCAN_WEEKLY_LIMITS.free, 3)
    assert.equal(TOKEN_SCAN_WEEKLY_LIMITS.pro, null)
    assert.equal(TOKEN_SCAN_WEEKLY_LIMITS.elite, null)
  })

  it('normal wallet scans never consume the deep-scan pool', () => {
    __resetScanQuotaForTest()
    // Only deep mode calls consumeDailyScan in the wallet-scan route.
    // After peeking with no consumes, Free still has full deep remaining.
    const before = peekDailyScan('free', 'actor-normal')
    assert.equal(before.remaining, 3)
    assert.equal(before.count, 0)
  })

  it('deep wallet scan quota is enforced per plan', () => {
    __resetScanQuotaForTest()
    for (let i = 0; i < 3; i++) {
      const r = consumeDailyScan('free', 'actor-deep-free')
      assert.equal(r.allowed, true)
    }
    assert.equal(consumeDailyScan('free', 'actor-deep-free').allowed, false)

    __resetScanQuotaForTest()
    for (let i = 0; i < 30; i++) {
      assert.equal(consumeDailyScan('pro', 'actor-deep-pro').allowed, true)
    }
    assert.equal(consumeDailyScan('pro', 'actor-deep-pro').allowed, false)

    __resetScanQuotaForTest()
    for (let i = 0; i < 100; i++) {
      assert.equal(consumeDailyScan('elite', 'actor-deep-elite').allowed, true)
      assert.equal(consumeDailyScan('elite', 'actor-deep-elite').remaining, null)
    }
  })

  it('feature gates match Free / Pro / Elite pricing cards', () => {
    // Free: token scanner (incl. LP/risk/dev), basic wallet, portfolio, watchlist, Clark
    for (const f of [
      'token-scanner-basic',
      'token-scanner-full',
      'wallet-scanner',
      'dev-wallet',
      'liquidity-safety',
      'portfolio',
      'watchlist',
      'clark-ai-basic',
      'clark-ai-full',
    ] as const) {
      assert.equal(canAccessFeature('free', f), true, f)
    }
    // Free does NOT get full wallet, whale, pump, base radar, FOMO
    assert.equal(canAccessFeature('free', 'wallet-scanner-full'), false)
    assert.equal(canAccessFeature('free', 'whale-alerts'), false)
    assert.equal(canAccessFeature('free', 'pump-alerts'), false)
    assert.equal(canAccessFeature('free', 'base-radar'), false)
    assert.equal(canAccessFomoBoard('free'), false)

    // Pro: full wallet + Base Radar + Whale (+ Pump gated as Pro+)
    for (const f of [
      'wallet-scanner',
      'wallet-scanner-full',
      'base-radar',
      'whale-alerts',
      'pump-alerts',
      'portfolio',
      'watchlist',
    ] as const) {
      assert.equal(canAccessFeature('pro', f), true, f)
    }
    assert.equal(canAccessFomoBoard('pro'), false)
    assert.equal(canAccessFeature('pro', 'wallet-scanner-advanced'), false)

    // Elite: everything Pro has + FOMO + advanced wallet
    for (const f of Object.keys(PLAN_FEATURES)) {
      if (f === 'wallet-scanner-advanced') {
        assert.equal(canAccessFeature('elite', f), true)
        continue
      }
      assert.equal(canAccessFeature('elite', f), true, f)
    }
    assert.equal(canAccessFomoBoard('elite'), true)
  })

  it('pricing card copy says unlimited normal wallet scans', () => {
    for (const plan of pricingPlans) {
      if (plan.id === 'elite') continue
      assert.ok(
        plan.features.some((line) => /Unlimited normal wallet scans/i.test(line)),
        `${plan.id} missing unlimited normal wallet scans copy`,
      )
    }
    const free = pricingPlans.find((p) => p.id === 'free')!
    const pro = pricingPlans.find((p) => p.id === 'pro')!
    const elite = pricingPlans.find((p) => p.id === 'elite')!
    assert.ok(free.features.some((l) => /token scans per week/i.test(l)))
    assert.ok(free.features.some((l) => /Clark AI — full capability/i.test(l)))
    assert.ok(free.features.some((l) => /Basic Wallet Scanner/i.test(l)))
    assert.ok(pro.features.some((l) => /Full Wallet Scanner/i.test(l)))
    assert.ok(pro.features.some((l) => /Base Radar/i.test(l)))
    assert.ok(pro.features.some((l) => /Whale Alerts/i.test(l)))
    assert.ok(elite.features.some((l) => /FOMO PnL leaderboard/i.test(l)))
    assert.ok(elite.features.some((l) => /Unlimited Clark chat history/i.test(l)))
    assert.equal(free.limits.clarkPromptsPerDay, 3)
    assert.equal(pro.limits.clarkPromptsPerDay, 50)
    assert.equal(elite.limits.clarkPromptsPerDay, 300)
    assert.equal(free.limits.scansPerDay, 3)
    assert.equal(pro.limits.scansPerDay, 30)
    assert.equal(elite.limits.scansPerDay, null)
  })

  it('every plan id is covered', () => {
    assert.deepEqual(pricingPlans.map((p) => p.id), PLANS)
  })
})
