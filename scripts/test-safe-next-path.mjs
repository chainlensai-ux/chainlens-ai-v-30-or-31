// Test for lib/safeNextPath.ts's isSafeInternalPath — the open-redirect guard added for the
// post-auth "?next=" redirect target used by app/auth/page.tsx and app/auth/callback/page.tsx.
//
// Run: node scripts/test-safe-next-path.mjs

import assert from 'node:assert'
import { isSafeInternalPath } from '../lib/safeNextPath.ts'

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed++
}

// Legitimate internal paths must still work.
check('root path allowed', isSafeInternalPath('/') === true)
check('simple internal path allowed', isSafeInternalPath('/terminal') === true)
check('internal path with query string allowed', isSafeInternalPath('/terminal/base-radar?chain=base') === true)
check('internal path with encoded characters allowed', isSafeInternalPath('/pricing?ref=abc%20123') === true)

// Open-redirect bypass vectors must be rejected.
check('protocol-relative URL rejected', isSafeInternalPath('//evil.example') === false)
check('protocol-relative URL with path rejected', isSafeInternalPath('//evil.example/phish') === false)
check('backslash-prefixed bypass rejected', isSafeInternalPath('/\\evil.example') === false)
check('absolute https URL rejected', isSafeInternalPath('https://evil.example') === false)
check('absolute http URL rejected', isSafeInternalPath('http://evil.example') === false)
check('bare hostname rejected', isSafeInternalPath('evil.example') === false)
check('empty string rejected', isSafeInternalPath('') === false)
check('null rejected', isSafeInternalPath(null) === false)
check('undefined rejected', isSafeInternalPath(undefined) === false)

console.log(`test-safe-next-path.mjs: all ${passed} assertions passed`)
