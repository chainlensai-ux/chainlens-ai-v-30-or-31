import { NextRequest } from 'next/server'
import { handleCreateSubscription } from '@/lib/server/paypalCreateSubscription'

// Next.js 16 route modules may only export handlers and segment config.
// The injectable handler lives in lib/server/paypalCreateSubscription.ts.
export async function POST(request: NextRequest) {
  return handleCreateSubscription(request)
}
