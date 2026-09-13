import { describe, expect, it } from "vitest";
import { parseEvidence } from "./graph";
const now = 1800000000000;
const fixture = () => ({
  _meta: {
    block: { number: 100, timestamp: now / 1000 - 10 },
    hasIndexingErrors: false,
  },
  pools: [
    {
      id: "0x6c561b446416e1a00e8e93e221854d6ea4171372",
      feeTier: "3000",
      token1Price: "2500",
      totalValueLockedUSD: "1000000",
      poolDayData: Array.from({ length: 8 }, (_, i) => ({
        date: now / 1000 - (i + 1) * 86400,
        token1Price: "2500",
        volumeUSD: "1000",
        tvlUSD: "1000000",
      })),
    },
  ],
});
describe("indexed evidence boundary", () => {
  it("reads USD per WETH with source block and timestamp", () =>
    expect(parseEvidence(fixture(), now).pools[0].price).toBe(2500));
  it("rejects stale indexes", () => {
    const d = fixture();
    d._meta.block.timestamp -= 301;
    expect(() => parseEvidence(d, now)).toThrow(/stale/);
  });
  it("rejects indexing errors", () => {
    const d = fixture();
    d._meta.hasIndexingErrors = true;
    expect(() => parseEvidence(d, now)).toThrow();
  });
  it("rejects nonfinite market numbers", () => {
    const d = fixture();
    d.pools[0].token1Price = "NaN";
    expect(() => parseEvidence(d, now)).toThrow();
  });
  it("rejects insufficient history", () => {
    const d = fixture();
    d.pools[0].poolDayData = [];
    expect(() => parseEvidence(d, now)).toThrow();
  });
  it("rejects unsupported pool fee tiers", () => {
    const d = fixture();
    d.pools[0].feeTier = "2500";
    expect(() => parseEvidence(d, now)).toThrow();
  });
});
