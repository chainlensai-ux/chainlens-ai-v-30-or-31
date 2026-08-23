import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import type { Session } from '@supabase/supabase-js'
import {
  authCallbackError,
  authRedirectUrl,
  hasRecoveryIntent,
  initialAuthMode,
  resolveSupabaseAuthCallback,
  type AuthCallbackClient,
} from '../lib/authFlow'
import {
  checkPasswordPolicy,
  getPasswordStrength,
  meetsPasswordPolicy,
  PASSWORD_POLICY_MESSAGE,
} from '../lib/authPolicy'

const session = { access_token: 'access', refresh_token: 'refresh', user: { id: 'user-1' } } as Session

function callbackClient(options: {
  exchangeSession?: Session | null
  exchangeError?: string | null
  existingSession?: Session | null
  sessionError?: string | null
} = {}) {
  const calls: { exchangedCodes: string[]; getSessionCount: number } = { exchangedCodes: [], getSessionCount: 0 }
  const client: AuthCallbackClient = {
    auth: {
      async exchangeCodeForSession(code) {
        calls.exchangedCodes.push(code)
        return {
          data: { session: options.exchangeSession === undefined ? session : options.exchangeSession },
          error: options.exchangeError ? { message: options.exchangeError } : null,
        }
      },
      async getSession() {
        calls.getSessionCount += 1
        return {
          data: { session: options.existingSession === undefined ? session : options.existingSession },
          error: options.sessionError ? { message: options.sessionError } : null,
        }
      },
    },
  }
  return { client, calls }
}

describe('Supabase auth callback resolver', () => {
  it('exchanges only the exact PKCE code, never the complete callback URL', async () => {
    const { client, calls } = callbackClient()
    const result = await resolveSupabaseAuthCallback(client, 'https://app.example/auth/callback?code=abc123&next=%2Fterminal')
    assert.deepEqual(calls.exchangedCodes, ['abc123'])
    assert.equal(calls.getSessionCount, 0)
    assert.equal(result.flow, 'pkce')
    assert.equal(result.session, session)
  })

  it('uses the SDK-initialized session for implicit hash callbacks and never attempts a code exchange', async () => {
    const { client, calls } = callbackClient()
    const result = await resolveSupabaseAuthCallback(
      client,
      'https://app.example/auth/callback#access_token=token&refresh_token=refresh&type=signup',
    )
    assert.deepEqual(calls.exchangedCodes, [])
    assert.equal(calls.getSessionCount, 1)
    assert.equal(result.flow, 'implicit-or-existing')
    assert.equal(result.session, session)
  })

  it('recognizes password recovery intent in query and hash callbacks', () => {
    assert.equal(hasRecoveryIntent('https://app.example/reset-password?type=recovery'), true)
    assert.equal(hasRecoveryIntent('https://app.example/reset-password#type=recovery&access_token=x'), true)
    assert.equal(hasRecoveryIntent('https://app.example/reset-password'), false)
  })

  it('returns provider callback errors without attempting session creation', async () => {
    const { client, calls } = callbackClient()
    const href = 'https://app.example/auth/callback?error=access_denied&error_description=User+cancelled'
    const result = await resolveSupabaseAuthCallback(client, href)
    assert.equal(result.error, 'User cancelled')
    assert.deepEqual(calls.exchangedCodes, [])
    assert.equal(calls.getSessionCount, 0)
  })

  it('handles malformed percent text without crashing the auth page', () => {
    assert.equal(authCallbackError('https://app.example/auth?error=%'), '%')
  })
})

describe('auth redirect and route consistency', () => {
  it('keeps callbacks on the origin that initiated authentication', () => {
    assert.equal(
      authRedirectUrl('https://preview.example', '/auth/callback'),
      'https://preview.example/auth/callback',
    )
    assert.equal(
      authRedirectUrl('http://localhost:3000', '/reset-password?type=recovery'),
      'http://localhost:3000/reset-password?type=recovery',
    )
  })

  it('rejects external callback paths and non-web origins', () => {
    assert.throws(() => authRedirectUrl('https://app.example', '//evil.example'))
    assert.throws(() => authRedirectUrl('javascript:alert(1)', '/auth/callback'))
  })

  it('/sign-up opens sign-up mode while all other aliases default to sign-in', () => {
    assert.equal(initialAuthMode('/sign-up'), 'signup')
    assert.equal(initialAuthMode('/sign-in'), 'signin')
    assert.equal(initialAuthMode('/auth'), 'signin')
  })

  it('all live reset-link senders target the reset page with an explicit recovery marker', () => {
    const authPage = readFileSync(new URL('../app/auth/page.tsx', import.meta.url), 'utf8')
    const settingsPage = readFileSync(new URL('../app/terminal/settings/page.tsx', import.meta.url), 'utf8')
    for (const source of [authPage, settingsPage]) {
      assert.match(source, /\/reset-password\?type=recovery/)
      assert.ok(!source.includes('/auth/callback?type=recovery'))
    }
  })

  it('callback and reset pages use the shared dual-flow resolver, never exchange a whole URL', () => {
    const callbackPage = readFileSync(new URL('../app/auth/callback/page.tsx', import.meta.url), 'utf8')
    const resetPage = readFileSync(new URL('../app/reset-password/page.tsx', import.meta.url), 'utf8')
    for (const source of [callbackPage, resetPage]) {
      assert.match(source, /resolveSupabaseAuthCallback/)
      assert.ok(!source.includes('exchangeCodeForSession(window.location.href)'))
      assert.ok(!source.includes('exchangeCodeForSession(url)'))
    }
  })
})

describe('shared password policy', () => {
  it('keeps sign-up and recovery on one exact policy and message', () => {
    assert.equal(meetsPasswordPolicy('Chainlens@2026!'), true)
    assert.equal(meetsPasswordPolicy('password'), false)
    assert.equal(checkPasswordPolicy('NoSymbol123').hasSpecial, false)
    assert.equal(getPasswordStrength('Chainlens@2026!'), 'strong')
    assert.equal(PASSWORD_POLICY_MESSAGE, 'Use at least 10 characters with uppercase, lowercase, a number, and a symbol.')

    const authPage = readFileSync(new URL('../app/auth/page.tsx', import.meta.url), 'utf8')
    const signupRoute = readFileSync(new URL('../app/api/auth/signup/route.ts', import.meta.url), 'utf8')
    const resetPage = readFileSync(new URL('../app/reset-password/page.tsx', import.meta.url), 'utf8')
    for (const source of [authPage, signupRoute, resetPage]) {
      assert.match(source, /authPolicy/)
    }
  })
})
