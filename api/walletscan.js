export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { address, chainId = '8453' } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const GOLDRUSH_KEY = process.env.GOLDRUSH_API_KEY;
  const ZERION_KEY = process.env.ZERION_KEY;

  const [goldRushRes, zerionRes] = await Promise.allSettled([
    fetch(`https://api.covalenthq.com/v1/${chainId}/address/${address}/balances_v2/?key=${GOLDRUSH_KEY}`).then(r => r.json()),
    fetch(`https://api.zerion.io/v1/wallets/${address}/positions/?filter[position_types]=wallet`, {
      headers: { Authorization: `Basic ${Buffer.from(ZERION_KEY + ':').toString('base64')}` }
    }).then(r => r.json())
  ]);

  if (goldRushRes.status === 'rejected' && zerionRes.status === 'rejected') {
    return res.status(500).json({ error: 'Both data sources unavailable' });
  }

  const goldRushTokens = goldRushRes.status === 'fulfilled' ? (goldRushRes.value?.data?.items || []) : [];
  const zerionData = zerionRes.status === 'fulfilled' ? zerionRes.value : {};
  const zerionPositions = Array.isArray(zerionData?.data) ? zerionData.data : [];

  const zerionMap = {};
  zerionPositions.forEach(p => {
    const addr = p?.relationships?.fungible?.data?.id || '';
    if (addr) zerionMap[addr.toLowerCase()] = p;
  });

  const merged = goldRushTokens
    .filter(token => (token.quote || 0) >= 0.01)
    .map(token => {
      const ca = (token.contract_address || '').toLowerCase();
      const zerionMatch = zerionMap[ca];
      const usdValue = zerionMatch != null ? (zerionMatch.attributes?.value ?? 0) : 0;
      const price = zerionMatch != null ? (zerionMatch.attributes?.price ?? 0) : 0;
      const isUnindexed = !zerionMatch;
      return {
        symbol: token.contract_ticker_symbol,
        name: token.contract_name,
        contractAddress: token.contract_address,
        balance: token.balance,
        decimals: token.contract_decimals,
        usdValue,
        price,
        chain: chainId,
        source: isUnindexed ? 'goldrush_only' : 'merged',
        isLowCap: isUnindexed,
        isNewOrUnindexed: isUnindexed
      };
    });

  merged.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));

  const portfolioTotal = zerionData.portfolio?.data?.attributes?.total?.positions || 0;

  merged.forEach(token => {
    console.log(`[walletscan] symbol=${token.symbol} usdValue=${token.usdValue} source=${token.source}`);
  });

  return res.status(200).json({ portfolioTotal, tokens: merged, success: true, totalTokens: merged.length });
}
