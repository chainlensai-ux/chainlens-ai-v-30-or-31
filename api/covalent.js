/**
 * Multi-chain portfolio proxy — DeBank as primary source for token balances.
 * No API key required for DeBank.
 *
 * POST body: { address, chains?: ['eth','bnb','base','polygon'], history?: boolean }
 * Response: { eth: { tokens }, bnb, base, polygon, totalUsd }
 */

// DeBank chain ID → our internal chain key
const DEBANK_CHAIN_TO_KEY = {
  eth: 'eth',
  bsc: 'bnb',
  base: 'base',
  matic: 'polygon',
  polygon: 'polygon',
};

function parseBody(req) {
  let b = req.body;
  if (b == null) return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return {}; }
  }
  return b;
}

function numQuote(q) {
  if (typeof q === 'number' && isFinite(q)) return q;
  const n = parseFloat(q);
  return isFinite(n) ? n : 0;
}

async function debankFetch(path) {
  const url = `https://api.debank.com${path}`;
  try {
    const r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, error: `Invalid JSON from DeBank (HTTP ${r.status})` };
    }
    if (!r.ok) return { ok: false, error: `DeBank HTTP ${r.status}` };
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = parseBody(req);
  const address = String(body.address || '').trim();

  if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
    return res.status(400).json({ error: 'Invalid EVM wallet address' });
  }

  const requestedChains = Array.isArray(body.chains) && body.chains.length
    ? body.chains
    : ['eth', 'bnb', 'base', 'polygon'];

  const chainKeys = requestedChains.filter(k => Object.values(DEBANK_CHAIN_TO_KEY).includes(k));

  // Fetch token list and total balance from DeBank in parallel
  const [tokenResult, totalResult] = await Promise.all([
    debankFetch(`/user/token_list?id=${address.toLowerCase()}&is_all=true`),
    debankFetch(`/user/total_balance?id=${address.toLowerCase()}`)
  ]);

  const out = {};
  chainKeys.forEach(k => { out[k] = { tokens: [] }; });

  if (tokenResult.ok) {
    // DeBank returns { data: [...], error_code: 0 } or [...] directly
    const rawData = tokenResult.data;
    const tokens = Array.isArray(rawData) ? rawData
      : Array.isArray(rawData?.data) ? rawData.data
      : [];

    tokens.forEach(token => {
      const debankChain = String(token.chain || '').toLowerCase();
      const chainKey = DEBANK_CHAIN_TO_KEY[debankChain];
      if (!chainKey || !chainKeys.includes(chainKey)) return;

      const amount = numQuote(token.amount);
      const price = numQuote(token.price || 0);
      const usdValue = amount * price;

      // Filter tokens worth under $10 USD
      if (usdValue < 10) return;

      // Native tokens have id equal to the chain name (e.g. "eth" for ETH on Ethereum)
      const isNative = !token.id || token.id === debankChain || !/^0x[a-fA-F0-9]+$/.test(String(token.id));

      out[chainKey].tokens.push({
        contractTicker: token.symbol || token.optimized_symbol || '',
        symbol: token.symbol || token.optimized_symbol || '',
        contractAddress: isNative ? '' : String(token.id || ''),
        name: token.name || token.symbol || 'Token',
        contractDecimals: 0,
        balance: amount,
        usdValue,
        price,
        chain: chainKey
      });
    });

    // Sort each chain's tokens by USD value descending
    chainKeys.forEach(k => {
      out[k].tokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    });
  }

  // Add total USD value from DeBank
  if (totalResult.ok) {
    const td = totalResult.data;
    const totalUsd = numQuote(
      td?.total_usd_value ??
      td?.data?.total_usd_value ?? 0
    );
    if (totalUsd > 0) out.totalUsd = totalUsd;
  }

  if (body.history) out.history = [];

  return res.status(200).json(out);
}
