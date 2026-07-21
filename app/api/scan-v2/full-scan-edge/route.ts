// POST /api/scan-v2/full-scan-edge — Edge-compatible thin wrapper for the Node full-scan route.
//
// This file intentionally imports nothing. Edge routes must not pull server-side modules into their
// bundle: Redis clients, queues, scanner workers, RPC clients, Node streams, Node crypto, and other
// Node-only code all live behind the Node-runtime `/api/scan-v2/full-scan/legacy` route. This route
// only validates the request body enough to reject malformed input, forwards the original JSON to
// that server route with fetch(), and relays the server route's JSON/status back to the caller.

export const runtime = 'edge'

const SERVER_FULL_SCAN_PATH = '/api/scan-v2/full-scan/legacy'

type JsonObject = Record<string, unknown>

type ValidationResult =
  | { ok: true; body: JsonObject }
  | { ok: false; status: number; message: string; category: string }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function validationError(status: number, message: string, category = 'validation'): ValidationResult {
  return { ok: false, status, message, category }
}

function validateBody(rawBody: unknown): ValidationResult {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return validationError(400, 'Request body must be a JSON object')
  }

  const body = rawBody as JsonObject
  const walletAddress = body.walletAddress ?? body.address

  if (typeof walletAddress !== 'string' || walletAddress.trim().length === 0) {
    return validationError(400, 'walletAddress is required')
  }

  return { ok: true, body }
}

function forwardedHeaders(req: Request): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const forwardedFor = req.headers.get('x-forwarded-for')
  const realIp = req.headers.get('x-real-ip')

  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor)
  if (realIp) headers.set('x-real-ip', realIp)

  return headers
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return {
      success: false,
      error: {
        message: 'Server full scan returned a non-JSON response',
        category: 'upstream',
      },
    }
  }
}

export async function POST(req: Request): Promise<Response> {
  let rawBody: unknown

  try {
    rawBody = await req.json()
  } catch {
    return jsonResponse(
      { success: false, error: { message: 'Invalid JSON body', category: 'validation' } },
      400,
    )
  }

  const validation = validateBody(rawBody)
  if (!validation.ok) {
    return jsonResponse(
      { success: false, error: { message: validation.message, category: validation.category } },
      validation.status,
    )
  }

  try {
    const upstreamUrl = new URL(SERVER_FULL_SCAN_PATH, req.url)
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: forwardedHeaders(req),
      body: JSON.stringify(validation.body),
    })
    const upstreamBody = await parseJsonResponse(upstreamResponse)

    return jsonResponse(upstreamBody, upstreamResponse.status)
  } catch {
    return jsonResponse(
      {
        success: false,
        error: {
          message: 'Unable to reach server full scan route',
          category: 'upstream',
        },
      },
      502,
    )
  }
}
