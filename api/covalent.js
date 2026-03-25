/**
 * Multi-chain portfolio proxy — Moralis as primary source for token balances.
 * Alchemy used as backup for ETH mainnet native balance.
 * Env: MORALIS_KEY, ALCHEMY_KEY
 *
 * POST body: { address, chains?: ['eth','bnb','base','polygon'], history?: boolean, days?: number }
 * Response: { eth: { tokens }, bnb, base, polygon } — matches Portfolio Value widget.
 */

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2.2';

// Moralis chain identifiers
const MORALIS_CHAIN_MAP = {
  eth: 'eth',
  bnb: 'bsc',
  base: 'base',
  polygon: 'polygon'
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

/**
 * Parse raw integer balance string to human-readable decimal.
 * Prefers balance_formatted from Moralis; falls back to raw / 10^decimals.
 * Returns the decimal balance so callers don't need contractDecimals for conversion.
 */
function parseDecimalBalance(item) {
  if (item.balance_formatted != null) {
    const f = parseFloat(item.balance_formatted);
    if (Number.isFinite(f) && f >= 0) return f;
  }
  const decimals = Number.isFinite(Number(item.decimals)) ? Number(item.decimals) : 18;
  const raw = String(item.balance || '0');
  try {
    // Use BigInt for precision on large integers
    const rawBig = BigInt(raw);
    return Number(rawBig) / Math.pow(10, decimals);
  } catch {
    return parseFloat(raw) / Math.pow(10, decimals) || 0;
  }
}

async function moralisFetch(path, moralisKey) {
  const url = `${MORALIS_BASE}${path}`;
  const r = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-API-Key': moralisKey
    }
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: r.status, error: `Invalid JSON from Moralis (HTTP ${r.status})` };
  }
  if (!r.ok) {
    const msg = json?.message || text.slice(0, 200);
    return { ok: false, status: r.status, error: String(msg) };
  }
  return { ok: true, data: json };
}

/** Alchemy backup: fetch native ETH balance on mainnet. */
async function alchemyGetEthBalance(address, alchemyKey) {
  if (!alchemyKey) return null;
  try {
    const url = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest']
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const hex = j?.result;
    if (!hex) return null;
    return parseInt(hex, 16) / 1e18;
  } catch {
    return null;
  }
}

/**
 * Map Moralis token list to portfolio format.
 * - Filters spam tokens (possible_spam: true).
 * - Filters ERC-20 tokens worth under $1 USD.
 * - Returns balance as human-readable decimal (contractDecimals: 0).
 *   This ensures fetchBaseCovalentBalances in the frontend doesn't double-convert.
 */
function mapMoralisItems(items, chainKey) {
  return (Array.isArray(items) ? items : [])
    .filter(item => {
      if (item.possible_spam === true) return false;
      const isNative = item.native_token === true;
      const usd = numQuote(item.usd_value);
      // Always keep native tokens; filter ERC-20 tokens under $1
      if (!isNative && usd < 1) return false;
      return true;
    })
    .map(item => {
      const isNative = item.native_token === true;
      const bal = parseDecimalBalance(item);
      return {
        contractTicker: item.symbol || '',
        symbol: item.symbol || '',
        // Native tokens use empty address so frontend deduplicates correctly
        contractAddress: isNative ? '' : (item.token_address || ''),
        name: item.name || item.symbol || 'Token',
        // Set to 0 because balance is already decimal-formatted
        contractDecimals: 0,
        balance: bal,
        usdValue: numQuote(item.usd_value),
        chain: chainKey
      };
    });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const moralisKey = (process.env.MORALIS_KEY || '').trim();
  if (!moralisKey) {
    return res.status(503).json({
      error: 'MORALIS_KEY is not set on the server (Vercel env / local .env).'
    });
  }

  const alchemyKey = (process.env.ALCHEMY_KEY || '').trim();

  const body = parseBody(req);
  const address = String(body.address || '').trim();
  const requestedChains = Array.isArray(body.chains) && body.chains.length
    ? body.chains
    : ['eth', 'bnb', 'base', 'polygon'];

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid EVM wallet address' });
  }

  const chainKeys = requestedChains.filter(k => MORALIS_CHAIN_MAP[k]);
  if (!chainKeys.length) {
    return res.status(400).json({ error: 'No supported chains requested' });
  }

  const out = {};

  await Promise.all(
    chainKeys.map(async (key) => {
      const moralisChain = MORALIS_CHAIN_MAP[key];
      const result = await moralisFetch(
        `/wallets/${address}/tokens?chain=${moralisChain}&include_native=true`,
        moralisKey
      );

      if (!result.ok) {
        out[key] = { tokens: [], error: result.error };
        return;
      }

      let tokens = mapMoralisItems(result.data?.result || [], key);

      // ETH mainnet: use Alchemy as backup if Moralis didn't return native ETH
      if (key === 'eth') {
        const hasNativeEth = tokens.some(
          t => t.contractAddress === '' && String(t.symbol).toUpperCase() === 'ETH'
        );
        if (!hasNativeEth && alchemyKey) {
          const ethBal = await alchemyGetEthBalance(address, alchemyKey);
          if (ethBal != null && ethBal > 0.000001) {
            tokens.unshift({
              contractTicker: 'ETH',
              symbol: 'ETH',
              contractAddress: '',
              name: 'Ethereum',
              contractDecimals: 0,
              balance: ethBal,
              usdValue: 0, // frontend prices native ETH via ethPrice
              chain: 'eth'
            });
          }
        }
      }

      out[key] = { tokens };
    })
  );

  // Return empty history — Moralis doesn't have equivalent portfolio history.
  // Frontend handles missing history gracefully (no sparkline rendered).
  if (body.history) {
    out.history = [];
  }

  return res.status(200).json(out);
}
