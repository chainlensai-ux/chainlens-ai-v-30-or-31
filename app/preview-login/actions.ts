'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { isPreviewPasswordCorrect, previewAuthCookieOptions, PREVIEW_AUTH_COOKIE_NAME, previewAuthCookieValue } from '@/lib/previewAuth'
import { clientIpFromHeaders, createFixedWindowCounter } from '@/lib/authRateLimit'

const previewLoginAttempts = createFixedWindowCounter(8, 10 * 60 * 1000)

// Sets an httpOnly cookie, which is only possible server-side (a Client Component calling
// document.cookie cannot set httpOnly) — this must be a Server Action, not client JS.
export async function previewLoginAction(formData: FormData): Promise<void> {
  const headerList = await headers()
  const ip = clientIpFromHeaders(headerList)
  if (previewLoginAttempts.isBlocked(`preview:${ip}`)) {
    redirect('/preview-login?error=1')
  }

  const password = String(formData.get('password') ?? '')

  if (!(await isPreviewPasswordCorrect(password))) {
    previewLoginAttempts.increment(`preview:${ip}`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    redirect('/preview-login?error=1')
  }

  const cookieValue = await previewAuthCookieValue()
  if (!cookieValue) redirect('/preview-login?error=1')

  const cookieStore = await cookies()
  cookieStore.set(PREVIEW_AUTH_COOKIE_NAME, cookieValue, previewAuthCookieOptions())

  redirect('/')
}
