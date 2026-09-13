import { formatUnits, parseUnits } from "viem";
import { parseAmount, type Quote } from "./model";

export type FundingCandidate = {
  symbol: "ETH" | "WETH";
  spendable: bigint;
};
export type FundingChoice = {
  quotes: Quote[];
  estimatedCostUsd: number;
  gasBudgetUsd: number;
  nativeRequired: bigint;
};

// Compare both supported asset orders, including one-asset and split funding.
// This is bounded route comparison, not a claim of global optimality across DEXes.
export async function chooseFunding(
  candidates: FundingCandidate[],
  shortfall: bigint,
  price: number,
  nativeBalance: bigint,
  paymentReserve: bigint,
  quote: (asset: "ETH" | "WETH", input: string) => Promise<Quote>,
): Promise<{ selected: FundingChoice; alternatives: FundingChoice[] }> {
  if (!Number.isFinite(price) || price <= 0)
    throw new Error("A current positive ETH price is required.");
  const orders =
    candidates.length > 1
      ? [candidates, [...candidates].reverse()]
      : [candidates];
  const cache = new Map<string, Promise<Quote>>();
  const getQuote = (symbol: "ETH" | "WETH", input: bigint) => {
    const key = `${symbol}:${input}`;
    if (!cache.has(key)) cache.set(key, quote(symbol, formatUnits(input, 18)));
    return cache.get(key)!;
  };
  const feasible: FundingChoice[] = [];
  for (const order of orders) {
    let remaining = shortfall;
    const quotes: Quote[] = [];
    for (const asset of order) {
      if (!remaining) break;
      if (asset.spendable <= 0n) continue;
      let input = BigInt(
        Math.ceil((Number(formatUnits(remaining, 6)) / price) * 1.01 * 1e18),
      );
      if (input > asset.spendable) input = asset.spendable;
      try {
        let q = await getQuote(asset.symbol, input);
        for (
          let attempt = 0;
          attempt < 2 &&
          parseAmount(q.minimumOut, 6) < remaining &&
          input < asset.spendable;
          attempt++
        ) {
          input =
            (input * remaining) / parseAmount(q.minimumOut, 6) +
            input / 1000n +
            1n;
          if (input > asset.spendable) input = asset.spendable;
          q = await getQuote(asset.symbol, input);
        }
        if (
          q.asset !== asset.symbol ||
          parseAmount(q.amountIn, 18) > asset.spendable ||
          q.expiresAt <= Date.now()
        )
          throw new Error(
            "The funding quote is stale or exceeds the eligible balance.",
          );
        quotes.push(q);
        const output = parseAmount(q.minimumOut, 6);
        remaining = remaining > output ? remaining - output : 0n;
      } catch {
        // Another eligible asset/order may still cover the payment; never assume output.
      }
    }
    if (remaining) continue;
    const gasBudgetUsd = quotes.reduce((sum, q) => sum + q.gasUsd, 0);
    const nativeInput = quotes.reduce(
      (sum, q) => sum + (q.asset === "ETH" ? parseUnits(q.amountIn, 18) : 0n),
      0n,
    );
    const nativeRequired =
      nativeInput +
      BigInt(Math.ceil((gasBudgetUsd / price) * 1e18)) +
      paymentReserve;
    if (nativeRequired > nativeBalance) continue;
    const estimatedCostUsd = quotes.reduce(
      (sum, q) =>
        sum + Math.max(0, Number(q.amountIn) * price - Number(q.amountOut)),
      gasBudgetUsd,
    );
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) continue;
    feasible.push({ quotes, estimatedCostUsd, gasBudgetUsd, nativeRequired });
  }
  feasible.sort(
    (a, b) =>
      a.estimatedCostUsd - b.estimatedCostUsd ||
      a.quotes.length - b.quotes.length,
  );
  if (!feasible.length)
    throw new Error(
      "No eligible liquidation sequence covers this payment and its ETH gas reserve. Try a smaller amount or review your preferences.",
    );
  return { selected: feasible[0], alternatives: feasible };
}
