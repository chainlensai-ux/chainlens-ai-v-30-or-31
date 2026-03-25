/**
 * Multi-chain portfolio proxy for Covalent / GoldRush (api.covalenthq.com).
 * Env: COVALENT_API_KEY
 *
 * POST body: { address, chains?: ['eth','bnb','base','polygon'], history?: boolean, days?: number }
 * Response: { eth: { tokens, history? }, bnb, base, polygon, history? } — matches Portfolio Value widget.
 */

const COVALENT_BASE = 'https://api.covalenthq.com/v1';

const CHAIN_IDS = {
  eth: '1',
  bnb: '56',
  base: '8453',
  polygon: '137'
};

function parseBody(req) {
  let b = req.body;
  if (b == null) return {};
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  return b;
}

function numQuote(q) {
  if (typeof q === 'number' && isFinite(q)) return q;
  const n = parseFloat(q);
  return isFinite(n) ? n : 0;
}

function mapBalanceItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    contractTicker: item.contract_ticker_symbol,
    symbol: item.contract_ticker_symbol,
    contractAddress: item.contract_address,
    name: item.contract_name,
    contractDecimals: item.contract_decimals,
    balance: item.balance,
    usdValue: numQuote(item.quote)
  }));
}

/** Sum token holding quotes per timestamp for one chain (portfolio_v2). */
function historyFromPortfolioData(data) {
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  const byTs = new Map();
  for (const token of items) {
    const holdings = token.holdings;
    if (!Array.isArray(holdings)) continue;
    for (const h of holdings) {
      const ts = h.timestamp;
      if (!ts) continue;
      const q = h.close?.quote;
      const n = numQuote(q);
      if (!isFinite(n)) continue;
      byTs.set(ts, (byTs.get(ts) || 0) + n);
    }
  }
  return [...byTs.entries()]
    .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
    .map(([timestamp, totalUsdValue]) => ({
      timestamp,
      date: timestamp,
      totalUsdValue,
      usdValue: totalUsdValue
    }));
}

async function covalentFetch(pathAndQuery, apiKey) {
  const url = `${COVALENT_BASE}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: r.status, error: `Invalid JSON from Covalent (HTTP ${r.status})` };
  }
  if (!r.ok) {
    const msg = json?.error_message || json?.error_code || text.slice(0, 200);
    return { ok: false, status: r.status, error: String(msg) };
  }
  if (json.error === true || json.error === 'true') {
    return {
      ok: false,
      status: r.status,
      error: String(json.error_message || json.error_code || 'Covalent error')
    };
  }
  return { ok: true, data: json };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = (process.env.COVALENT_API_KEY || process.env.COVALENT_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({
      error: 'COVALENT_API_KEY is not set on the server (Vercel env / local .env).'
    });
  }

  const body = parseBody(req);
  const address = String(body.address || '').trim();
  const requestedChains = Array.isArray(body.chains) && body.chains.length
    ? body.chains
    : ['eth', 'bnb', 'base', 'polygon'];
  const wantHistory = Boolean(body.history);
  const days = Math.min(30, Math.max(1, parseInt(String(body.days || 7), 10) || 7));

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid EVM wallet address' });
  }

  const chainKeys = requestedChains.filter((k) => CHAIN_IDS[k]);
  if (!chainKeys.length) {
    return res.status(400).json({ error: 'No supported chains requested' });
  }

  const out = {};

  await Promise.all(
    chainKeys.map(async (key) => {
      const chainId = CHAIN_IDS[key];
      const balPath = `/${chainId}/address/${address}/balances_v2/?quote-currency=USD`;
      const bal = await covalentFetch(balPath, apiKey);

      if (!bal.ok) {
        out[key] = { tokens: [], error: bal.error };
        return;
      }

      const items = bal.data?.data?.items;
      out[key] = {
        tokens: mapBalanceItems(items)
      };

      if (wantHistory) {
        const portPath = `/${chainId}/address/${address}/portfolio_v2/?quote-currency=USD&days=${days}`;
        const port = await covalentFetch(portPath, apiKey);
        if (port.ok && port.data?.data) {
          out[key].history = historyFromPortfolioData(port.data.data);
        } else {
          out[key].history = [];
        }
      }
    })
  );

  if (wantHistory) {
    const byDay = new Map();
    for (const k of chainKeys) {
      const hist = out[k]?.history;
      if (!Array.isArray(hist)) continue;
      for (const row of hist) {
        const ts = row.timestamp || row.date;
        if (!ts || typeof ts !== 'string') continue;
        const day = ts.length >= 10 ? ts.slice(0, 10) : ts;
        const v = Number(row.totalUsdValue ?? row.usdValue ?? 0);
        if (!isFinite(v)) continue;
        byDay.set(day, (byDay.get(day) || 0) + v);
      }
    }
    out.history = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, totalUsdValue]) => ({
        date,
        timestamp: date,
        totalUsdValue,
        usdValue: totalUsdValue
      }));
  }

  return res.status(200).json(out);
}
