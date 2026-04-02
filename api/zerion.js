export default async function handler(req, res) {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'No address' });

  const key = process.env.ZERION_KEY;
  const encoded = Buffer.from(key + ':').toString('base64');
  const headers = { Authorization: `Basic ${encoded}`, accept: 'application/json' };

  try {
    const portfolioRes = await fetch(`https://api.zerion.io/v1/wallets/${address}/portfolio`, {
      headers
    });
    const portfolioData = await portfolioRes.json();

    // Paginate through all positions pages
    const allPositions = [];
    let nextUrl = `https://api.zerion.io/v1/wallets/${address}/positions?filter[position_types]=wallet&currency=usd&page[size]=100&sort=-value`;

    while (nextUrl) {
      const posRes = await fetch(nextUrl, { headers });
      const posData = await posRes.json();

      if (posData.data) {
        allPositions.push(...posData.data);
      }

      nextUrl = posData.links?.next || null;
    }

    const positionsData = { data: allPositions };

    const sortedByValue = [...allPositions].sort(
      (a, b) => (parseFloat(b?.attributes?.value) || 0) - (parseFloat(a?.attributes?.value) || 0)
    );
    const seenFungible = new Set();
    const fungibleIds = [];
    for (const p of sortedByValue) {
      const fid =
        p?.relationships?.fungible?.data?.id ||
        p?.attributes?.fungible_info?.id ||
        '';
      if (fid && !seenFungible.has(fid)) {
        seenFungible.add(fid);
        fungibleIds.push(fid);
        if (fungibleIds.length >= 100) break;
      }
    }

    const pnlWalletUrl = `https://api.zerion.io/v1/wallets/${address}/pnl?currency=usd`;
    const chartUrl = `https://api.zerion.io/v1/wallets/${address}/charts/month?currency=usd`;
    const pnlBreakdownUrl =
      fungibleIds.length > 0
        ? `${pnlWalletUrl}&filter[fungible_ids]=${fungibleIds.map(encodeURIComponent).join(',')}`
        : null;

    const [pnlWalletRes, chartRes, pnlBreakdownRes] = await Promise.all([
      fetch(pnlWalletUrl, { headers }),
      fetch(chartUrl, { headers }),
      pnlBreakdownUrl ? fetch(pnlBreakdownUrl, { headers }) : Promise.resolve(null)
    ]);

    let pnlWallet = null;
    if (pnlWalletRes.ok) {
      pnlWallet = await pnlWalletRes.json();
    }

    let chart = null;
    if (chartRes.ok) {
      chart = await chartRes.json();
    }

    let pnlByFungible = null;
    if (pnlBreakdownRes && pnlBreakdownRes.ok) {
      pnlByFungible = await pnlBreakdownRes.json();
    }

    res.json({ portfolio: portfolioData, positions: positionsData, pnlWallet, pnlByFungible, chart });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
