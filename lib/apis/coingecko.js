const BASE = 'https://api.coingecko.com/api/v3';

function addKey(url) {
  const key = (process.env.COINGECKO_DEMO_API_KEY || process.env.COINGECKO_API_KEY || '').trim();
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}x_cg_demo_api_key=${encodeURIComponent(key)}`;
}

async function fetchJson(url) {
  const res = await fetch(addKey(url), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko request failed (${res.status})`);
  return res.json();
}

export async function fetchCoinGeckoMarket(ids) {
  if (!ids) return [];
  const idList = Array.isArray(ids) ? ids.join(',') : ids;
  return fetchJson(`${BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(idList)}&sparkline=false&price_change_percentage=24h`);
}

export async function fetchCoinGeckoSearch(query) {
  if (!query) return {};
  return fetchJson(`${BASE}/search?query=${encodeURIComponent(query)}`);
}
