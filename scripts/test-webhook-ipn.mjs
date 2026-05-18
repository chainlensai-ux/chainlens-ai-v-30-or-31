#!/usr/bin/env node
/**
 * scripts/test-webhook-ipn.mjs
 *
 * Local-only script: simulate a NOWPayments confirmed IPN webhook.
 * Reads NOWPAYMENTS_IPN_SECRET from .env.local — never prints the secret.
 * Safe to commit (no secrets embedded).
 *
 * Usage:
 *   node scripts/test-webhook-ipn.mjs \
 *     --order-id cl_pro_1748000000000_abc123def456abc123def456abc123de \
 *     --amount 30
 *
 * Optional flags:
 *   --url   Override webhook URL (default: https://www.chainlensai.app/api/webhooks/crypto)
 *           Use http://localhost:3099/api/webhooks/crypto for local dev server testing.
 *   --status  IPN status (default: confirmed — also accepts: finished)
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Load .env.local without requiring dotenv ──────────────────────────────────
function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnvLocal()

// ── Parse CLI args ─────────────────────────────────────────────────────────────
function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null
}

const orderId   = arg('--order-id')
const amountArg = arg('--amount')
const statusArg = arg('--status') || 'confirmed'
const targetUrl = arg('--url')    || 'https://www.chainlensai.app/api/webhooks/crypto'

if (!orderId) {
  console.error([
    '',
    'Usage:',
    '  node scripts/test-webhook-ipn.mjs --order-id <ORDER_ID> --amount <USD>',
    '',
    'Examples:',
    '  node scripts/test-webhook-ipn.mjs \\',
    '    --order-id cl_pro_1748000000000_abc123def456abc123def456abc123de \\',
    '    --amount 30',
    '',
    '  # Test against local dev server:',
    '  node scripts/test-webhook-ipn.mjs \\',
    '    --order-id cl_elite_1748000000000_abc123def456abc123def456abc123de \\',
    '    --amount 60 \\',
    '    --url http://localhost:3099/api/webhooks/crypto',
    '',
  ].join('\n'))
  process.exit(1)
}

// ── Secret ────────────────────────────────────────────────────────────────────
const secret = process.env.NOWPAYMENTS_IPN_SECRET
if (!secret) {
  console.error([
    '',
    'ERROR: NOWPAYMENTS_IPN_SECRET not set.',
    'Add it to .env.local:',
    '  NOWPAYMENTS_IPN_SECRET=your_secret_here',
    '',
  ].join('\n'))
  process.exit(1)
}

// ── Derive amount from order_id if not supplied ───────────────────────────────
function amountFromOrderId(id) {
  const parts = id.split('_')
  if (parts[1] === 'pro')   return 30
  if (parts[1] === 'elite') return 60
  return null
}
const priceAmount = amountArg ? Number(amountArg) : amountFromOrderId(orderId)
if (!priceAmount || isNaN(priceAmount)) {
  console.error('ERROR: Cannot determine amount. Pass --amount 30 or --amount 60.')
  process.exit(1)
}

// ── Build IPN payload (mirrors NOWPayments confirmed IPN structure) ────────────
const fakePaymentId = `test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
const rawPayload = {
  actually_paid:  priceAmount,
  order_id:       orderId,
  payment_id:     fakePaymentId,
  payment_status: statusArg,
  price_amount:   priceAmount,
  price_currency: 'usd',
}

// Sort keys alphabetically — must match webhook's sortObjectKeys exactly.
function sortKeys(obj) {
  const out = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

const body = JSON.stringify(sortKeys(rawPayload))

// ── Sign: HMAC-SHA512 over sorted JSON body ────────────────────────────────────
const sig = crypto.createHmac('sha512', secret).update(body).digest('hex')

console.log('')
console.log('═══ NOWPayments IPN Simulation ═══════════════════════════════')
console.log('order_id    :', orderId)
console.log('payment_id  :', fakePaymentId)
console.log('price_amount:', priceAmount, 'USD')
console.log('status      :', statusArg)
console.log('target URL  :', targetUrl)
console.log('body        :', body)
console.log('sig (first 16):', sig.slice(0, 16) + '…')
console.log('══════════════════════════════════════════════════════════════')
console.log('')

// ── POST to webhook ────────────────────────────────────────────────────────────
function postJson(urlStr, bodyStr, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr)
    const lib  = url.protocol === 'https:' ? https : http
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...extraHeaders,
      },
    }
    const req = lib.request(opts, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end',  () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

let result
try {
  result = await postJson(targetUrl, body, { 'x-nowpayments-sig': sig })
} catch (err) {
  console.error('Request failed:', err.message)
  process.exit(1)
}

console.log('HTTP status :', result.status)
console.log('Response    :', result.body)
console.log('')

if (result.status === 200) {
  let parsed
  try { parsed = JSON.parse(result.body) } catch { parsed = null }
  if (parsed?.ok === true) {
    console.log('✓ Webhook accepted (ok: true).')
    console.log('')
    console.log('Now check in Supabase:')
    console.log('  1. crypto_payments  — status should be "confirmed"')
    console.log('                        payment_id should be:', fakePaymentId)
    console.log('  2. user_settings    — plan should be the stored plan for this order')
    console.log('                        subscription_status should be "active"')
    console.log('  3. affiliate_commissions — if the row had affiliate_id set,')
    console.log('                             a new pending row should exist')
  } else if (parsed?.ok === false) {
    console.log('✗ Webhook returned ok: false (activation failed — check SUPABASE_SERVICE_ROLE_KEY).')
  } else {
    console.log('? Unexpected response body.')
  }
} else if (result.status === 400) {
  console.log('✗ 400 — Signature rejected or empty body.')
  console.log('  Check that NOWPAYMENTS_IPN_SECRET in .env.local matches the NOWPayments dashboard.')
} else if (result.status === 500) {
  console.log('✗ 500 — NOWPAYMENTS_IPN_SECRET missing on server, or Supabase error.')
} else {
  console.log('✗ Unexpected status. Check the response body above.')
}
console.log('')
