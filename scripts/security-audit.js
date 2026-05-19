#!/usr/bin/env node
'use strict'

/**
 * Static security audit for ChainLens AI.
 *
 * Checks:
 *  1. No hardcoded API keys / secrets in source files
 *  2. .gitignore covers all .env files — secrets cannot be committed
 *  3. .env.local is not tracked by git
 *  4. No dangerouslySetInnerHTML usage
 *  5. No eval / exec / child_process usage in app code
 *  6. Wallet-address inputs are validated with regex before use
 *  7. Security headers configured in next.config.ts
 *  8. All known secret env var names accessed only via process.env
 *  9. No NEXT_PUBLIC_ prefix on server-only keys
 * 10. No open redirect using raw user input
 *
 * Exit 0 = all checks pass.  Exit 1 = one or more failures.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { globSync } from 'node:fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const root  = resolve(__dir, '..')

function read(rel) { return readFileSync(resolve(root, rel), 'utf8') }

// ── Collect source files (app + components + lib, excluding .next / node_modules) ──
function srcFiles(ext = ['ts', 'tsx', 'js', 'mjs']) {
  const results = []
  const dirs = ['app', 'components', 'lib', 'scripts']
  for (const dir of dirs) {
    const abs = resolve(root, dir)
    if (!existsSync(abs)) continue
    try {
      const out = execSync(
        `find "${abs}" -type f \\( ${ext.map(e => `-name "*.${e}"`).join(' -o ')} \\)`,
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      )
      results.push(...out.trim().split('\n').filter(Boolean))
    } catch { /* empty dir */ }
  }
  return results
}

function readAll(files) { return files.map(f => ({ file: f, src: readFileSync(f, 'utf8') })) }

// ── Checks ────────────────────────────────────────────────────────────────────

const checks = []
let failures = 0

function check(id, description, pass, detail = '') {
  checks.push({ id, description, pass, detail })
  if (!pass) failures++
}

const files = srcFiles()
const sources = readAll(files)

// 1. No hardcoded API key literals ─────────────────────────────────────────────
// Pattern: assignment of a string that looks like a real key (30+ chars, no spaces)
// Excludes: process.env, test fixtures with obvious fake values, comments
const HARDCODED_RE = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"`](?!process\.env)[A-Za-z0-9_\-\.]{20,}['"`]/i
const hardcodedHits = sources.filter(({ file, src }) => {
  // Skip test/scripts that use obvious placeholders
  if (file.includes('/scripts/')) return false
  const lines = src.split('\n')
  return lines.some((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false
    if (line.includes('process.env')) return false
    if (line.includes('placeholder') || line.includes('example') || line.includes('TODO')) return false
    return HARDCODED_RE.test(line)
  })
})
check('no-hardcoded-secrets', 'No hardcoded API keys or secrets in source files',
  hardcodedHits.length === 0,
  hardcodedHits.map(h => `  → ${h.file.replace(root, '')}`).join('\n'))

// 2. .gitignore covers .env files ──────────────────────────────────────────────
const gitignore = read('.gitignore')
const gitignoreHasConflicts = gitignore.includes('<<<<<<<') || gitignore.includes('>>>>>>>')
const gitignoreCoversEnv    = !gitignoreHasConflicts &&
  (gitignore.includes('.env\n') || gitignore.includes('.env.*') || gitignore.includes('.env.local'))

check('gitignore-no-conflicts', '.gitignore has no unresolved merge conflict markers', !gitignoreHasConflicts)
check('gitignore-covers-env',   '.gitignore covers .env secret files', gitignoreCoversEnv)

// 3. .env.local is not tracked by git ─────────────────────────────────────────
let envTracked = false
try {
  const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
  envTracked = tracked.split('\n').some(f => f.startsWith('.env') && !f.includes('.env.example'))
} catch { /* not a git repo or no files */ }
check('env-not-tracked', '.env.local (and variants) are not tracked by git', !envTracked)

// 4. No dangerouslySetInnerHTML ────────────────────────────────────────────────
// Only check app/ and components/ — not audit/build scripts
const xssHits = sources.filter(({ file, src }) =>
  (file.includes('/app/') || file.includes('/components/')) &&
  src.includes('dangerouslySetInnerHTML'))
check('no-xss-unsafe-html', 'No dangerouslySetInnerHTML in app/components source files',
  xssHits.length === 0,
  xssHits.map(h => `  → ${h.file.replace(root, '')}`).join('\n'))

// 5. No eval/exec/child_process in app code ────────────────────────────────────
const EXEC_RE = /\beval\s*\(|\bnew\s+Function\s*\(|require\s*\(\s*['"]child_process['"]\s*\)/
const execHits = sources.filter(({ file, src }) => {
  if (file.includes('/scripts/security-audit')) return false // this file uses execSync
  if (file.includes('/scripts/')) return false               // scripts are allowed
  return EXEC_RE.test(src)
})
check('no-code-injection', 'No eval/Function constructor/child_process in app code',
  execHits.length === 0,
  execHits.map(h => `  → ${h.file.replace(root, '')}`).join('\n'))

// 6. Wallet addresses validated before use ─────────────────────────────────────
// Validation may be in the route itself OR in the lib it calls (walletSnapshot.ts).
// We verify the canonical validation site: lib/server/walletSnapshot.ts validates
// address with /^0x[0-9a-fA-F]{40}$/i before any API call.
const walletSnapshotSrc = sources.find(({ file }) => file.includes('walletSnapshot'))?.src ?? ''
const walletValidated = /\/\^0x\[0-9a-fA-F\]\{40\}/.test(walletSnapshotSrc) ||
  walletSnapshotSrc.includes('^0x[0-9a-fA-F]{40}')
// Also confirm scan-holder route validates directly
const scanHolderSrc = sources.find(({ file }) => file.includes('scan-holder'))?.src ?? ''
const scanHolderValidated = scanHolderSrc.includes('^0x[a-fA-F0-9]{40}$')
check('wallet-address-validation', 'Wallet address inputs validated with hex regex before API calls',
  walletValidated && scanHolderValidated)

// 7. Security headers in next.config.ts ────────────────────────────────────────
const nextCfg = read('next.config.ts')
check('security-headers', 'Security headers (X-Frame-Options, X-Content-Type-Options) in next.config.ts',
  nextCfg.includes('X-Frame-Options') && nextCfg.includes('X-Content-Type-Options'))

// 8. Server-only keys accessed via process.env only ────────────────────────────
const SERVER_ONLY_KEYS = ['ANTHROPIC_API_KEY', 'ZERION_KEY', 'GOLDRUSH_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'ALCHEMY_BASE_KEY', 'ALCHEMY_ETHEREUM_KEY',
  'RESEND_API_KEY', 'NOWPAYMENTS_IPN_SECRET', 'ALCHEMY_WEBHOOK_SIGNING_KEY']

const serverKeyClientLeaks = []
const clientSources = sources.filter(({ file }) =>
  !file.includes('/app/api/') && !file.includes('/lib/server/') && !file.includes('/scripts/'))

for (const key of SERVER_ONLY_KEYS) {
  const leaks = clientSources.filter(({ src }) =>
    src.includes(key) && !src.includes(`process.env.${key}`) && !src.includes(`NEXT_PUBLIC_`))
  if (leaks.length) serverKeyClientLeaks.push(...leaks.map(l => `${key} in ${l.file.replace(root, '')}`))
}
check('server-keys-not-in-client', 'Server-only secret keys not referenced in client components',
  serverKeyClientLeaks.length === 0,
  serverKeyClientLeaks.map(s => `  → ${s}`).join('\n'))

// 9. No NEXT_PUBLIC_ prefix on server secrets ──────────────────────────────────
const publicSecretHits = sources.filter(({ src }) =>
  /NEXT_PUBLIC_(ANTHROPIC|ZERION|GOLDRUSH|ALCHEMY_BASE_KEY|ALCHEMY_ETHEREUM|RESEND|SERVICE_ROLE|IPN_SECRET|SIGNING_KEY)/i.test(src))
check('no-public-server-keys', 'Server-only keys not accidentally prefixed with NEXT_PUBLIC_',
  publicSecretHits.length === 0,
  publicSecretHits.map(h => `  → ${h.file.replace(root, '')}`).join('\n'))

// 10. Open redirect: user input not used directly in redirect() ────────────────
// Check that redirect/window.location calls validate input starts with /
const redirectSources = sources.filter(({ file }) =>
  file.includes('/app/api/auth') || file.includes('/middleware'))
const badRedirects = redirectSources.filter(({ src }) => {
  const lines = src.split('\n')
  return lines.some(line =>
    line.includes('redirect(') && line.includes('searchParams') &&
    !line.includes("startsWith('/')") && !line.includes('startsWith("/")'))
})
check('no-open-redirect', 'No open redirect using raw searchParams without path validation',
  badRedirects.length === 0,
  badRedirects.map(h => `  → ${h.file.replace(root, '')}`).join('\n'))

// ── Report ────────────────────────────────────────────────────────────────────

console.log('')
console.log('  ChainLens AI — Security Audit')
console.log('  ══════════════════════════════')
console.log(`  Checks: ${checks.filter(c => c.pass).length} passed  ${failures} failed  (${checks.length} total)`)
console.log('')

for (const c of checks) {
  const icon = c.pass ? '✓' : '✗'
  console.log(`  ${icon} ${c.description}`)
  if (!c.pass && c.detail) console.log(c.detail)
}

console.log('')
if (failures === 0) {
  console.log('  ✓ PASS  All security checks passed\n')
  process.exit(0)
} else {
  console.log(`  ✗ FAIL  ${failures} security check(s) failed\n`)
  process.exit(1)
}
