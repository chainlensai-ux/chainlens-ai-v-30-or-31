import { createRateLimiter, getClientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });

export async function GET(req: Request) {
  if (!limiter.check(getClientIp(req))) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const network = searchParams.get("network");
  const type = (searchParams.get("type") ?? "pools").toLowerCase();
  const pageRaw = Number(searchParams.get("page") ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(10, Math.floor(pageRaw)) : 1;
  const perPageRaw = Number(searchParams.get("per_page") ?? "20");
  const perPage = Number.isFinite(perPageRaw) ? Math.min(20, Math.max(10, Math.floor(perPageRaw))) : 20;

  if (!network) {
    return Response.json({ error: "Missing network param" }, { status: 400 });
  }

  if (network !== "base" && network !== "eth") {
    return Response.json({ error: "Invalid network. Must be 'base' or 'eth'" }, { status: 400 });
  }

  if (!["pools", "trending", "new"].includes(type)) {
    return Response.json({ error: "Invalid type. Must be 'pools', 'trending', or 'new'" }, { status: 400 });
  }

  const endpoint =
    type === "pools"
      ? `networks/${network}/pools`
      : `networks/${network}/${type}_pools`;
  const url = `https://api.geckoterminal.com/api/v2/${endpoint}?page=${page}&include=base_token,quote_token&per_page=${perPage}`;

  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(url, {
      headers: {
        "accept": "application/json",
        "origin": "https://chainlens.ai",
      },
      cache: "no-store",
      signal: ac.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return Response.json({ data: [], error: "Market source unavailable" }, { status: 200 });
    }
    const data = await res.json().catch(() => ({ data: [] }));
    return Response.json(data);
  } catch {
    console.log("GT PROXY ERROR");
    return Response.json({ data: [], error: "Proxy fetch failed" }, { status: 200 });
  }
}
