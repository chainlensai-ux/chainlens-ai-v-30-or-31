import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({ ok: true, route: 'alchemy webhook alive' })
}

export async function POST(request: Request) {
  try {
    await request.json()
  } catch {
    // body may be empty or non-JSON — ignore
  }
  return NextResponse.json({ ok: true, received: true })
}
