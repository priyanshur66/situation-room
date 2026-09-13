import { describe, expect, it } from "vitest";
import { parseTokenMarkets } from "./token-markets";
import { sample } from "./__fixtures__/snapshot";
import { contracts } from "./chain";
import { trackedTokens } from "./portfolio";

const token = Object.keys(trackedTokens)[0],
  now = 1789300000000;
const pool = {
  id: "0x0000000000000000000000000000000000000004",
  feeTier: "3000",
  token0: { id: token },
  token1: { id: contracts.usdc },
  token0Price: "500",
  token1Price: "0.002",
  totalValueLockedUSD: "100000",
  poolDayData: [
    {
      date: 1789257600,
      token0Price: "500",
      token1Price: "0.002",
      volumeUSD: "1000",
      tvlUSD: "100000",
    },
  ],
};
const data = () => ({
  _meta: {
    block: { number: 100, timestamp: now / 1000 },
    hasIndexingErrors: false,
  },
  forward: [pool],
  reverse: [],
});
describe("indexed extra-token market evidence", () => {
  it("orients direct USDC prices correctly, without multiplying by ETH", () => {
    const result = parseTokenMarkets(
      data(),
      [token],
      sample.pools[0],
      "test",
      now,
    );
    expect(result[0].market).toMatchObject({
      priceUsd: 0.002,
      quoteToken: "USDC",
      liquidityUsd: 100000,
    });
    expect(result[0].market.history[0].priceUsd).toBe(0.002);
    const reverse = {
      ...pool,
      token0: pool.token1,
      token1: pool.token0,
      token0Price: "0.002",
      token1Price: "500",
    };
    expect(
      parseTokenMarkets(
        { ...data(), forward: [], reverse: [reverse] },
        [token],
        sample.pools[0],
        "test",
        now,
      )[0].market.priceUsd,
    ).toBe(0.002);
  });
  it("composes WETH prices with matching historical ETH dates only", () => {
    const p = { ...pool, token1: { id: contracts.weth } };
    const result = parseTokenMarkets(
      { ...data(), forward: [p] },
      [token],
      sample.pools[0],
      "test",
      now,
    )[0].market;
    expect(result.priceUsd).toBe(0.002 * sample.pools[0].price);
    expect(result.history).toEqual([
      { date: pool.poolDayData[0].date, priceUsd: 5.034 },
    ]);
    expect(
      parseTokenMarkets(
        { ...data(), forward: [p] },
        [token],
        { ...sample.pools[0], days: [] },
        "test",
        now,
      )[0].market.history,
    ).toEqual([]);
  });
  it("rejects stale/error evidence and ignores low-liquidity or mismatched pools", () => {
    expect(() =>
      parseTokenMarkets(data(), [token], sample.pools[0], "test", now + 301000),
    ).toThrow();
    const invalid = [
      { ...pool, totalValueLockedUSD: "9999" },
      { ...pool, token1: { id: "0x0000000000000000000000000000000000000005" } },
      { ...pool, token1Price: "NaN" },
    ];
    expect(
      parseTokenMarkets(
        { ...data(), forward: invalid },
        [token],
        sample.pools[0],
        "test",
        now,
      ),
    ).toEqual([]);
  });
});
