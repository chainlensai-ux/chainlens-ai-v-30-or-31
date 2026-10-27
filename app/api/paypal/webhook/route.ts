import { NextRequest } from 'next/server'
import { handlePayPalWebhook } from '@/lib/server/paypalWebhook'

// Next.js 16 route modules may only export handlers and segment config.
// Signature checks, idempotency and plan transitions stay in lib/server/paypalWebhook.ts.
export async function POST(request: NextRequest) {
  return handlePayPalWebhook(request)
}
