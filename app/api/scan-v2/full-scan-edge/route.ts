// POST /api/scan-v2/full-scan-edge — Edge-only proxy for the Node full-scan endpoint.
// Keep this module graph isolated: no imports, no shared code, and no direct scanner work.

export const runtime = 'edge'

const UPSTREAM_PATH = '/api/scan-v2/full-scan/legacy'

type JsonObject = Record<string, unknown>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function getWalletAddress(body: JsonObject): string | null {
  const value = body.walletAddress ?? body.address
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function buildForwardedHeaders(req: Request): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const forwardedFor = req.headers.get('x-forwarded-for')
  const realIp = req.headers.get('x-real-ip')

  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor)
  if (realIp) headers.set('x-real-ip', realIp)

  return headers
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown

  try {
    body = await req.json()
  } catch {
    return jsonResponse(
      { success: false, error: { message: 'Invalid JSON body', category: 'validation' } },
      400,
    )
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(
      { success: false, error: { message: 'Request body must be a JSON object', category: 'validation' } },
      400,
    )
  }

  if (!getWalletAddress(body as JsonObject)) {
    return jsonResponse(
      { success: false, error: { message: 'walletAddress is required', category: 'validation' } },
      400,
    )
  }

  try {
    const upstreamResponse = await fetch(new URL(UPSTREAM_PATH, req.url), {
      method: 'POST',
      headers: buildForwardedHeaders(req),
      body: JSON.stringify(body),
    })

    const upstreamJson = await upstreamResponse.json()
    return jsonResponse(upstreamJson, upstreamResponse.status)
  } catch {
    return jsonResponse(
      { success: false, error: { message: 'Unable to reach full scan route', category: 'upstream' } },
      502,
    )
  }
}
