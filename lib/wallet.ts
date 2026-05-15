import { defaultWagmiConfig } from '@web3modal/wagmi/react/config'
import { base } from 'viem/chains'
import { createConfig, createStorage, http } from 'wagmi'
import { injected } from 'wagmi/connectors'

export const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ??
  process.env.NEXT_PUBLIC_WALLETCONNECT_ID ??
  ''
export const walletConnectEnabled = projectId.length > 0

// wagmi's built-in cookieStorage sets session cookies (no expiry), so the
// wallet disconnects every time the browser is closed. This replacement uses
// the identical cookie format (same keys, same Path/SameSite) but adds a
// 30-day max-age so the connection survives browser restarts.
const THIRTY_DAYS = 30 * 24 * 60 * 60
const persistentCookieStorage = {
  getItem(key: string): string | null {
    if (typeof window === 'undefined') return null
    const match = document.cookie.split('; ').find(r => r.startsWith(`${key}=`))
    return match ? match.substring(key.length + 1) : null
  },
  setItem(key: string, value: string): void {
    if (typeof window === 'undefined') return
    document.cookie = `${key}=${value};Path=/;SameSite=Lax;max-age=${THIRTY_DAYS}`
  },
  removeItem(key: string): void {
    if (typeof window === 'undefined') return
    document.cookie = `${key}=;max-age=-1;Path=/`
  },
}

const persistOptions = {
  ssr: true,
  storage: createStorage({ storage: persistentCookieStorage }),
} as const

export const wagmiConfig = walletConnectEnabled
  ? defaultWagmiConfig({
      projectId,
      chains: [base],
      metadata: {
        name: 'ChainLens AI',
        description: 'AI-powered Base analytics',
        url: 'https://www.chainlensai.app',
        icons: ['https://www.chainlensai.app/favicon.svg'],
      },
      ...persistOptions,
    })
  : createConfig({
      chains: [base],
      connectors: [injected()],
      transports: {
        [base.id]: http(),
      },
      ...persistOptions,
    })
