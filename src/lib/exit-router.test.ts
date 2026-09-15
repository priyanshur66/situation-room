import { beforeEach, expect, it, vi } from "vitest";
import { quoteBestExit } from "./exit-router";
import { quoteAssetExit } from "./token-exit";
import { quoteAerodromeExit } from "./aerodrome";
import { sample } from "./__fixtures__/snapshot";
import type { Quote } from "./model";
vi.mock("./token-exit", () => ({ quoteAssetExit: vi.fn() }));
vi.mock("./aerodrome", () => ({ quoteAerodromeExit: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
function quote(output: string, gas: number): Quote {
  return {
    source: "live",
    asset: "ETH",
    amountIn: "0.01",
    amountOut: output,
    minimumOut: "19",
    gasUsd: gas,
    gasUnits: "100000",
    fee: 3000,
    pool: sample.pools[0].address,
    block: 1,
    expiresAt: Date.now() + 60000,
    priceImpactPct: 0,
    alternatives: [],
    transactions: [],
  };
}
it("compares venues after estimated gas rather than picking the largest gross amount", async () => {
  vi.mocked(quoteAssetExit).mockResolvedValue(quote("20", 0.5));
  vi.mocked(quoteAerodromeExit).mockResolvedValue(quote("19.9", 0.1));
  const result = await quoteBestExit(sample.wallet, "ETH", "0.01", sample);
  expect(result.venue).toBe("Aerodrome");
  expect(result.venueComparison).toHaveLength(2);
});
it("keeps a verified venue available when the other cannot quote", async () => {
  vi.mocked(quoteAssetExit).mockResolvedValue(quote("20", 0.1));
  vi.mocked(quoteAerodromeExit).mockRejectedValue(new Error("Unavailable"));
  expect(
    (await quoteBestExit(sample.wallet, "ETH", "0.01", sample)).venue,
  ).toBe("Uniswap V3");
});
it("fails closed without exposing provider errors when neither venue is executable", async () => {
  vi.mocked(quoteAssetExit).mockRejectedValue(
    new Error("private provider error"),
  );
  vi.mocked(quoteAerodromeExit).mockRejectedValue(
    new Error("private provider error"),
  );
  await expect(
    quoteBestExit(sample.wallet, "ETH", "0.01", sample),
  ).rejects.toThrow("No executable route");
});
