import type { Snapshot } from "./model";
const prices = [
  2708, 2685, 2730, 2721, 2690, 2664, 2710, 2655, 2675, 2614, 2642, 2575, 2558,
  2517,
];
export const sample: Snapshot = {
  mode: "sample",
  wallet: "Illustrative wallet",
  fetchedAt: Date.UTC(2026, 8, 13, 8),
  indexedAt: Date.UTC(2026, 8, 13, 7, 58) / 1000,
  block: 51248000,
  rpcBlock: 51248030,
  subgraphId: "96eJ9Go8gFjySRGnndG7EYxThaiwVDV8BYPp1TMDcoYh",
  holdings: [
    { symbol: "ETH", units: "2.4", valueUsd: 6040.8 },
    { symbol: "WETH", units: "0.8", valueUsd: 2013.6 },
    { symbol: "USDC", units: "1450", valueUsd: 1450 },
  ],
  pools: [
    {
      address: "0x6c561b446416e1a00e8e93e221854d6ea4171372",
      fee: 3000,
      tvlUsd: 12400000,
      price: 2517,
      days: prices.map((price, i) => ({
        date: Date.UTC(2026, 7, 31 + i) / 1000,
        price,
        volumeUsd: i === 12 ? 8300000 : 2700000 + i * 27000,
        tvlUsd: i >= 12 ? 12400000 : 15800000 + i * 10000,
      })),
    },
  ],
};
