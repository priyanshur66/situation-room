import { formatUnits, parseUnits } from "viem";
import { parseAmount, type Quote, type ExecutionAsset } from "./model";

export type FundingCandidate<A extends ExecutionAsset = ExecutionAsset> = {
  symbol: A;
  spendable: bigint;
  decimals?: number;
  priceUsd?: number;
};
export type FundingChoice = {
  quotes: Quote[];
  estimatedCostUsd: number;
  gasBudgetUsd: number;
  nativeRequired: bigint;
};

// Compare bounded supported asset orders, including one-asset and split funding.
// This is bounded route comparison, not a claim of global optimality across DEXes.
export async function chooseFunding<A extends ExecutionAsset>(
  candidates: FundingCandidate<A>[],
  shortfall: bigint,
  price: number,
  nativeBalance: bigint,
  paymentReserve: bigint,
  quote: (asset: A, input: string) => Promise<Quote>,
): Promise<{ selected: FundingChoice; alternatives: FundingChoice[] }> {
  if (!Number.isFinite(price) || price <= 0)
    throw new Error("A current positive ETH price is required.");
  const eligible = candidates.filter((c) => {
    const tokenPrice =
      c.priceUsd ?? (c.symbol === "ETH" || c.symbol === "WETH" ? price : NaN);
    const decimals = c.decimals ?? 18;
    return (
      Number.isFinite(tokenPrice) &&
      tokenPrice > 0 &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 36
    );
  });
  // Each asset gets first priority; reverse rotations also compare split exits.
  // Bounded to this allowlist, not global optimization across every DEX/token.
  const orders =
    eligible.length > 1
      ? eligible
          .flatMap((_, i) => {
            const rotated = [...eligible.slice(i), ...eligible.slice(0, i)];
            return [rotated, [...rotated].reverse()];
          })
          .filter(
            (order, i, all) =>
              all.findIndex(
                (other) =>
                  other.map((c) => c.symbol).join() ===
                  order.map((c) => c.symbol).join(),
              ) === i,
          )
      : [eligible];
  const cache = new Map<string, Promise<Quote>>();
  const getQuote = (candidate: FundingCandidate<A>, input: bigint) => {
    const key = `${candidate.symbol}:${input}`;
    if (!cache.has(key))
      cache.set(
        key,
        quote(candidate.symbol, formatUnits(input, candidate.decimals ?? 18)),
      );
    return cache.get(key)!;
  };
  const feasible: FundingChoice[] = [];
  for (const order of orders) {
    let remaining = shortfall;
    const quotes: Quote[] = [];
    for (const asset of order) {
      if (!remaining) break;
      if (asset.spendable <= 0n) continue;
      const tokenPrice = asset.priceUsd ?? price;
      const decimals = asset.decimals ?? 18;
      const estimate = Math.ceil(
        (Number(formatUnits(remaining, 6)) / tokenPrice) *
          1.01 *
          10 ** decimals,
      );
      if (!Number.isFinite(estimate) || estimate <= 0) continue;
      let input = BigInt(estimate);
      if (input > asset.spendable) input = asset.spendable;
      try {
        let q = await getQuote(asset, input);
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
          q = await getQuote(asset, input);
        }
        if (
          q.asset !== asset.symbol ||
          parseAmount(q.amountIn, decimals) !== input ||
          parseAmount(q.amountIn, decimals) > asset.spendable ||
          !Number.isFinite(q.gasUsd) ||
          q.gasUsd < 0 ||
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
        sum +
        Math.max(
          0,
          Number(q.amountIn) *
            (eligible.find((c) => c.symbol === q.asset)?.priceUsd ?? price) -
            Number(q.amountOut),
        ),
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
