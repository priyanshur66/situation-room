import type { Snapshot } from "./model";

export type Sector =
  | "ETH ecosystem"
  | "Stablecoins"
  | "DeFi"
  | "Meme / social"
  | "Tokenized equities"
  | "Unclassified";
export const trackedTokens: Record<
  string,
  { symbol: string; name: string; sector: Sector }
> = {
  "0x4ed4e862860bed51a9570b96d89af5e1b0efefed": {
    symbol: "DEGEN",
    name: "Degen",
    sector: "Meme / social",
  },
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": {
    symbol: "AERO",
    name: "Aerodrome",
    sector: "DeFi",
  },
  "0xb200000000000000000000c2e324d24d7eecd1fb": {
    symbol: "AAPLc",
    name: "Tokenized Apple",
    sector: "Tokenized equities",
  },
  "0xb20000000000000000000078ee7ce2fe4908108c": {
    symbol: "NVDAc",
    name: "Tokenized NVIDIA",
    sector: "Tokenized equities",
  },
};
export type DiscoveredHolding = {
  contract: string;
  symbol: string;
  name: string;
  sector: Sector;
  recognized: boolean;
  units: string | null;
  decimals: number | null;
  indexedBlock: number | null;
  market?: TokenMarket;
};
export type TokenMarket = {
  source: "The Graph / Uniswap V3";
  subgraphId: string;
  indexedBlock: number;
  indexedAt: number;
  pool: string;
  fee: number;
  quoteToken: "WETH" | "USDC";
  priceUsd: number;
  liquidityUsd: number;
  latestDayVolumeUsd: number | null;
  history: { date: number; priceUsd: number }[];
};
export type PortfolioDiscovery = {
  source: "The Graph Token API / Pinax";
  status: "complete" | "partial" | "unavailable";
  rpcBlock: number;
  pages: number;
  rejectedRows: number;
  holdings: DiscoveredHolding[];
  note: string;
  marketNote?: string;
};

export function sectorExposure(snapshot: Snapshot) {
  const sectors = new Map<
    Sector,
    { sector: Sector; assets: string[]; valuedUsd: number; unpriced: number }
  >();
  function add(sector: Sector, asset: string, value: number | null) {
    const row = sectors.get(sector) ?? {
      sector,
      assets: [],
      valuedUsd: 0,
      unpriced: 0,
    };
    row.assets.push(asset);
    if (value === null) row.unpriced++;
    else row.valuedUsd += value;
    sectors.set(sector, row);
  }
  for (const h of snapshot.holdings)
    if (Number(h.units) > 0)
      add(
        h.symbol === "USDC" ? "Stablecoins" : "ETH ecosystem",
        h.symbol,
        h.valueUsd,
      );
  for (const h of snapshot.discovery?.holdings ?? [])
    if (h.units !== null && Number(h.units) > 0) {
      const value = h.market ? Number(h.units) * h.market.priceUsd : null;
      add(
        h.sector,
        h.symbol,
        value !== null && Number.isFinite(value) ? value : null,
      );
    }
  return [...sectors.values()];
}
