// Re-exports the canonical plan matrix from lib/pricingPlans.ts.
// Keep this file so existing imports (`@/lib/planFeatures`) stay valid.

export type { UserPlan } from './pricingPlans'
export {
  canAccessFeature,
  PLAN_FEATURES,
  PLAN_LABEL,
  PLAN_COLOR,
  PLAN_RANK,
} from './pricingPlans'
