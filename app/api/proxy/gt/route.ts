export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const network = searchParams.get("network");

  if (!network) {
    return Response.json({ error: "Missing network param" }, { status: 400 });
  }

  if (network !== "base" && network !== "eth") {
    return Response.json({ error: "Invalid network. Must be 'base' or 'eth'" }, { status: 400 });
  }

  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=1&include=base_token,quote_token`;

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
