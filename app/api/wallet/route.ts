import { NextResponse } from "next/server";

const RPC = {
  eth: "https://eth.llamarpc.com",
  base: "https://mainnet.base.org",
  polygon: "https://polygon-rpc.com",
  bnb: "https://bsc-dataseed.bnbchain.org:443",
};

type ChainConfig = {
  name: string;
  rpc: string;
  nativeSymbol: string;
  chainId: number;
};

const CHAINS: Record<string, ChainConfig> = {
  eth: { name: "Ethereum", rpc: RPC.eth, nativeSymbol: "ETH", chainId: 1 },
  base: { name: "Base", rpc: RPC.base, nativeSymbol: "ETH", chainId: 8453 },
  polygon: { name: "Polygon", rpc: RPC.polygon, nativeSymbol: "MATIC", chainId: 137 },
  bnb: { name: "BNB Chain", rpc: RPC.bnb, nativeSymbol: "BNB", chainId: 56 },
};

async function getNativeBalance(rpc: string, address: string) {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
    });
    const data = await res.json();
    return data.result ? parseInt(data.result, 16) / 1e18 : 0;
  } catch {
    return 0;
  }
}

async function getTransactions(chainId: number, address: string) {
  try {
    const apiKey = process.env.COVALENT_API_KEY;
    const url = `https://api.covalenthq.com/v1/${chainId}/address/${address}/transactions_v2/?key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.data?.items || [];
  } catch {
    return [];
  }
}

export async function POST(req: Request) {
  try {
    const { address } = await req.json();

    if (!address) {
      return NextResponse.json({ error: "Missing wallet address" }, { status: 400 });
    }

    const results: Record<string, any> = {};

    for (const key of Object.keys(CHAINS)) {
      const chain = CHAINS[key];
      const [balance, txs] = await Promise.all([
        getNativeBalance(chain.rpc, address),
        getTransactions(chain.chainId, address),
      ]);

      results[key] = {
        chain: chain.name,
        nativeBalance: balance,
        transactions: txs,
      };
    }

    return NextResponse.json({ address, results });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Server error", details: err.message },
      { status: 500 }
    );
  }
}
