// Wallet Scanner invalid-address UX: one shared client-side EVM address check runs before ANY request
// (main scan, Deep Scan, Robinhood sidecar/rescan); a malformed address gets one inline validation
// message — never "try again later", never a second Robinhood banner, never a loading state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isAddress } from 'viem'
import {
  EVM_WALLET_ADDRESS_RE, INVALID_WALLET_ADDRESS_MESSAGE, checkWalletScanInput, classifyWalletScanError,
  isValidEvmWalletAddress, robinhoodScanErrorBanner, walletScanErrorBanner,
} from '../lib/walletAddressInput.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const LOWER = '0x52908400098527886e0f7030069857d2e4169ee7'
const CHECKSUMMED = '0x52908400098527886E0F7030069857D2E4169EE7'
const MIXED_NON_CHECKSUM = '0x52908400098527886e0F7030069857D2E4169EE7'

test('validator: 0x + exactly 40 hex chars, any case; everything else rejected locally', () => {
  assert.equal(isValidEvmWalletAddress('0x' + 'a'.repeat(39)), false, '39 hex chars')
  assert.equal(isValidEvmWalletAddress('0x' + 'a'.repeat(41)), false, '41 hex chars')
  assert.equal(isValidEvmWalletAddress('0x' + 'g'.repeat(40)), false, 'non-hex')
  assert.equal(isValidEvmWalletAddress('0x52908400098527886e0f7030069857d2e4169eZ7'), false, 'one non-hex char')
  assert.equal(isValidEvmWalletAddress(LOWER.slice(2)), false, 'missing 0x')
  assert.equal(isValidEvmWalletAddress('0X' + LOWER.slice(2)), false, 'uppercase 0X prefix')
  assert.equal(isValidEvmWalletAddress('vitalik.eth'), false)
  assert.equal(isValidEvmWalletAddress(LOWER), true, 'lowercase')
  assert.equal(isValidEvmWalletAddress(CHECKSUMMED), true, 'mixed-case (checksummed)')
  assert.equal(isValidEvmWalletAddress(MIXED_NON_CHECKSUM), true, 'mixed-case without a valid checksum: the server accepts it too')
  assert.equal(isValidEvmWalletAddress('0x' + 'A'.repeat(40)), true, 'uppercase hex')
  assert.equal(isValidEvmWalletAddress(`  ${LOWER}  `), true, 'surrounding whitespace trimmed')
})

test('validator matches the server routes (viem isAddress) on every sample — never rejects what the server accepts', () => {
  for (const s of ['0x' + 'a'.repeat(39), '0x' + 'a'.repeat(41), '0x' + 'g'.repeat(40), LOWER.slice(2), LOWER, CHECKSUMMED, MIXED_NON_CHECKSUM, '0x' + 'A'.repeat(40)]) {
    assert.equal(EVM_WALLET_ADDRESS_RE.test(s), isAddress(s), s)
  }
  for (const route of ['app/api/wallet-scan/route.ts', 'app/api/wallet-scan/robinhood/route.ts']) {
    assert.match(read(route), /if \(!isAddress\(wallet\)\) \{\s*return NextResponse\.json\(\{ error: \{ message: 'Invalid wallet address', category: 'validation' \} \}, \{ status: 400 \}\)/, `${route}: server validation kept (defense in depth)`)
  }
})

test('guard: empty => ignore; malformed => reject with the one message; valid => scan the trimmed address', () => {
  assert.deepEqual(checkWalletScanInput('   '), { action: 'ignore' })
  assert.deepEqual(checkWalletScanInput('0x123'), { action: 'reject', message: INVALID_WALLET_ADDRESS_MESSAGE })
  assert.deepEqual(checkWalletScanInput(` ${CHECKSUMMED} `), { action: 'scan', address: CHECKSUMMED })
  assert.equal(INVALID_WALLET_ADDRESS_MESSAGE, 'Invalid wallet address — enter the full 42-character 0x address.')
})

test('error classification: validation vs auth vs real failure — one validation banner only, never "try again later" for input', () => {
  assert.equal(classifyWalletScanError('Invalid wallet address'), 'validation')
  assert.equal(classifyWalletScanError('Invalid wallet address.'), 'validation')
  assert.equal(classifyWalletScanError(INVALID_WALLET_ADDRESS_MESSAGE), 'validation')
  assert.equal(classifyWalletScanError('Verifying your session — try again in a moment.'), 'auth')
  assert.equal(classifyWalletScanError('anything', 401), 'auth')
  assert.equal(classifyWalletScanError('Request timed out'), 'retry')
  // Main banner.
  assert.equal(walletScanErrorBanner('Invalid wallet address'), INVALID_WALLET_ADDRESS_MESSAGE)
  assert.doesNotMatch(walletScanErrorBanner('Invalid wallet address'), /try again later/)
  assert.equal(walletScanErrorBanner('Verifying your session — try again in a moment.'), 'Verifying your session — try again in a moment.')
  assert.equal(walletScanErrorBanner('Request timed out'), 'Scan failed — try again later. (Request timed out)')
  // Robinhood banner: the same address problem never renders a second banner.
  assert.equal(robinhoodScanErrorBanner('Invalid wallet address'), null)
  assert.equal(robinhoodScanErrorBanner(null), null)
  assert.equal(robinhoodScanErrorBanner('upstream 502'), 'Robinhood Chain scan failed — try again later. (upstream 502)')
  // The production pair from the bug report => exactly ONE banner, the validation one.
  const banners = [walletScanErrorBanner('Invalid wallet address'), robinhoodScanErrorBanner('Invalid wallet address')].filter((b) => b != null)
  assert.deepEqual(banners, [INVALID_WALLET_ADDRESS_MESSAGE])
})

test('page wiring: invalid address fires neither the main scan nor Robinhood, never enters loading (Scan, Deep Scan, Robinhood rescan)', () => {
  const page = read('app/terminal/wallet-scanner/page.tsx')
  const scanFn = page.slice(page.indexOf('async function handleScan('), page.indexOf('async function handleRobinhoodScan('))
  const rejectAt = scanFn.indexOf("if (check.action === 'reject') { setRobinhoodError(null); setError(check.message); return }")
  assert.ok(rejectAt > 0, 'handleScan rejects malformed input')
  assert.ok(scanFn.indexOf('const check = checkWalletScanInput(input)') < rejectAt)
  for (const sideEffect of ['scanInFlightRef.current = true', 'setLoading(true)', 'void handleRobinhoodScan({ jobId })', 'scanWalletV2(']) {
    const at = scanFn.indexOf(sideEffect)
    assert.ok(at > rejectAt, `${sideEffect} only after the guard`)
  }
  // Deep Scan is handleScan('deep'): the guard runs before its session/quota checks too.
  assert.ok(rejectAt < scanFn.indexOf("if (mode === 'deep' && !sessionLoaded)"))
  const rhFn = page.slice(page.indexOf('async function handleRobinhoodScan('), page.indexOf('async function handleRobinhoodScan(') + 2500)
  const rhReject = rhFn.indexOf("if (check.action === 'reject') { setRobinhoodError(null); setError(check.message); return }")
  assert.ok(rhReject > 0 && rhReject < rhFn.indexOf('setRobinhoodLoading(true)') && rhReject < rhFn.indexOf('await fetch('), 'Robinhood sidecar/rescan guarded before loading and fetch')
  assert.match(page, /onRobinhoodRescan=\{\(\) => void handleRobinhoodScan\(\{ refresh: true \}\)\}/)
  // Banners go through the classifier; the old hard-coded wrappers are gone.
  assert.match(page, /\{walletScanErrorBanner\(error\)\}/)
  assert.match(page, /robinhoodScanErrorBanner\(robinhoodError\) != null && !result/)
  assert.doesNotMatch(page, /Scan failed — try again later\. \(\{error\}\)/)
  assert.doesNotMatch(page, /Robinhood Chain scan failed — try again later\. \(\{robinhoodError\}\)/)
})
