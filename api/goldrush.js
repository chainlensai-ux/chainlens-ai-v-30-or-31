export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { address, chainId = '1' } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const key = process.env.GOLDRUSH_API_KEY;
  if (!key) return res.status(500).json({ error: 'GOLDRUSH_API_KEY not set' });

  try {
    const [balances, nfts] = await Promise.all([
      fetch(`https://api.covalenthq.com/v1/${chainId}/address/${address}/balances_v2/?key=${key}`).then(r => r.json()),
      fetch(`https://api.covalenthq.com/v1/${chainId}/address/${address}/nft_holdings/?key=${key}`).then(r => r.json())
    ]);
    return res.status(200).json({ success: true, balances: balances.data, nfts: nfts.data });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
