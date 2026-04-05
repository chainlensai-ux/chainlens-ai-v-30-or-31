async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`DexScreener request failed (${res.status})`);
  return res.json();
}

export async function fetchDexScreenerData(token) {
  if (!token) return {};
  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(token)}`);
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  const best = pairs[0] || null;
  return {
    pair: best,
    pairs,
    liquidity: best?.liquidity?.usd ?? null,
    volume24h: best?.volume?.h24 ?? null,
    priceUsd: best?.priceUsd ?? null,
  };
}
