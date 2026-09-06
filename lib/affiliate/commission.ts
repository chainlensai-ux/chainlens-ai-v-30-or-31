export const DEFAULT_AFFILIATE_COMMISSION_RATE = 0.20

export function getAffiliateCommissionRate(affiliate: { commission_rate?: unknown } | null | undefined): number {
  const rawRate = affiliate?.commission_rate
  if (rawRate == null) return DEFAULT_AFFILIATE_COMMISSION_RATE
  const configured = Number(rawRate)
  return Number.isFinite(configured) ? configured : DEFAULT_AFFILIATE_COMMISSION_RATE
}
