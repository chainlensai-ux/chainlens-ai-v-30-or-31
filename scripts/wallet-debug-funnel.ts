// TEMPORARY: run the Wallet Scanner PnL pipeline for one or more wallets with WALLET_DEBUG=1 and
// print each scan's per-stage funnel ([wallet-debug-funnel], src/lib/walletDebugFunnel.ts).
//
//   npx tsx scripts/wallet-debug-funnel.ts 0xWALLET1 0xWALLET2 0xWALLET3 [--chains base,ethereum]
//
// Needs the same provider/env keys as the app (.env.local: ALCHEMY_*, GOLDRUSH_API_KEY, KV_*).
// Read-only: no logic is changed; the only extra work is the funnel arithmetic.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 1) continue
    const key = t.slice(0, eq).trim()
    let value = t.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!process.env[key]) process.env[key] = value
  }
}

async function main(): Promise<void> {
  loadEnvLocal()
  process.env.WALLET_DEBUG = '1'
  const args = process.argv.slice(2)
  const chainsArg = args.indexOf('--chains')
  const chains = chainsArg >= 0 ? String(args[chainsArg + 1] ?? 'base').split(',') : ['base']
  const wallets = args.filter((a, i) => /^0x[0-9a-fA-F]{40}$/.test(a) && i !== chainsArg + 1)
  if (wallets.length === 0) {
    console.error('usage: npx tsx scripts/wallet-debug-funnel.ts 0xWALLET [0xWALLET ...] [--chains base,ethereum]')
    process.exit(1)
  }

  // Capture the funnel line; silence the pipeline's other diagnostics so the output stays readable.
  const funnels: unknown[] = []
  const originalWarn = console.warn
  const originalLog = console.log
  console.warn = (...parts: unknown[]) => {
    if (parts[0] === '[wallet-debug-funnel]' && typeof parts[1] === 'string') funnels.push(JSON.parse(parts[1]))
    else if (parts[0] === '[wallet-debug-funnel] failed to build') originalWarn(...parts)
  }
  console.log = () => {}

  const { runWalletScan } = await import('../src/pipeline/index')
  for (const wallet of wallets) {
    const before = funnels.length
    try {
      await runWalletScan({ walletAddress: wallet, chains, scanMode: 'normal' })
    } catch (error) {
      originalWarn(`[${wallet}] scan failed:`, error instanceof Error ? error.message : error)
    }
    const funnel = funnels.length > before ? funnels[funnels.length - 1] : null
    originalLog(`\n===== ${wallet} (${chains.join(',')}) =====`)
    originalLog(funnel ? JSON.stringify(funnel, null, 2) : 'no funnel produced (scan failed before FIFO, or no events)')
  }
  console.warn = originalWarn
  console.log = originalLog
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
