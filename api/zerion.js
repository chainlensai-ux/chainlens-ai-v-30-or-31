export default async function handler(req, res) {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'No address' });

  const key = process.env.ZERION_KEY;
  const encoded = Buffer.from(key + ':').toString('base64');

  try {
    const [portfolio, positions] = await Promise.all([
      fetch(`https://api.zerion.io/v1/wallets/${address}/portfolio`, {
        headers: { 'Authorization': `Basic ${encoded}`, 'accept': 'application/json' }
      }),
      fetch(`https://api.zerion.io/v1/wallets/${address}/positions?filter[position_types]=wallet&currency=usd`, {
        headers: { 'Authorization': `Basic ${encoded}`, 'accept': 'application/json' }
      })
    ]);

    const portfolioData = await portfolio.json();
    const positionsData = await positions.json();

    res.json({ portfolio: portfolioData, positions: positionsData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
