import { describe, expect, it, vi } from "vitest";
import { parseUnits } from "viem";
import { chooseFunding } from "./liquidation-planner";
import type { Quote } from "./model";

function quotes(gas: Record<"ETH" | "WETH", number>) {
  return vi.fn(
    async (asset: "ETH" | "WETH", input: string): Promise<Quote> => ({
      source: "live",
      asset,
      amountIn: input,
      amountOut: (Number(input) * 2000 * 0.998).toFixed(6),
      minimumOut: (Number(input) * 2000 * 0.995).toFixed(6),
      gasUsd: gas[asset],
      gasUnits: "100000",
      fee: 500,
      pool: "0x0000000000000000000000000000000000000001",
      block: 1,
      expiresAt: Date.now() + 60000,
      priceImpactPct: 0.2,
      alternatives: [],
      transactions: [],
    }),
  );
}
const candidates = [
  { symbol: "ETH" as const, spendable: parseUnits("1", 18) },
  { symbol: "WETH" as const, spendable: parseUnits("1", 18) },
];
describe("payment liquidation sequence selection", () => {
  it("selects ETH when WETH approval gas makes WETH more expensive", async () => {
    const result = await chooseFunding(
      candidates,
      5000000n,
      2000,
      parseUnits("2", 18),
      100000n,
      quotes({ ETH: 0.01, WETH: 0.04 }),
    );
    expect(result.selected.quotes[0].asset).toBe("ETH");
    expect(result.alternatives).toHaveLength(2);
  });
  it("selects WETH when its executable costs are lower", async () => {
    const result = await chooseFunding(
      candidates,
      5000000n,
      2000,
      parseUnits("2", 18),
      100000n,
      quotes({ ETH: 0.04, WETH: 0.01 }),
    );
    expect(result.selected.quotes[0].asset).toBe("WETH");
  });
  it("combines two eligible positions when neither can cover the target alone", async () => {
    const result = await chooseFunding(
      candidates.map((c) => ({ ...c, spendable: parseUnits(".002", 18) })),
      5000000n,
      2000,
      parseUnits(".01", 18),
      100000n,
      quotes({ ETH: 0.01, WETH: 0.01 }),
    );
    expect(result.selected.quotes).toHaveLength(2);
    expect(
      result.selected.quotes.reduce((s, q) => s + Number(q.minimumOut), 0),
    ).toBeGreaterThanOrEqual(5);
  });
  it("excludes the cheaper native route if it leaves too little ETH for payment gas", async () => {
    const result = await chooseFunding(
      candidates,
      5000000n,
      2000,
      parseUnits(".001", 18),
      100000n,
      quotes({ ETH: 0.001, WETH: 0.02 }),
    );
    expect(result.selected.quotes[0].asset).toBe("WETH");
    expect(result.alternatives).toHaveLength(1);
  });
  it("does not quote or sell when existing USDC covers the payment", async () => {
    const quote = quotes({ ETH: 0.01, WETH: 0.01 });
    const result = await chooseFunding([], 0n, 2000, 1000000n, 100000n, quote);
    expect(result.selected.quotes).toHaveLength(0);
    expect(quote).not.toHaveBeenCalled();
  });
  it("fails closed when no eligible funds or gas can cover the payment", async () => {
    await expect(
      chooseFunding(
        [],
        5000000n,
        2000,
        1000000n,
        100000n,
        quotes({ ETH: 0.01, WETH: 0.01 }),
      ),
    ).rejects.toThrow("No eligible");
    await expect(
      chooseFunding(
        [],
        0n,
        2000,
        0n,
        100000n,
        quotes({ ETH: 0.01, WETH: 0.01 }),
      ),
    ).rejects.toThrow("No eligible");
  });
});
