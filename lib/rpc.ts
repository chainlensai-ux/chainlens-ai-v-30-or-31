export const RPC = {
  eth: process.env.ALCHEMY_ETHEREUM_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETHEREUM_KEY}` : "",
  base: process.env.ALCHEMY_BASE_RPC_URL || (process.env.ALCHEMY_BASE_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : ""),
  polygon: process.env.ALCHEMY_POLYGON_KEY ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POLYGON_KEY}` : "",
  bnb: process.env.ALCHEMY_BNB_KEY ? `https://bnb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BNB_KEY}` : "",
};
