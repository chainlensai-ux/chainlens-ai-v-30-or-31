// ONE SOURCE OF TRUTH for plan copy, limits, and feature access.
// Pricing page, Navbar plan badge, FAQ, Clark prompt limits, scan quotas,
// and canAccessFeature all read from here. Do not duplicate plan matrices.

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

export const SCAN_DAILY_LIMITS = { free: 3, pro: 25, elite: 100 } as const
export const SCAN_HISTORY_LIMITS = { free: 5, pro: 30, elite: 100 } as const

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

export function clarkDailyLimit(plan: UserPlan | 'unauth' | null | undefined): number {
  if (plan === 'unauth' || plan == null) return CLARK_DAILY_UNAUTH
  return CLARK_DAILY_LIMITS[plan] ?? CLARK_DAILY_LIMITS.free
}

export function scanDailyLimit(plan: UserPlan): number {
  return SCAN_DAILY_LIMITS[plan]
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
    scansPerDay: number
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
      '3 full scans per day',
      'Token Scanner — market, holders, LP Safety, Risk Engine, and dev checks',
      'Basic Wallet Scanner',
      'Portfolio Intelligence',
      'Watchlist — full access',
      'Clark AI — 3 prompts per day',
      'Basic scan history',
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
      'Higher daily scan limits',
      'Full Token Scanner',
      'Full Wallet Scanner',
      'Portfolio Intelligence',
      'Watchlist — full access',
      'Clark AI — 50 prompts per day',
      'Base Radar',
      'More scan history',
      'Faster scan queue than Free',
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
      'Highest daily scan limits',
      'Clark AI — 300 prompts per day',
      'Faster scan queue',
      'Advanced Wallet Scanner depth where available',
      'Priority access to new chains and scanners',
      'Best limits for power users',
    ],
    note: 'Everything in Pro, plus the highest Clark and scan limits.',
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
      { icon: '🧪', name: 'Token Scanner', href: '/terminal/token-scanner', note: 'Market, holders, LP Safety, Risk Engine, dev checks' },
      { icon: '👛', name: 'Wallet Scanner', href: '/terminal/wallet-scanner', note: 'Basic wallet reads' },
      { icon: '📊', name: 'Portfolio', href: '/terminal/portfolio', note: 'Portfolio Intelligence' },
      { icon: '☆', name: 'Watchlist', href: '/terminal/watchlist', note: 'Full access' },
      { icon: '🤖', name: 'Clark AI', href: '/terminal/clark-ai', note: '3 prompts/day' },
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
      { icon: '👛', name: 'Wallet Scanner', href: '/terminal/wallet-scanner', note: 'Full wallet reads' },
      { icon: '📡', name: 'Base Radar', href: '/terminal/base-radar', note: '' },
      { icon: '🤖', name: 'Clark AI', href: '/terminal/clark-ai', note: '50 prompts/day' },
    ],
  },
  {
    tier: 'ELITE',
    label: 'ELITE',
    color: '#e8c874',
    bg: 'rgba(212,160,23,0.08)',
    border: 'rgba(212,160,23,0.22)',
    tools: [
      { icon: '🤖', name: 'Clark AI', href: '/terminal/clark-ai', note: '300 prompts/day' },
      { icon: '👛', name: 'Wallet Scanner', href: '/terminal/wallet-scanner', note: 'Advanced depth where available' },
      { icon: '⬡', name: 'New chains', href: '/terminal/token-scanner', note: 'Priority access to new scanners' },
    ],
  },
]

export function planFaqWhatIsIncluded(): string {
  return [
    'Free: 3 full scans per day; Token Scanner with market, holders, LP Safety, Risk Engine, and dev checks; Basic Wallet Scanner; Portfolio Intelligence; Watchlist full access; Clark AI at 3 prompts per day; basic scan history.',
    'Pro ($30/month): higher daily scan limits, full Token Scanner, full Wallet Scanner, Portfolio Intelligence, Watchlist, Clark AI at 50 prompts per day, Base Radar, more scan history, and a faster scan queue than Free.',
    'Elite ($60/month): everything in Pro, highest daily scan limits, Clark AI at 300 prompts per day, faster scan queue, advanced Wallet Scanner depth where available, and priority access to new chains and scanners.',
  ].join(' ')
}

export function planFaqProVsElite(): string {
  return 'Pro and Elite share the same live products. Elite raises Clark AI from 50 to 300 prompts per day, raises daily scan limits, speeds the scan queue, and adds advanced Wallet Scanner depth plus priority access to new chains and scanners.'
}

export function planFaqClarkLimits(): string {
  return `Signed-out visitors get ${CLARK_DAILY_UNAUTH} per day. Free gets ${CLARK_DAILY_LIMITS.free}. Pro gets ${CLARK_DAILY_LIMITS.pro}. Elite gets ${CLARK_DAILY_LIMITS.elite}. Unused prompts do not roll over. Free prompts accept normal Clark commands (token, wallet, LP, holders, deployer) and stop when the daily limit is reached.`
}
