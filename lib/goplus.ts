export interface GoPlusResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Calls the server-side /api/goplus route.
 * baseUrl must be provided when calling from server-side API routes
 * (e.g. req.nextUrl.origin). Leave empty for client-side usage.
 * Secrets are never exposed — all GoPlus API calls stay in /api/goplus.
 */
export async function fetchGoPlus(
  address: string,
  baseUrl = ""
): Promise<GoPlusResult> {
  try {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return { ok: false, error: "Invalid address." };
    }
    const res = await fetch(
      `${baseUrl}/api/goplus?address=${encodeURIComponent(address)}`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      return { ok: false, error: `GoPlus route returned ${res.status}.` };
    }
    return (await res.json()) as GoPlusResult;
  } catch {
    return { ok: false, error: "GoPlus request failed." };
  }
}
