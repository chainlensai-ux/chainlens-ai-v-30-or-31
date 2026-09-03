// CHECKOUT FLOW AUDIT, DISCLOSED (card/PayPal checkout fix task): a single structured record per
// checkout-creation attempt across every payment method (PayPal, crypto, card), logged server-side
// only — never returned in an API response. Mirrors this codebase's existing audit-object
// convention (paypalPaymentAudit, walletScanPerformanceAudit, robinhoodTokenEvidenceAudit): one
// typed shape, one log call, grep/parse-friendly in log aggregation.
//
// This exists specifically because "Card" and "PayPal" used to be the same endpoint
// (cardCheckoutUrl === '/api/paypal/create-subscription') with no record anywhere of which label
// the user actually clicked versus which provider actually ran — redirectsToPaypalLogin and
// cardProviderConfigured make that distinction explicit and auditable going forward.

export type CheckoutProvider = 'paypal' | 'nowpayments' | 'card' | null

export type CheckoutFlowAudit = {
  userIdPresent: boolean
  selectedPlan: 'pro' | 'elite' | null
  selectedPaymentMethod: 'card' | 'paypal' | 'crypto' | null
  provider: CheckoutProvider
  checkoutUrlCreated: boolean
  isSubscription: boolean
  billingInterval: 'monthly' | 'one_time' | null
  paypalPlanId: string | null
  cardProviderConfigured: boolean
  redirectsToPaypalLogin: boolean
  webhookExpected: boolean
  finalStatus: 'created' | 'failed' | 'blocked' | null
  failureReason: string | null
}

export function emptyCheckoutFlowAudit(): CheckoutFlowAudit {
  return {
    userIdPresent: false,
    selectedPlan: null,
    selectedPaymentMethod: null,
    provider: null,
    checkoutUrlCreated: false,
    isSubscription: false,
    billingInterval: null,
    paypalPlanId: null,
    cardProviderConfigured: false,
    redirectsToPaypalLogin: false,
    webhookExpected: false,
    finalStatus: null,
    failureReason: null,
  }
}

// Server-side only — never send this to the client. Structured so it's grep/parse-friendly in log
// aggregation ("checkoutFlowAudit" tag), without ever including a PayPal/provider secret.
export function logCheckoutFlowAudit(audit: CheckoutFlowAudit): void {
  console.log('checkoutFlowAudit', JSON.stringify(audit))
}
