// Test-only helper: an authenticated caller for the wallet-scan route tests. Replaces only the Supabase token verifier
// (lib/server/requireAuth.ts __setAuthTokenVerifierForTest) — the routes still require a bearer token, and any other
// token is still rejected with 401. Never imported by application code.
import { __setAuthTokenVerifierForTest } from '@/lib/server/requireAuth'

export const WALLET_SCAN_TEST_TOKEN = 'wallet-scan-route-test-token'
export const walletScanTestAuthHeaders = { authorization: `Bearer ${WALLET_SCAN_TEST_TOKEN}` }

export function installWalletScanTestAuth(userId = 'user-a'): void {
  __setAuthTokenVerifierForTest(async (token: string) => ({
    plan: 'free' as const, rawPlan: 'free' as const, trialActive: false, trialEndsAt: null, email: null, settingsRowFound: true,
    userId: token === WALLET_SCAN_TEST_TOKEN ? userId : null,
  }) as Awaited<ReturnType<Parameters<typeof __setAuthTokenVerifierForTest>[0] & {}>>)
}

export function clearWalletScanTestAuth(): void {
  __setAuthTokenVerifierForTest(null)
}
