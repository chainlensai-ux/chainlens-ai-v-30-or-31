// Connect-wallet persistence: the session must restore without a reconnect click.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { decodeWagmiCookieHeader } from '../lib/wallet.ts'

const walletSrc = fs.readFileSync(new URL('../lib/wallet.ts', import.meta.url), 'utf8')
const connectSrc = fs.readFileSync(new URL('../components/ConnectWallet.tsx', import.meta.url), 'utf8')
const layoutSrc = fs.readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')
const providersSrc = fs.readFileSync(new URL('../app/providers.tsx', import.meta.url), 'utf8')
const settingsSrc = fs.readFileSync(new URL('../app/terminal/settings/page.tsx', import.meta.url), 'utf8')

{
  assert.match(walletSrc, /localStorage\.getItem\(key\)/, 'wagmi storage must read localStorage')
  assert.match(walletSrc, /localStorage\.setItem\(key, value\)/, 'wagmi storage must write localStorage')
  assert.match(walletSrc, /max-age=\$\{THIRTY_DAYS\}/, 'cookie copy must still last 30 days when it fits')
  assert.match(walletSrc, /encodeURIComponent\(value\)/, 'cookie values must be encoded')
  assert.match(walletSrc, /COOKIE_BUDGET/, 'oversized wagmi stores must not be forced into a 4KB cookie')
  assert.match(walletSrc, /export function decodeWagmiCookieHeader/, 'layout needs a decoder for encoded wagmi cookies')
}

{
  const encoded = decodeWagmiCookieHeader('wagmi.store=%7B%22state%22%3A%7B%22chainId%22%3A8453%7D%7D; other=keep')
  assert.ok(encoded?.includes('wagmi.store={"state":{"chainId":8453}}'), 'encoded wagmi cookie must decode for cookieToInitialState')
  assert.ok(encoded?.includes('other=keep'), 'non-wagmi cookies must be left alone')
  const raw = decodeWagmiCookieHeader('wagmi.store={"state":{"chainId":8453}}')
  assert.equal(raw, 'wagmi.store={"state":{"chainId":8453}}', 'already-decoded cookies must pass through')
  assert.equal(decodeWagmiCookieHeader(null), undefined)
}

{
  assert.match(layoutSrc, /decodeWagmiCookieHeader/, 'root layout must decode wagmi cookies before hydration')
  assert.match(layoutSrc, /cookieToInitialState\(wagmiConfig, cookie\)/)
  assert.match(providersSrc, /reconnectOnMount/)
}

{
  assert.match(connectSrc, /useReconnect/, 'silent restore must use wagmi reconnect, not a permission prompt')
  assert.match(connectSrc, /reconnectAsync\(\)/, 'auto-restore must call reconnectAsync()')
  const silentBlock = connectSrc.slice(
    connectSrc.indexOf('attempting silent reconnect'),
    connectSrc.indexOf('attempting silent reconnect') + 1200,
  )
  assert.doesNotMatch(silentBlock, /connectAsync\(\{ connector \}\)/, 'silent restore must not call connectAsync (that prompts wallet_requestPermissions)')
  assert.match(connectSrc, /readBestLocalWallet/, 'device + account wallet keys must be merged')
  assert.match(connectSrc, /persistLocalWallet/, 'device key must always be written so login cannot hide the wallet')
  assert.match(connectSrc, /Wallet connection is independent of account login/)
  assert.match(connectSrc, /readBestLocalWallet\(null\)/, 'sign-out must keep the device-linked wallet')
  assert.match(connectSrc, /Reconnecting wallet…/)
  assert.match(connectSrc, /Could not restore automatically/)
  assert.doesNotMatch(connectSrc, /Wallet saved to your account\. Reconnect on this device\./)
}

{
  assert.match(settingsSrc, /savedFiltersExtraRef/, 'settings save must keep extra saved_filters keys')
  assert.match(settingsSrc, /\.\.\.savedFiltersExtraRef\.current/, 'settings payload must spread preserved filters')
  const payload = settingsSrc.slice(settingsSrc.indexOf('function buildPayload'), settingsSrc.indexOf('function hydrateFromSettings'))
  assert.match(payload, /chainlens_wallet_linked|savedFiltersExtraRef/, 'settings must not replace saved_filters with only alert booleans')
}

console.log('test-wallet-connect-persist.mjs: all assertions passed')
