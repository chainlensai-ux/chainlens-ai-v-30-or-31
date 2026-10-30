// Unavailable-reason wording: lots priced from market estimates are never described as verified, and
// outgoing transfers with no matching buy are never described as sales.
//   npx tsx --test app/frontend/lib/buildWalletPnlViewModel.pricingBasisWording.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCanonicalUnavailableReason, formatFullWalletUnavailableReason } from './buildWalletPnlViewModel'
import type { PnlReconciliationSummary } from '@/src/lib/pnlReconciliation'

const summary = (audit: Record<string, unknown>, missingEvidenceCount = 0) =>
  ({ missingEvidenceCount, publicPnlGateAudit: { verifiedClosedLots: 7, structuralClosedLots: 45, verifiedPricingCoverage: 0.156, unmatchedSellCount: 0, unmatchedBuyCount: 0, blockingReasons: [], ...audit } }) as unknown as PnlReconciliationSummary

test('estimated lots: "priced", with the transaction-priced count, never "verified"', () => {
  const text = formatCanonicalUnavailableReason(summary({ transactionPricedVerifiedLots: 0, estimatedVerifiedLots: 7 }))
  assert.match(text, /7 of 45 closed lots priced, 0 from their own transactions/)
  assert.match(text, /Pricing coverage 15\.6% is below the 50% gate/)
  assert.doesNotMatch(text, /verified/i)
})

test('all lots transaction-priced, or split unknown: existing "verified" wording', () => {
  assert.match(formatCanonicalUnavailableReason(summary({ transactionPricedVerifiedLots: 7, estimatedVerifiedLots: 0 })), /7 of 45 closed lots verified/)
  assert.match(formatCanonicalUnavailableReason(summary({})), /7 of 45 closed lots verified/)
})

test('unmatched outgoing transfers are not called sells', () => {
  assert.match(formatCanonicalUnavailableReason(summary({ unmatchedSellCount: 32 })), /32 outgoing transfers with no matching buy\./)
  assert.equal(formatFullWalletUnavailableReason(summary({ unmatchedSellCount: 1 })), '1 outgoing transfer with no matching buy prevents complete-wallet verification')
  assert.doesNotMatch(formatCanonicalUnavailableReason(summary({ unmatchedSellCount: 32 })), /sell/)
})
