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
// wallet disconnects every time the browser is closed. Cookie-only storage also
// silently fails once the wagmi store exceeds ~4KB (Chrome/Safari drop the
// cookie). localStorage is the source of truth so the session survives restarts
// and reloads; a size-capped cookie is kept only as an SSR first-paint hint.
const THIRTY_DAYS = 30 * 24 * 60 * 60
const COOKIE_BUDGET = 3500

function cookieSecureSuffix(): string {
  if (typeof window === 'undefined') return ''
  return window.location.protocol === 'https:' ? ';Secure' : ''
}

function readCookie(key: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.split('; ').find(r => r.startsWith(`${key}=`))
  if (!match) return null
  const raw = match.substring(key.length + 1)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const persistentClientStorage = {
  getItem(key: string): string | null {
    if (typeof window === 'undefined') return null
    try {
      const local = window.localStorage.getItem(key)
      if (local) return local
    } catch {}
    return readCookie(key)
  },
  setItem(key: string, value: string): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, value)
    } catch {}
    try {
      const encoded = encodeURIComponent(value)
      if (encoded.length < COOKIE_BUDGET) {
        document.cookie = `${key}=${encoded};Path=/;SameSite=Lax;max-age=${THIRTY_DAYS}${cookieSecureSuffix()}`
      } else {
        document.cookie = `${key}=;max-age=-1;Path=/`
      }
    } catch {}
  },
  removeItem(key: string): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(key)
    } catch {}
    document.cookie = `${key}=;max-age=-1;Path=/`
  },
}

const persistOptions = {
  ssr: true,
  storage: createStorage({ storage: persistentClientStorage }),
} as const

/** Decode wagmi cookie values so cookieToInitialState can read encodeURIComponent stores. */
export function decodeWagmiCookieHeader(cookie: string | null | undefined): string | undefined {
  if (!cookie) return undefined
  return cookie.split('; ').map((part) => {
    const i = part.indexOf('=')
    if (i < 0) return part
    const k = part.slice(0, i)
    const v = part.slice(i + 1)
    if (!k.startsWith('wagmi')) return part
    try {
      return `${k}=${decodeURIComponent(v)}`
    } catch {
      return part
    }
  }).join('; ')
}

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
