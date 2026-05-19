#!/usr/bin/env node
'use strict'

/**
 * Environment variable check for ChainLens AI.
 *
 * Reads .env.local (if present) plus the process environment and reports
 * which required vars are set, which are missing, and which are optional.
 *
 * Exits 0 — all required vars present.
 * Exits 1 — one or more required vars missing.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root  = resolve(__dir, '..')

// Parse a .env file into a key→value map (no shell expansion)
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {}
  const map = {}
  for (const raw of readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (key) map[key] = val
  }
  return map
}

// Merge: .env.local overrides .env, process.env overrides both
const envLocal  = parseEnvFile(resolve(root, '.env.local'))
const envBase   = parseEnvFile(resolve(root, '.env'))
const merged    = { ...envBase, ...envLocal, ...process.env }
const has       = (k) => Boolean(merged[k] && merged[k].length > 0)

// ── Required — app will fail at runtime without these ─────────────────────────
const REQUIRED = [
  // Supabase
  ['NEXT_PUBLIC_SUPABASE_URL',      'Supabase project URL (client)'],
  ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'Supabase anon key (client)'],
  ['SUPABASE_SERVICE_ROLE_KEY',     'Supabase service role key (server-only)'],
  // AI
  ['ANTHROPIC_API_KEY',             'Clark AI — Anthropic API key'],
  // Blockchain data
  ['ZERION_KEY',                    'Portfolio data — Zerion API key'],
  ['GOLDRUSH_API_KEY',              'Token/wallet data — GoldRush (Covalent) API key'],
  ['ALCHEMY_BASE_KEY',              'Base RPC — Alchemy API key'],
  // Payments
  ['NOWPAYMENTS_IPN_SECRET',        'Crypto payment webhook validation secret'],
  // Webhook
  ['ALCHEMY_WEBHOOK_SIGNING_KEY',   'Alchemy webhook signature verification key'],
]

// ── Strongly recommended — degraded functionality without these ───────────────
const RECOMMENDED = [
  ['ALCHEMY_ETHEREUM_KEY',              'ETH wallet history (optional Alchemy key)'],
  ['RESEND_API_KEY',                    'Affiliate confirmation emails'],
  ['LEMONSQUEEZY_WEBHOOK_SECRET',       'LemonSqueezy fiat payment webhooks'],
  ['LEMONSQUEEZY_PRO_VARIANT_ID',       'Pro plan variant ID for checkout'],
  ['LEMONSQUEEZY_ELITE_VARIANT_ID',     'Elite plan variant ID for checkout'],
  ['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'WalletConnect — wallet modal'],
]

// ── Optional / dev overrides ──────────────────────────────────────────────────
const OPTIONAL = [
  ['ALCHEMY_BASE_RPC_URL',    'Override Base RPC URL (uses key by default)'],
  ['BASESCAN_API_KEY',        'Explorer fallback data'],
  ['ETHERSCAN_API_KEY',       'Ethereum explorer data'],
  ['GOPLUS_APP_KEY',          'GoPLus token safety'],
  ['GOPLUS_APP_SECRET',       'GoPLus token safety'],
  ['NEXT_PUBLIC_APP_URL',     'Canonical URL override'],
  ['NOWPAYMENTS_API_KEY',     'NowPayments dashboard API (crypto checkout)'],
  ['AFFILIATE_FROM_EMAIL',    'Affiliate notification from-address'],
  ['AFFILIATE_NOTIFY_EMAIL',  'Affiliate notification recipient'],
  ['WEBHOOKS_ENABLED',        'Enable background webhook processing'],
  ['BETA_ALL_ELITE',          'Dev override — never true in prod'],
]

// ── Report ────────────────────────────────────────────────────────────────────

console.log('')
console.log('  ChainLens AI — Environment Variable Check')
console.log('  ══════════════════════════════════════════')
console.log(`  Source: ${existsSync(resolve(root, '.env.local')) ? '.env.local' : '(process.env only)'}`)
console.log('')

let missingRequired = 0

console.log('  Required:')
for (const [key, desc] of REQUIRED) {
  const ok = has(key)
  if (!ok) missingRequired++
  console.log(`  ${ok ? '✓' : '✗'} ${key.padEnd(38)} ${ok ? 'set' : 'MISSING'} — ${desc}`)
}

console.log('')
console.log('  Recommended:')
for (const [key, desc] of RECOMMENDED) {
  console.log(`  ${has(key) ? '✓' : '~'} ${key.padEnd(38)} ${has(key) ? 'set' : 'not set'} — ${desc}`)
}

console.log('')
console.log('  Optional:')
for (const [key] of OPTIONAL) {
  console.log(`  ${has(key) ? '✓' : '-'} ${key}`)
}

console.log('')
console.log('  ──────────────────────────────────────────')
if (missingRequired === 0) {
  console.log(`  ✓ PASS  All ${REQUIRED.length} required env vars are set\n`)
  process.exit(0)
} else {
  console.log(`  ✗ FAIL  ${missingRequired} required env var(s) missing`)
  console.log(`          Copy .env.example → .env.local and fill in real values.\n`)
  process.exit(1)
}
