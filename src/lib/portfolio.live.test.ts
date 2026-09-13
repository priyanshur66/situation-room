import { expect, it } from "vitest";
import { getEvidence } from "./graph";
import { enrichTokenMarkets } from "./token-markets";
import { discoverTokens } from "./token-discovery";
import { rpc, contracts } from "./chain";
import { trackedTokens } from "./portfolio";
import { quoteAssetExit } from "./token-exit";

it.skipIf(process.env.RUN_PORTFOLIO_LIVE !== "1")(
  "reads indexed token markets and verifies public-address balances without signing",
  async () => {
    const evidence = await getEvidence();
    const client = rpc();
    const block = await client.getBlockNumber();
    const discovery = await discoverTokens(contracts.weth, block, client);
    expect(discovery.pages).toBeGreaterThan(0);
    expect(discovery.rpcBlock).toBe(Number(block));
    // A one-unit input requests price evidence only; no synthetic holdings are saved.
    const contract = Object.keys(trackedTokens)[0];
    const enriched = await enrichTokenMarkets(
      {
        ...discovery,
        holdings: [
          {
            contract,
            ...trackedTokens[contract],
            recognized: true,
            units: "1",
            decimals: 18,
            indexedBlock: null,
          },
        ],
      },
      evidence.pools[0],
      client,
    );
    expect(enriched.holdings[0].market?.priceUsd).toBeGreaterThan(0);
    expect(enriched.holdings[0].market?.liquidityUsd).toBeGreaterThanOrEqual(
      10000,
    );
    // Use a public pool's actual token balance for read-only call simulation.
    // Only its native gas balance is synthetic; nothing is signed or persisted.
    const holder = enriched.holdings[0].market!.pool;
    const quote = await quoteAssetExit(
      holder,
      "DEGEN",
      "1",
      {
        ...evidence,
        mode: "live",
        wallet: holder,
        fetchedAt: Date.now(),
        rpcBlock: Number(block),
        holdings: [],
        discovery: enriched,
      },
      { ...client, getBalance: async () => 1000000000000000000n } as ReturnType<
        typeof rpc
      >,
    );
    expect(Number(quote.minimumOut)).toBeGreaterThan(0);
    expect(quote.route?.assets[0]).toBe("DEGEN");
    expect(quote.route?.assets.at(-1)).toBe("USDC");
  },
  90000,
);
