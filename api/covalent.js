export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { address, chains } = req.body || {};
  if (!address) return res.status(400).json({ error: 'No address provided' });

  const COVALENT_KEY = process.env.COVALENT_API_KEY || '';
  if (!COVALENT_KEY) {
    return res.status(500).json({ error: 'COVALENT_API_KEY not configured', code: 'MISSING_KEY' });
  }

  // Default to all supported EVM chains if not specified
  const CHAIN_MAP = {
    eth: 'eth-mainnet',
    bnb: 'bsc-mainnet',
    base: 'base-mainnet',
    polygon: 'matic-mainnet',
    arbitrum: 'arbitrum-mainnet',
  };

  const requestedChains = Array.isArray(chains) ? chains : Object.keys(CHAIN_MAP);
  const BASE = 'https://api.covalenthq.com/v1';

  try {
    const results = await Promise.allSettled(
      requestedChains.map(async (chainKey) => {
        const chainName = CHAIN_MAP[chainKey];
        if (!chainName) return { chain: chainKey, tokens: [], error: 'Unknown chain' };

        const r = await fetch(
          `${BASE}/${chainName}/address/${address}/balances_v2/?no-spam=true&no-nft-asset-metadata=true`,
          {
            headers: {
              Authorization: `Bearer ${COVALENT_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!r.ok) {
          const errText = await r.text();
          return { chain: chainKey, tokens: [], error: `HTTP ${r.status}` };
        }

        const data = await r.json();
        const items = (data?.data?.items || [])
          .filter(item => item.balance && item.balance !== '0')
          .map(item => {
            const decimals = item.contract_decimals || 18;
            const balance = parseInt(item.balance || '0') / Math.pow(10, decimals);
            return {
              symbol: item.contract_ticker_symbol || '?',
              name: item.contract_name || 'Unknown',
              contractAddress: item.contract_address,
              balance,
              usdValue: item.quote || 0,
              price: item.quote_rate || 0,
              chain: chainKey,
              logo: item.logo_url || null,
            };
          })
          .filter(t => t.balance > 0)
          .slice(0, 25);

        return { chain: chainKey, tokens: items };
      })
    );

    const output = {};
    results.forEach((result, i) => {
      const chainKey = requestedChains[i];
      if (result.status === 'fulfilled') {
        output[chainKey] = result.value;
      } else {
        output[chainKey] = { chain: chainKey, tokens: [], error: result.reason?.message || 'Failed' };
      }
    });

    return res.status(200).json(output);
  } catch (err) {
    console.error('Covalent proxy error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
