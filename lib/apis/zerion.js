function zerionHeaders() {
  const key = (process.env.ZERION_KEY || '').trim();
  if (!key) return null;
  const encoded = Buffer.from(`${key}:`).toString('base64');
  return { Authorization: `Basic ${encoded}`, accept: 'application/json' };
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Zerion request failed (${res.status})`);
  return res.json();
}

export async function fetchZerionWallet(wallet) {
  if (!wallet) return {};
  const headers = zerionHeaders();
  if (!headers) return { error: 'ZERION_KEY missing' };

  const [portfolio, positions, txs] = await Promise.allSettled([
    fetchJson(`https://api.zerion.io/v1/wallets/${wallet}/portfolio/?currency=usd`, headers),
    fetchJson(`https://api.zerion.io/v1/wallets/${wallet}/positions/?filter[position_types]=wallet&currency=usd&page[size]=100&sort=-value`, headers),
    fetchJson(`https://api.zerion.io/v1/wallets/${wallet}/transactions/?currency=usd&page[size]=50&sort=-operation_at`, headers),
  ]);

  return {
    portfolio: portfolio.status === 'fulfilled' ? portfolio.value : null,
    positions: positions.status === 'fulfilled' ? positions.value : null,
    transactions: txs.status === 'fulfilled' ? txs.value : null,
  };
}
