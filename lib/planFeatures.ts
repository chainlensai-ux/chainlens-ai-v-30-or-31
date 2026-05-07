// Pure plan utilities — no React, no secrets, safe to import from any module.

export type UserPlan = 'free' | 'pro' | 'elite'

const PLAN_FEATURES: Record<string, UserPlan[]> = {
  'token-scanner-basic':    ['free', 'pro', 'elite'],
  'token-scanner-full':     ['pro', 'elite'],
  'wallet-scanner':         ['pro', 'elite'],
  'dev-wallet':             ['pro', 'elite'],
  'whale-alerts':           ['pro', 'elite'],
  'pump-alerts':            ['pro', 'elite'],
  'base-radar':             ['pro', 'elite'],
  'clark-ai-basic':         ['free', 'pro', 'elite'],
  'clark-ai-full':          ['pro', 'elite'],
  'liquidity-safety':       ['pro', 'elite'],
  'portfolio':              ['pro', 'elite'],
  'auto-verdicts':          ['elite'],
  'advanced-whale-alerts':  ['elite'],
  'priority-cortex':        ['elite'],
  'early-access':           ['elite'],
}

export function canAccessFeature(plan: UserPlan, feature: string): boolean {
  const allowed = PLAN_FEATURES[feature]
  if (!allowed) return true
  return allowed.includes(plan)
}

export const PLAN_LABEL: Record<UserPlan, string> = {
  free:  'FREE',
  pro:   'PRO',
  elite: 'ELITE',
}

export const PLAN_COLOR: Record<UserPlan, string> = {
  free:  '#94a3b8',
  pro:   '#a855f7',
  elite: '#f59e0b',
}
