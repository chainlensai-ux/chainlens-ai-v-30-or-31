import { handleEarlyBuyersRequest } from '@/lib/server/earlyBuyers/handler'

export const runtime = 'nodejs'

// Request flow, auth, quotas and logging live in lib/server/earlyBuyers/handler.ts.
export async function POST(request: Request) {
  return handleEarlyBuyersRequest(request)
}
