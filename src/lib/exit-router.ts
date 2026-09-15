import { quoteAssetExit } from "./token-exit";
import { quoteAerodromeExit } from "./aerodrome";
import { rpc } from "./chain";
import type { ExecutionAsset, Quote, Snapshot } from "./model";

export async function quoteBestExit(
  wallet: string,
  asset: ExecutionAsset,
  amount: string,
  snapshot: Snapshot,
  client = rpc(),
  lifetimeMs = 60000,
): Promise<Quote> {
  const results = await Promise.allSettled([
    quoteAssetExit(wallet, asset, amount, snapshot, client, lifetimeMs),
    quoteAerodromeExit(wallet, asset, amount, snapshot, client, lifetimeMs),
  ]);
  const quotes = results.flatMap((result, index) =>
    result.status === "fulfilled"
      ? [
          {
            ...result.value,
            venue:
              index === 0 ? ("Uniswap V3" as const) : ("Aerodrome" as const),
          },
        ]
      : [],
  );
  if (!quotes.length)
    throw new Error(
      "No executable route is available on Uniswap V3 or Aerodrome. Check balances, gas, market freshness and token transfer restrictions.",
    );
  quotes.sort(
    (a, b) => Number(b.amountOut) - b.gasUsd - (Number(a.amountOut) - a.gasUsd),
  );
  return {
    ...quotes[0],
    venueComparison: quotes.map((q) => ({
      venue: q.venue,
      output: q.amountOut,
      gasUsd: q.gasUsd,
    })),
  };
}
