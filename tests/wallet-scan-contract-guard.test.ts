// Wallet Scanner refuses contract addresses: scanning the ENA bridge adapter (a token contract on
// Base) published a $37.6M "portfolio" and +$2.05M of "realized PnL" from its bridge transfers.
//   npx tsx --test tests/wallet-scan-contract-guard.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectContractAddress } from '@/lib/server/whaleWalletKind'

process.env.ALCHEMY_BASE_RPC_URL = 'https://base.test'
process.env.ETH_RPC_URL = 'https://eth.test'

function rpc(codeByHost: Record<string, string | Error>) {
  return (async (url: string) => {
    const code = codeByHost[new URL(url).host]
    if (code instanceof Error) throw code
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: code }), { status: 200 })
  }) as never
}

const ENA_OFT = '0x58538e6a46e07434d7e7375bc268d3cb839c0133'

test('a contract on either chain is a contract', async () => {
  assert.equal(await detectContractAddress(ENA_OFT, rpc({ 'base.test': '0x6080604052', 'eth.test': '0x' })), 'contract')
  assert.equal(await detectContractAddress(ENA_OFT, rpc({ 'base.test': '0x', 'eth.test': '0x6080604052' })), 'contract')
})

test('a plain or EIP-7702 delegated wallet is an EOA on both chains', async () => {
  assert.equal(await detectContractAddress('0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811', rpc({ 'base.test': '0x', 'eth.test': '0x' })), 'eoa')
  assert.equal(await detectContractAddress('0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811', rpc({ 'base.test': '0xef0100aabbccddeeff00112233445566778899aabbcc', 'eth.test': '0x' })), 'eoa')
})

test('a failed lookup never blocks a scan', async () => {
  assert.equal(await detectContractAddress('0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811', rpc({ 'base.test': new Error('down'), 'eth.test': '0x' })), 'unknown')
})

test('known infrastructure is refused without a lookup', async () => {
  assert.equal(await detectContractAddress('0x4200000000000000000000000000000000000006', rpc({})), 'infra')
})

test('the wallet-scan route rejects contracts before consuming quota', () => {
  const source = readFileSync('app/api/wallet-scan/route.ts', 'utf8')
  const guard = source.indexOf('detectContractAddress(wallet)')
  assert.ok(guard > 0)
  assert.ok(guard < source.indexOf('consumeDailyScan('), 'contract check runs before the deep-scan quota is consumed')
})
