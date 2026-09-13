import { expect, it } from "vitest";
import { getEvidence } from "./graph";
import { quoteExit, planFunding, rpc } from "./chain";
import type { Snapshot } from "./model";

it.skipIf(process.env.RUN_LIVE_TESTS !== "1")(
  "quotes and simulates a Base ETH exit with synthetic balance, without signing or broadcasting",
  async () => {
    const evidence = await getEvidence(),
      live = rpc();
    const wallet = "0x0000000000000000000000000000000000000001";
    const client = {
      ...live,
      getBalance: async () => 1000000000000000000n,
      readContract: (args: Parameters<typeof live.readContract>[0]) =>
        args.functionName === "balanceOf"
          ? Promise.resolve(0n)
          : live.readContract(args),
      call: (args: Parameters<typeof live.call>[0]) =>
        live.call({
          ...args,
          stateOverride: [{ address: wallet, balance: 1000000000000000000n }],
        }),
    } as ReturnType<typeof rpc>;
    const snapshot: Snapshot = {
      ...evidence,
      mode: "live",
      wallet,
      fetchedAt: Date.now(),
      rpcBlock: Number(await live.getBlockNumber()),
      holdings: [],
    };
    const quote = await quoteExit(wallet, "ETH", "0.0001", snapshot, client);
    expect(quote.source).toBe("live");
    expect(Number(quote.amountOut)).toBeGreaterThan(0);
    expect(quote.transactions).toHaveLength(1);
    expect(quote.alternatives.length).toBeGreaterThan(1);
    const funding = await planFunding(snapshot, "0.10", client);
    expect(funding.quote?.asset).toBe("ETH");
    expect(Number(funding.quote?.minimumOut)).toBeGreaterThanOrEqual(
      Number(funding.shortfall),
    );
    expect(funding.quote?.transactions).toHaveLength(1);
  },
  60000,
);
