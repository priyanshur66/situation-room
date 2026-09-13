import { expect, it } from "vitest";
import { getEvidence } from "./graph";
import { enrichTokenMarkets } from "./token-markets";
import { discoverTokens } from "./token-discovery";
import { rpc, contracts } from "./chain";
import { trackedTokens } from "./portfolio";

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
  },
  90000,
);
