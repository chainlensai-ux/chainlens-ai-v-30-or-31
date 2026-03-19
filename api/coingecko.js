export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ids, query, action, exchangeId, coinId } = req.body || {};
  const CGK = process.env.COINGECKO_API_KEY || 'CG-CUrNMMdo77ZD3UbeHX3zEWm5';
  const BASE = 'https://api.coingecko.com/api/v3';

  try {
    // Search for a coin by name or symbol
    if (action === 'search' && query) {
      const r = await fetch(`${BASE}/search?query=${encodeURIComponent(query)}&x_cg_demo_api_key=${CGK}`);
      if (!r.ok) return res.status(r.status).json({ error: 'CoinGecko search failed' });
      const d = await r.json();
      return res.status(200).json(d);
    }

    // Fetch exchange tickers (inflow/outflow proxy via volume data)
    if (action === 'exchange_tickers' && exchangeId) {
      const coinParam = coinId ? `&coin_ids=${coinId}` : '';
      const r = await fetch(
        `${BASE}/exchanges/${exchangeId}/tickers?include_exchange_logo=false&order=volume_desc&depth=false${coinParam}&x_cg_demo_api_key=${CGK}`
      );
      if (!r.ok) return res.status(r.status).json({ error: 'CoinGecko exchange tickers failed' });
      const d = await r.json();
      return res.status(200).json(d);
    }

    // Fetch exchange basic info + 24h volume
    if (action === 'exchange_info' && exchangeId) {
      const r = await fetch(`${BASE}/exchanges/${exchangeId}?x_cg_demo_api_key=${CGK}`);
      if (!r.ok) return res.status(r.status).json({ error: 'CoinGecko exchange info failed' });
      const d = await r.json();
      return res.status(200).json(d);
    }

    // Fetch market data for specific coin IDs
    if (ids) {
      const idList = Array.isArray(ids) ? ids.join(',') : ids;
      const r = await fetch(
        `${BASE}/coins/markets?vs_currency=usd&ids=${idList}&order=market_cap_desc&sparkline=false&price_change_percentage=24h,7d&x_cg_demo_api_key=${CGK}`
      );
      if (!r.ok) return res.status(r.status).json({ error: 'CoinGecko markets fetch failed' });
      const d = await r.json();
      return res.status(200).json(d);
    }

    return res.status(400).json({ error: 'Provide ids, a search query, or exchange action' });
  } catch (err) {
    console.error('CoinGecko proxy error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
