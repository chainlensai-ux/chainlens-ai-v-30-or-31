'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { isPreviewPasswordCorrect, previewAuthCookieOptions, PREVIEW_AUTH_COOKIE_NAME, PREVIEW_AUTH_COOKIE_VALUE } from '@/lib/previewAuth'

// Sets an httpOnly cookie, which is only possible server-side (a Client Component calling
// document.cookie cannot set httpOnly) — this must be a Server Action, not client JS.
export async function previewLoginAction(formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '')

  if (!isPreviewPasswordCorrect(password)) {
    redirect('/preview-login?error=1')
  }

  const cookieStore = await cookies()
  cookieStore.set(PREVIEW_AUTH_COOKIE_NAME, PREVIEW_AUTH_COOKIE_VALUE, previewAuthCookieOptions())

  redirect('/')
}
