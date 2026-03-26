/**
 * Zerion portfolio proxy — primary source for EVM token holdings and portfolio total.
 *
 * POST body: { address, chains?: ['eth','bnb','base','polygon'] }
 * Response:  { eth: { tokens }, bnb, base, polygon, totalUsd }
 *
 * Auth: Basic auth using ZERION_KEY env var, base64-encoded with trailing colon.
 */

// Zerion chain ID → our internal chain key
const ZERION_CHAIN_TO_KEY = {
  ethereum: 'eth',
  'binance-smart-chain': 'bnb',
  base: 'base',
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

async function zerionFetch(path, authHeader) {
  const url = `https://api.zerion.io/v1${path}`;
  try {
    const r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: authHeader,
        'Content-Type': 'application/json',
      }
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, error: `Invalid JSON from Zerion (HTTP ${r.status})` };
    }
    if (!r.ok) return { ok: false, error: `Zerion HTTP ${r.status}: ${json?.errors?.[0]?.detail || text.slice(0, 200)}` };
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

  const ZERION_KEY = process.env.ZERION_KEY || '';
  if (!ZERION_KEY) {
    return res.status(503).json({ error: 'ZERION_KEY is not set on the server.' });
  }

  const authHeader = 'Basic ' + Buffer.from(ZERION_KEY + ':').toString('base64');

  const body = parseBody(req);
  const address = String(body.address || '').trim();

  if (!/^0x[a-fA-F0-9]{40}$/i.test(address)) {
    return res.status(400).json({ error: 'Invalid EVM wallet address' });
  }

  const requestedChains = Array.isArray(body.chains) && body.chains.length
    ? body.chains
    : ['eth', 'bnb', 'base', 'polygon'];

  const chainKeys = requestedChains.filter(k => Object.values(ZERION_CHAIN_TO_KEY).includes(k));

  const addrLower = address.toLowerCase();

  // Fetch portfolio total and positions in parallel
  const [portfolioResult, positionsResult] = await Promise.all([
    zerionFetch(`/wallets/${addrLower}/portfolio`, authHeader),
    zerionFetch(`/wallets/${addrLower}/positions?filter[position_types]=wallet&currency=usd&sort=-value`, authHeader),
  ]);

  const out = {};
  chainKeys.forEach(k => { out[k] = { tokens: [] }; });

  if (positionsResult.ok) {
    const positions = Array.isArray(positionsResult.data?.data) ? positionsResult.data.data : [];

    positions.forEach(pos => {
      const attrs = pos?.attributes || {};
      const chainId = pos?.relationships?.chain?.data?.id || '';
      const chainKey = ZERION_CHAIN_TO_KEY[chainId];
      if (!chainKey || !chainKeys.includes(chainKey)) return;

      const usdValue = numQuote(attrs.value);
      if (usdValue < 10) return;

      const quantity = attrs.quantity || {};
      const balance = numQuote(quantity.float ?? quantity.numeric);
      const price = balance > 0 ? usdValue / balance : 0;

      const fungible = attrs.fungible_info || {};
      const symbol = fungible.symbol || '';
      const name = fungible.name || symbol || 'Token';

      // Find contract address for this chain from implementations
      let contractAddress = '';
      const impls = Array.isArray(fungible.implementations) ? fungible.implementations : [];
      const impl = impls.find(im => ZERION_CHAIN_TO_KEY[im?.chain_id] === chainKey);
      if (impl?.address) contractAddress = impl.address;

      out[chainKey].tokens.push({
        contractTicker: symbol,
        symbol,
        contractAddress,
        name,
        contractDecimals: numQuote(quantity.decimals) || 18,
        balance,
        usdValue,
        price,
        chain: chainKey,
      });
    });

    // Sort each chain's tokens by USD value descending
    chainKeys.forEach(k => {
      out[k].tokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    });
  } else {
    out._positionsError = positionsResult.error;
  }

  // Portfolio total from Zerion
  if (portfolioResult.ok) {
    const totalPositions = portfolioResult.data?.data?.attributes?.total?.positions;
    const totalUsd = numQuote(totalPositions);
    if (totalUsd > 0) out.totalUsd = totalUsd;
  } else {
    out._portfolioError = portfolioResult.error;
  }

  return res.status(200).json(out);
}
