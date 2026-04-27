export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const network = searchParams.get("network");
  const pageRaw = Number(searchParams.get("page") ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const perPageRaw = Number(searchParams.get("per_page") ?? "20");
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(10, Math.floor(perPageRaw))) : 20;

  if (!network) {
    return Response.json({ error: "Missing network param" }, { status: 400 });
  }

  if (network !== "base" && network !== "eth") {
    return Response.json({ error: "Invalid network. Must be 'base' or 'eth'" }, { status: 400 });
  }

  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=${page}&include=base_token,quote_token&per_page=${perPage}`;

  try {
    const res = await fetch(url, {
      headers: {
        "accept": "application/json",
        "origin": "https://chainlens.ai",
      },
      cache: "no-store"
    });

    const data = await res.json();
    return Response.json(data);
  } catch (e) {
    console.log("GT PROXY ERROR:", e);
    return Response.json({ error: "Proxy fetch failed" }, { status: 500 });
  }
}
