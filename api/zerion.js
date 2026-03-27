export default async function handler(req, res) {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'No address' });

  const key = process.env.ZERION_KEY;
  const encoded = Buffer.from(key + ':').toString('base64');

  try {
    const portfolioRes = await fetch(`https://api.zerion.io/v1/wallets/${address}/portfolio`, {
      headers: { 'Authorization': `Basic ${encoded}`, 'accept': 'application/json' }
    });
    const portfolioData = await portfolioRes.json();

    // Paginate through all positions pages
    const allPositions = [];
    let nextUrl = `https://api.zerion.io/v1/wallets/${address}/positions?filter[position_types]=wallet&currency=usd&page[size]=100&sort=-value`;

    while (nextUrl) {
      const posRes = await fetch(nextUrl, {
        headers: { 'Authorization': `Basic ${encoded}`, 'accept': 'application/json' }
      });
      const posData = await posRes.json();

      if (posData.data) {
        allPositions.push(...posData.data);
      }

      nextUrl = posData.links?.next || null;
    }

    const positionsData = { data: allPositions };

    res.json({ portfolio: portfolioData, positions: positionsData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
