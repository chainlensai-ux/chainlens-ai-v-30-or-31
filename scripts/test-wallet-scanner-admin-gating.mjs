import fs from 'node:fs'
import assert from 'node:assert/strict'

const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// SECURITY INVARIANT: admin gating for full_recovery/smart_recovery must be derived from the
// server-verified Bearer token (authInfo.email via walletAuth/getCurrentUserPlanFromBearerToken),
// never from a client-supplied body field. A body.userEmail-trusting check would let any caller
// self-declare admin and unlock Full Recovery / Smart Recovery.
assert.match(route, /const fullRecoveryAllowed = \(authInfo\.email \?\? ''\)\.toLowerCase\(\) === 'chainlensai@gmail\.com'/, 'fullRecoveryAllowed is derived from server-verified authInfo.email')
assert.doesNotMatch(route, /body(?:\?\.|\.)userEmail/, 'route never reads a client-supplied userEmail field for admin authorization')
assert.match(route, /const authInfo = _devBypass[\s\S]{0,200}: await walletAuth\(req\)/, 'authInfo is populated by walletAuth(req), which resolves email from the Authorization header')

// deep mode must remain ungated (it is not admin-only, and must never be downgraded by the
// full_recovery/smart_recovery admin check).
assert.match(route, /walletScanModeResolved: WalletScanMode = rawRequestedMode === 'full_recovery' && !fullRecoveryAllowed \? 'deep' : rawRequestedMode/, 'only full_recovery is downgraded when not admin-allowed; deep is never downgraded by this gate')

// FRONTEND RACE FIX: admin mode requests must wait for the session to finish loading before
// resolving "not admin" — but must never trust a client value for the actual authorization
// (the real Bearer token is still fetched fresh in handleScan for every request).
assert.match(page, /const \[sessionLoaded, setSessionLoaded\] = useState\(false\)/, 'page.tsx tracks whether the initial session load has completed')
assert.match(page, /setSessionLoaded\(true\)/, 'sessionLoaded is set once getSession() resolves (success or failure)')
assert.match(page, /if \(!sessionLoaded\) \{\s*setError\('Verifying your session — try again in a moment\.'\)/, 'handleScan waits for the session to load before rejecting an admin-mode request as unauthorized')
assert.match(page, /const \{ data: \{ session \} \} = await supabase\.auth\.getSession\(\)\s*\n\s*const token = session\?\.access_token/, 'handleScan still fetches a fresh session/token for every request rather than relying on stale client state')

console.log('test-wallet-scanner-admin-gating: all assertions passed')
