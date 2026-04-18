import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function BetaPage() {
  const betaEnds = new Date('2026-04-25T00:00:00Z')

  if (new Date() > betaEnds) {
    redirect('/beta-ended')
  } else {
    redirect('/')
  }
}
