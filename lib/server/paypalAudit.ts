// PAYPAL PAYMENT AUDIT, DISCLOSED (PayPal payments end-to-end audit task): a single structured
// record per checkout-creation attempt or webhook delivery, logged server-side only (never returned
// in an API response — this is an internal trace, not public data) so a support/ops engineer can
// reconstruct exactly what happened to a given user's plan without grepping unstructured log lines.
// Mirrors this codebase's existing audit-object convention (walletScanPerformanceAudit,
// robinhoodTokenEvidenceAudit, solanaHolderConcentrationAudit) — one typed shape, one log call.

export type PaypalPaymentAudit = {
  userId: string | null
  requestedPlan: 'pro' | 'elite' | null
  paypalPlanId: string | null
  checkoutCreated: boolean
  webhookReceived: boolean
  webhookVerified: boolean
  eventType: string | null
  subscriptionId: string | null
  previousPlan: 'free' | 'pro' | 'elite' | null
  newPlan: 'free' | 'pro' | 'elite' | null
  idempotencyHit: boolean
  failureReason: string | null
}

export function emptyPaypalPaymentAudit(): PaypalPaymentAudit {
  return {
    userId: null,
    requestedPlan: null,
    paypalPlanId: null,
    checkoutCreated: false,
    webhookReceived: false,
    webhookVerified: false,
    eventType: null,
    subscriptionId: null,
    previousPlan: null,
    newPlan: null,
    idempotencyHit: false,
    failureReason: null,
  }
}

// Server-side only — never send this to the client. Structured so it's grep/parse-friendly in log
// aggregation ("paypalPaymentAudit" tag), without ever including a PayPal secret or full JWT.
export function logPaypalPaymentAudit(audit: PaypalPaymentAudit): void {
  // eslint-disable-next-line no-console
  console.log('paypalPaymentAudit', JSON.stringify(audit))
}
