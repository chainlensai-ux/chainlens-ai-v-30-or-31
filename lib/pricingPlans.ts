// ONE SOURCE OF TRUTH for plan copy, limits, and feature access.
// Pricing page, Navbar plan badge, FAQ, Clark prompt limits, scan quotas,
// and canAccessFeature all read from here. Do not duplicate plan matrices.
// "Unlimited normal scans" on pricing means unlimited normal WALLET scans
// (scanMode=normal). Deep wallet scans use SCAN_DAILY_LIMITS + SCAN_QUOTA_PERIOD.

export type UserPlan = 'free' | 'pro' | 'elite'

export const PLAN_RANK: Record<UserPlan, number> = { free: 0, pro: 1, elite: 2 }

export const PLAN_LABEL: Record<UserPlan, string> = {
  free: 'FREE',
  pro: 'PRO',
  elite: 'ELITE',
}

export const PLAN_COLOR: Record<UserPlan, string> = {
  free: '#94a3b8',
  pro: '#a855f7',
  elite: '#f59e0b',
}

export const CLARK_DAILY_LIMITS = { free: 3, pro: 50, elite: 300 } as const
export const CLARK_DAILY_UNAUTH = 3
export const CLARK_DAILY_BY_PLAN: Record<string, number> = {
  free: CLARK_DAILY_LIMITS.free,
  pro: CLARK_DAILY_LIMITS.pro,
  elite: CLARK_DAILY_LIMITS.elite,
  unauth: CLARK_DAILY_UNAUTH,
}

export const SCAN_DAILY_LIMITS: Record<UserPlan, number | null> = {
  free: 3,
  pro: 30,
  elite: null,
}
export const SCAN_HISTORY_LIMITS = { free: 5, pro: 30, elite: 100 } as const

// Token Scanner weekly quota. Free is capped; Pro/Elite unlimited (`null`).
// Separate from deep wallet SCAN_DAILY_LIMITS and from the per-minute TOKEN_RATE_BY_PLAN.
export type TokenScanQuotaPeriod = 'week'
export const TOKEN_SCAN_WEEKLY_LIMITS: Record<UserPlan, number | null> = {
  free: 3,
  pro: null,
  elite: null,
}

export function tokenScanWeeklyLimit(plan: UserPlan): number | null {
  if (Object.prototype.hasOwnProperty.call(TOKEN_SCAN_WEEKLY_LIMITS, plan)) return TOKEN_SCAN_WEEKLY_LIMITS[plan]
  return TOKEN_SCAN_WEEKLY_LIMITS.free
}

export function tokenScanLimitLabel(plan: UserPlan): string {
  const limit = tokenScanWeeklyLimit(plan)
  if (limit == null) return 'Unlimited token scans'
  return `${limit} token scans per week`
}

export function tokenScanLimitReachedMessage(plan: UserPlan, limit: number | null): string {
  if (limit == null) return `Token scan limit reached on ${plan}.`
  return `Weekly token scan limit reached (${limit} token scans per week on ${plan}).`
}

export type DeepScanQuotaPeriod = 'day' | 'month'

export const SCAN_QUOTA_PERIOD: Record<UserPlan, DeepScanQuotaPeriod | null> = {
  free: 'month',
  pro: 'month',
  elite: null,
}

export function deepScanQuotaPeriod(plan: UserPlan): DeepScanQuotaPeriod | null {
  if (Object.prototype.hasOwnProperty.call(SCAN_QUOTA_PERIOD, plan)) return SCAN_QUOTA_PERIOD[plan]
  return SCAN_QUOTA_PERIOD.free
}

export function deepScanLimitLabel(plan: UserPlan): string {
  const limit = SCAN_DAILY_LIMITS[plan]
  const period = deepScanQuotaPeriod(plan)
  if (limit == null || period == null) return 'Unlimited deep scans'
  if (limit === 1 && period === 'day') return '1 deep scan per day'
  const unit = limit === 1 ? '1 deep scan' : `${limit} deep scans`
  return `${unit} per ${period}`
}

export function deepScanRemainingLabel(remaining: number | null, limit: number | null, period: DeepScanQuotaPeriod | null = 'day'): string {
  if (limit == null || period == null) return 'Unlimited'
  const left = remaining ?? 0
  const window = period === 'month' ? 'this month' : 'today'
  if (limit === 1) return left === 1 ? `1 left ${window}` : `0 left ${window}`
  return `${left} of ${limit} left ${window}`
}

export function scanDailyLimitReachedMessage(plan: UserPlan, limit: number | null): string {
  const period = deepScanQuotaPeriod(plan)
  if (limit == null || period == null) return `Deep scan limit reached on ${plan}.`
  const unit = limit === 1 ? '1 deep scan' : `${limit} deep scans`
  const cadence = period === 'month' ? 'Monthly' : 'Daily'
  return `${cadence} deep scan limit reached (${unit} per ${period} on ${plan}).`
}

// Saved Clark chats. `null` = unlimited (Elite). Pro is capped at 10 new chats.
export const CLARK_CHAT_HISTORY_LIMITS: Record<UserPlan, number | null> = {
  free: 3,
  pro: 10,
  elite: null,
}

export const PLAN_FEATURES: Record<string, UserPlan[]> = {
  'token-scanner-basic': ['free', 'pro', 'elite'],
  'token-scanner-full': ['free', 'pro', 'elite'],
  'wallet-scanner': ['free', 'pro', 'elite'],
  'wallet-scanner-full': ['pro', 'elite'],
  'wallet-scanner-advanced': ['elite'],
  'dev-wallet': ['free', 'pro', 'elite'],
  'whale-alerts': ['pro', 'elite'],
  'pump-alerts': ['pro', 'elite'],
  'base-radar': ['pro', 'elite'],
  'clark-ai-basic': ['free', 'pro', 'elite'],
  'clark-ai-full': ['free', 'pro', 'elite'],
  'liquidity-safety': ['free', 'pro', 'elite'],
  'portfolio': ['free', 'pro', 'elite'],
  'watchlist': ['free', 'pro', 'elite'],
}

export function canAccessFeature(plan: UserPlan, feature: string): boolean {
  const allowed = PLAN_FEATURES[feature]
  if (!allowed) return true
  return allowed.includes(plan)
}

export function canAccessFomoBoard(plan: UserPlan | string | null | undefined): boolean {
  return plan === 'elite'
}

export function clarkDailyLimit(plan: UserPlan | 'unauth' | null | undefined): number {
  if (plan === 'unauth' || plan == null) return CLARK_DAILY_UNAUTH
  return CLARK_DAILY_LIMITS[plan] ?? CLARK_DAILY_LIMITS.free
}

export function scanDailyLimit(plan: UserPlan): number | null {
  if (Object.prototype.hasOwnProperty.call(SCAN_DAILY_LIMITS, plan)) return SCAN_DAILY_LIMITS[plan]
  return SCAN_DAILY_LIMITS.free
}

export function clarkChatHistoryLimit(plan: UserPlan | 'unauth' | null | undefined): number | null {
  if (plan === 'unauth' || plan == null) return CLARK_CHAT_HISTORY_LIMITS.free
  if (Object.prototype.hasOwnProperty.call(CLARK_CHAT_HISTORY_LIMITS, plan)) {
    return CLARK_CHAT_HISTORY_LIMITS[plan]
  }
  return CLARK_CHAT_HISTORY_LIMITS.free
}

export function clarkChatHistoryLimitCopy(plan: UserPlan, limit: number): string {
  if (plan === 'pro') return `Pro keeps ${limit} saved chats. Delete one or upgrade to Elite for unlimited history.`
  if (plan === 'free') return `Free keeps ${limit} saved chats. Upgrade to Pro for 10, or Elite for unlimited history.`
  return `Saved chat limit reached (${limit}).`
}

export function isClarkChatHistoryAtLimit(plan: UserPlan | 'unauth' | null | undefined, chatCount: number): boolean {
  const limit = clarkChatHistoryLimit(plan)
  return limit != null && chatCount >= limit
}

/** Lowest paid plan that unlocks a feature, or null if Free can use it. */
export function featureRequiresPlan(feature: string): UserPlan | null {
  const allowed = PLAN_FEATURES[feature]
  if (!allowed || allowed.includes('free')) return null
  if (allowed.includes('pro')) return 'pro'
  return 'elite'
}

export type ClarkPlanFeature =
  | 'token_full_report'
  | 'wallet_scan'
  | 'liquidity_check'
  | 'dev_wallet'
  | 'whale_alerts'
  | 'pump_alerts'
  | 'base_radar_full'
  | 'base_market_preview'

const CLARK_FEATURE_TO_PLAN: Record<ClarkPlanFeature, string> = {
  token_full_report: 'token-scanner-full',
  wallet_scan: 'wallet-scanner',
  liquidity_check: 'liquidity-safety',
  dev_wallet: 'token-scanner-full',
  whale_alerts: 'whale-alerts',
  pump_alerts: 'pump-alerts',
  base_radar_full: 'base-radar',
  base_market_preview: 'token-scanner-basic',
}

export function clarkPlanAllows(plan: string | undefined, feature: ClarkPlanFeature): boolean {
  const p: UserPlan = plan === 'pro' || plan === 'elite' ? plan : 'free'
  return canAccessFeature(p, CLARK_FEATURE_TO_PLAN[feature])
}

export type PricingPlan = {
  id: UserPlan
  name: string
  label: string
  price: string
  priceMonthly: number
  cryptoCheckoutUrl: string | null
  cardCheckoutUrl: string | null
  limits: {
    clarkPromptsPerDay: number
    scansPerDay: number | null
    scanHistory: number
  }
  subtext: string
  sectionTitle: string
  badge?: string
  ctaClass: string
  features: string[]
  note?: string
}

export const pricingPlans: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    label: 'FREE',
    price: '$0',
    priceMonthly: 0,
    cryptoCheckoutUrl: null,
    cardCheckoutUrl: null,
    limits: {
      clarkPromptsPerDay: CLARK_DAILY_LIMITS.free,
      scansPerDay: SCAN_DAILY_LIMITS.free,
      scanHistory: SCAN_HISTORY_LIMITS.free,
    },
    subtext: 'forever free · no card required',
    sectionTitle: "WHAT'S INCLUDED",
    badge: 'START HERE',
    ctaClass: 'cta-free',
    features: [
      'Unlimited normal wallet scans',
      deepScanLimitLabel('free'),
      tokenScanLimitLabel('free'),
      'Token Scanner — market, holders, LP Safety, Risk Engine, and dev checks',
      'Basic Wallet Scanner',
      'Portfolio Intelligence',
      'Watchlist — full access',
      'Clark AI — full capability · 3 prompts per day',
      'Clark chat history — 3 saved chats',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    label: 'PRO',
    price: '$30',
    priceMonthly: 30,
    cryptoCheckoutUrl: '/api/checkout/crypto',
    cardCheckoutUrl: '/api/paypal/create-subscription',
    limits: {
      clarkPromptsPerDay: CLARK_DAILY_LIMITS.pro,
      scansPerDay: SCAN_DAILY_LIMITS.pro,
      scanHistory: SCAN_HISTORY_LIMITS.pro,
    },
    subtext: 'per month',
    sectionTitle: "WHAT'S INCLUDED",
    badge: 'MOST POPULAR',
    ctaClass: 'cta-pro',
    features: [
      'Unlimited normal wallet scans',
      deepScanLimitLabel('pro'),
      'Full Token Scanner',
      'Full Wallet Scanner',
      'Portfolio Intelligence',
      'Watchlist — full access',
      'Clark AI — 50 prompts per day',
      'Clark chat history — 10 saved chats',
      'Base Radar',
      'Whale Alerts',
    ],
  },
  {
    id: 'elite',
    name: 'Elite',
    label: 'ELITE',
    price: '$60',
    priceMonthly: 60,
    cryptoCheckoutUrl: '/api/checkout/crypto',
    cardCheckoutUrl: '/api/paypal/create-subscription',
    limits: {
      clarkPromptsPerDay: CLARK_DAILY_LIMITS.elite,
      scansPerDay: SCAN_DAILY_LIMITS.elite,
      scanHistory: SCAN_HISTORY_LIMITS.elite,
    },
    subtext: 'per month',
    sectionTitle: 'ELITE ADDITIONS',
    badge: 'POWER USERS',
    ctaClass: 'cta-elite',
    features: [
      'Everything in Pro',
      deepScanLimitLabel('elite'),
      'Clark AI — 300 prompts per day',
      'Unlimited Clark chat history',
      'FOMO PnL leaderboard — 24H / 7D / 30D / ALL',
    ],
    note: 'Everything in Pro, plus unlimited deep scans, unlimited Clark chat history, 300 Clark prompts per day, and the FOMO PnL leaderboard.',
  },
]

export function getPricingPlan(id: UserPlan): PricingPlan {
  return pricingPlans.find((p) => p.id === id) ?? pricingPlans[0]
}

export const PRICING_PROOF = [
  'Token Scanner with LP Safety, holders, risk, and dev checks',
  'Wallet Scanner and Portfolio Intelligence',
  'Watchlist on every plan',
  'Clark AI — on-chain analysis, not trading signals',
  'Unlimited normal wallet scans on every plan',
  'Deep wallet scans: 3 / month on Free, 30 / month on Pro, unlimited on Elite',
  'Token scans: 3 / week on Free, unlimited on Pro and Elite',
] as const

export type PlanToolNavItem = { icon: string; name: string; href: string; note: string }

export const PLAN_TOOL_NAV: Array<{
  tier: string
  label: string
  color: string
  bg: string
  border: string
  tools: PlanToolNavItem[]
}> = [
  {
    tier: 'FREE',
    label: 'FREE',
    color: '#67e8f9',
    bg: 'rgba(103,232,249,0.08)',
    border: 'rgba(103,232,249,0.20)',
    tools: [
      { icon: '🧪', name: 'Token Scanner', href: '/terminal/token-scanner', note: '3 token scans/week · market, holders, LP Safety, Risk, dev' },
      { icon: '👛', name: 'Wallet Scanner', href: '/terminal/wallet-scanner', note: 'Unlimited normal wallet scans · 3 deep scans/month' },
      { icon: '📊', name: 'Portfolio', href: '/terminal/portfolio', note: 'Portfolio Intelligence' },
      { icon: '☆', name: 'Watchlist', href: '/terminal/watchlist', note: 'Full access' },
      { icon: '🤖', name: 'Clark AI', href: '/terminal/clark-ai', note: 'Full capability · 3 prompts/day · 3 saved chats' },
    ],
  },
  {
    tier: 'PRO',
    label: 'PRO',
    color: '#c4b5fd',
    bg: 'rgba(139,92,246,0.08)',
    border: 'rgba(139,92,246,0.20)',
    tools: [
      { icon: '🧪', name: 'Token Scanner', href: '/terminal/token-scanner', note: 'Full token analysis' },
      { icon: '👛', name: 'Wallet Scanner', href: '/terminal/wallet-scanner', note: 'Unlimited normal wallet scans · 30 deep scans/month' },
      { icon: '📡', name: 'Base Radar', href: '/terminal/base-radar', note: '' },
      { icon: '🤖', name: 'Clark AI', href: '/terminal/clark-ai', note: '50 prompts/day · 10 saved chats' },
    ],
  },
  {
    tier: 'ELITE',
    label: 'ELITE',
    color: '#e8c874',
    bg: 'rgba(212,160,23,0.08)',
    border: 'rgba(212,160,23,0.22)',
    tools: [
      { icon: '🤖', name: 'Clark AI', href: '/terminal/clark-ai', note: '300 prompts/day · unlimited history' },
      { icon: '🐋', name: 'Whale Alerts', href: '/terminal/whale-alerts', note: 'FOMO Board · most PnL 24H / 7D / 30D / ALL' },
      { icon: '👛', name: 'Wallet Scanner', href: '/terminal/wallet-scanner', note: 'Unlimited normal and deep wallet scans' },
    ],
  },
]

export function planFaqWhatIsIncluded(): string {
  return [
    `Free: unlimited normal wallet scans and ${deepScanLimitLabel('free')}; ${tokenScanLimitLabel('free')}; Token Scanner with market, holders, LP Safety, Risk Engine, and dev checks; Basic Wallet Scanner; Portfolio Intelligence; Watchlist full access; Clark AI full capability at ${CLARK_DAILY_LIMITS.free} prompts per day and ${CLARK_CHAT_HISTORY_LIMITS.free} saved chats.`,
    `Pro ($30/month): unlimited normal wallet scans, ${deepScanLimitLabel('pro')}, full Token Scanner, full Wallet Scanner, Portfolio Intelligence, Watchlist, Clark AI at ${CLARK_DAILY_LIMITS.pro} prompts per day and ${CLARK_CHAT_HISTORY_LIMITS.pro} saved chats, Base Radar, and Whale Alerts.`,
    `Elite ($60/month): everything in Pro, ${deepScanLimitLabel('elite').toLowerCase()}, Clark AI at ${CLARK_DAILY_LIMITS.elite} prompts per day, unlimited Clark chat history, and the FOMO PnL leaderboard (24H / 7D / 30D / ALL).`,
  ].join(' ')
}

export function planFaqProVsElite(): string {
  return `Pro and Elite share Token Scanner, Wallet Scanner, Portfolio, Watchlist, Base Radar, and Whale Alerts. Every plan includes unlimited normal wallet scans. Pro includes ${deepScanLimitLabel('pro')}, ${CLARK_DAILY_LIMITS.pro} Clark prompts per day, and ${CLARK_CHAT_HISTORY_LIMITS.pro} saved Clark chats. Elite adds ${deepScanLimitLabel('elite').toLowerCase()}, ${CLARK_DAILY_LIMITS.elite} Clark prompts per day, unlimited Clark chat history, and the FOMO PnL leaderboard (24H / 7D / 30D / ALL).`
}

export function planFaqClarkLimits(): string {
  return `Signed-out visitors get ${CLARK_DAILY_UNAUTH} per day. Free gets ${CLARK_DAILY_LIMITS.free}. Pro gets ${CLARK_DAILY_LIMITS.pro}. Elite gets ${CLARK_DAILY_LIMITS.elite}. Unused prompts do not roll over. Free keeps ${CLARK_CHAT_HISTORY_LIMITS.free} saved Clark chats, Pro keeps ${CLARK_CHAT_HISTORY_LIMITS.pro}, and Elite is unlimited. Free has Clark's full capability on Free-plan tools (token, wallet, LP, holders, deployer); only the daily prompt count is capped.`
}
