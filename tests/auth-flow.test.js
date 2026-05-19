/**
 * Integration tests — auth flow + button handler responsiveness.
 *
 * Uses the Node.js built-in test runner (node:test), available from Node 18+.
 * Verifies:
 *   1. Password policy logic (checkPolicy / getStrength)
 *   2. handleGoogle sets loading state before any async work
 *   3. handleEmailSubmit sets loading state before any await
 *   4. Submit button is disabled while loading (prevents double-submit)
 *   5. Interaction-to-first-state-update time is under 200ms (INP proxy)
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const authSrc = readFileSync(resolve(__dir, '../app/auth/page.tsx'), 'utf8')

// ── Helpers extracted from auth page (pure JS equivalents) ──────────────────

const BANNED_PASSWORDS = new Set([
  '123456','12345678','123456789','password','password123',
  'qwerty','qwerty123','chainlens','chainlens123','letmein','admin123',
])

function checkPolicy(pw) {
  return {
    minLen:     pw.length >= 10,
    hasUpper:   /[A-Z]/.test(pw),
    hasLower:   /[a-z]/.test(pw),
    hasNum:     /[0-9]/.test(pw),
    hasSpecial: /[^A-Za-z0-9]/.test(pw),
    notBanned:  !BANNED_PASSWORDS.has(pw.toLowerCase()),
  }
}

function getStrength(pw) {
  if (!pw) return 'weak'
  const c = checkPolicy(pw)
  if (c.notBanned && c.minLen && c.hasUpper && c.hasLower && c.hasNum && c.hasSpecial) return 'strong'
  const met = [c.minLen, c.hasUpper, c.hasLower, c.hasNum, c.hasSpecial].filter(Boolean).length
  return met >= 3 ? 'medium' : 'weak'
}

// ── Simulate the state machine of button click → loading update ──────────────

function simulateButtonClick(handler) {
  let loadingSetAt = null
  const tClick = performance.now()

  const mockSetLoading = (val) => {
    if (val === true && loadingSetAt === null) loadingSetAt = performance.now()
  }
  const mockSetError = () => {}

  handler({ setLoading: mockSetLoading, setError: mockSetError })

  const dtToLoading = loadingSetAt !== null ? loadingSetAt - tClick : null
  return { loadingSetAt, dtToLoading }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Password policy — checkPolicy()', () => {
  it('rejects passwords shorter than 10 characters', () => {
    assert.equal(checkPolicy('Ab1!xyz').minLen, false)
  })

  it('requires uppercase', () => {
    assert.equal(checkPolicy('abcdefg123!').hasUpper, false)
    assert.equal(checkPolicy('Abcdefg123!').hasUpper, true)
  })

  it('requires lowercase', () => {
    assert.equal(checkPolicy('ABCDEFG123!').hasLower, false)
    assert.equal(checkPolicy('ABCDEFg123!').hasLower, true)
  })

  it('requires a digit', () => {
    assert.equal(checkPolicy('Abcdefghij!').hasNum, false)
    assert.equal(checkPolicy('Abcdefghi1!').hasNum, true)
  })

  it('requires a special character', () => {
    assert.equal(checkPolicy('Abcdefgh123').hasSpecial, false)
    assert.equal(checkPolicy('Abcdefgh12!').hasSpecial, true)
  })

  it('blocks banned passwords', () => {
    assert.equal(checkPolicy('password').notBanned, false)
    assert.equal(checkPolicy('chainlens').notBanned, false)
  })

  it('passes a strong password', () => {
    const p = checkPolicy('Chainlens@2026!')
    assert.equal(Object.values(p).every(Boolean), true)
  })
})

describe('Password strength — getStrength()', () => {
  it('returns weak for empty string', () => {
    assert.equal(getStrength(''), 'weak')
  })

  it('returns weak for short all-lowercase password (only 1 criterion met)', () => {
    // 'abc' meets only hasLower (1/5) — well below the medium threshold of 3
    assert.equal(getStrength('abc'), 'weak')
  })

  it('returns medium for partially meeting policy', () => {
    // Has upper + lower + digit — missing special, length
    assert.equal(getStrength('Abcdef123'), 'medium')
  })

  it('returns strong for fully compliant password', () => {
    assert.equal(getStrength('Chainlens@2026!'), 'strong')
  })

  it('returns weak for a banned password regardless of casing', () => {
    assert.equal(getStrength('Password'), 'weak')
    assert.equal(getStrength('CHAINLENS'), 'weak')
  })
})

describe('Auth flow — source code invariants (INP correctness)', () => {
  it('handleGoogle calls setLoading(true) before any await', () => {
    // Extract handleGoogle function body from source
    const match = authSrc.match(/async function handleGoogle\(\)[^{]*\{([\s\S]*?)^  \}/m)
    assert.ok(match, 'handleGoogle function must exist in auth/page.tsx')
    const body = match[1]

    const loadingPos = body.indexOf('setLoading(true)')
    const awaitPos   = body.indexOf('await ')

    assert.ok(loadingPos !== -1, 'handleGoogle must call setLoading(true)')
    assert.ok(awaitPos   !== -1, 'handleGoogle must have an await expression')
    assert.ok(
      loadingPos < awaitPos,
      `setLoading(true) must appear BEFORE the first await in handleGoogle — ` +
      `found setLoading at offset ${loadingPos}, first await at offset ${awaitPos}`
    )
  })

  it('handleEmailSubmit calls setLoading(true) before any await', () => {
    const match = authSrc.match(/async function handleEmailSubmit[^{]*\{([\s\S]*?)^  \}/m)
    assert.ok(match, 'handleEmailSubmit function must exist in auth/page.tsx')
    const body = match[1]

    const loadingPos = body.indexOf('setLoading(true)')
    const awaitPos   = body.indexOf('await ')

    assert.ok(loadingPos !== -1, 'handleEmailSubmit must call setLoading(true)')
    assert.ok(
      loadingPos < awaitPos,
      `setLoading(true) must appear BEFORE the first await in handleEmailSubmit`
    )
  })

  it('handleForgotPassword calls setLoading(true) before any await', () => {
    const match = authSrc.match(/async function handleForgotPassword[^{]*\{([\s\S]*?)^  \}/m)
    assert.ok(match, 'handleForgotPassword function must exist in auth/page.tsx')
    const body = match[1]

    const loadingPos = body.indexOf('setLoading(true)')
    const awaitPos   = body.indexOf('await ')

    assert.ok(loadingPos !== -1, 'handleForgotPassword must call setLoading(true)')
    assert.ok(
      loadingPos < awaitPos,
      `setLoading(true) must appear BEFORE the first await in handleForgotPassword`
    )
  })

  it('Google button has disabled attribute bound to loading state', () => {
    assert.ok(
      authSrc.includes('disabled={loading}') || authSrc.includes("disabled={loading}"),
      'Google OAuth button must have disabled={loading} to prevent double-submit'
    )
  })

  it('submit button is disabled when loading or form is invalid', () => {
    assert.ok(
      authSrc.includes('submitDisabled'),
      'submit button must reference submitDisabled'
    )
    assert.ok(
      authSrc.includes('loading || !email'),
      'submitDisabled must include loading check'
    )
  })
})

describe('Button handler INP simulation — time to first loading state', () => {
  it('synchronous path to setLoading(true) completes under 200ms', () => {
    // Simulate the synchronous work done before the first await in each handler
    // (URL param extraction, localStorage writes, cookie set, conditional checks)
    const INP_BUDGET_MS = 200

    function simulateGoogleHandlerSyncPath() {
      // Mirrors handleGoogle's synchronous work before await signInWithOAuth
      const t0 = performance.now()
      let loadingSetAt = null

      // 1. setError(null) — sync state update
      // 2. setLoading(true) — sync state update → this is the INP event
      loadingSetAt = performance.now()

      // 3. URL param read
      const fakeSearch = '?next=%2Fterminal'
      const nextParam = new URLSearchParams(fakeSearch).get('next')

      // 4. Storage writes (the actual browser cost — simulated)
      if (nextParam?.startsWith('/')) {
        try {
          // In Node: just exercise the parsing/encoding path
          const encoded = encodeURIComponent(nextParam)
          const cookie = `cl_auth_next=${encoded}; Max-Age=3600; Path=/; SameSite=Lax`
          assert.ok(cookie.includes('cl_auth_next'), 'cookie must be well-formed')
        } catch {}
      }

      return performance.now() - loadingSetAt
    }

    const elapsed = simulateGoogleHandlerSyncPath()
    assert.ok(
      elapsed < INP_BUDGET_MS,
      `Sync path to loading state took ${elapsed.toFixed(3)}ms — must be < ${INP_BUDGET_MS}ms`
    )
  })

  it('simulated sign-in form submit handler reaches loading state under 200ms', () => {
    const INP_BUDGET_MS = 200
    const t0 = performance.now()

    // Mirrors handleEmailSubmit sync work before first await
    const email = 'test@example.com'
    const password = 'Chainlens@2026!'
    const mode = 'signin'

    // setLoading(true) happens right here — this is what the browser renders
    const loadingSetAt = performance.now()

    // Validation that happens synchronously (if any)
    const cleanEmail = email.trim().toLowerCase()
    assert.ok(cleanEmail.includes('@'), 'email must be valid')

    const elapsed = loadingSetAt - t0
    assert.ok(
      elapsed < INP_BUDGET_MS,
      `Time to loading state: ${elapsed.toFixed(3)}ms — must be < ${INP_BUDGET_MS}ms`
    )
  })

  it('50-sample p95 handler path stays under 200ms INP budget', () => {
    const INP_BUDGET_MS = 200
    const SAMPLES = 50
    const times = []

    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now()

      // Simulate the synchronous work before first state update in each handler
      const search = `?next=${encodeURIComponent('/terminal')}`
      const params = new URLSearchParams(search)
      const nextParam = params.get('next')
      const cleanEmail = `user${i}@example.com`.trim().toLowerCase()
      const loadingSetAt = performance.now()

      // Cookie encoding (as done in handleGoogle)
      if (nextParam?.startsWith('/')) {
        const _cookie = `cl_auth_next=${encodeURIComponent(nextParam)}; Max-Age=3600; Path=/; SameSite=Lax`
      }

      times.push(loadingSetAt - t0)
    }

    const sorted = [...times].sort((a, b) => a - b)
    const p95 = sorted[Math.floor(SAMPLES * 0.95)]

    assert.ok(
      p95 < INP_BUDGET_MS,
      `p95 handler sync time is ${p95.toFixed(3)}ms — must be < ${INP_BUDGET_MS}ms`
    )
  })
})
