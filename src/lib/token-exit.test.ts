import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodePacked,
  erc20Abi,
  getAddress,
  parseUnits,
  type Log,
} from "viem";
import { sample } from "./__fixtures__/snapshot";
import { contracts, routerAbi, rpc } from "./chain";
import { tokenContract } from "./execution-assets";
import { quoteAssetExit } from "./token-exit";
import { verifyExitReceipt } from "./payment-receipt";
import type { ExecutionAsset } from "./model";

const wallet = "0x0000000000000000000000000000000000000001";
const pool = "0x0000000000000000000000000000000000000002";
function setup({
  asset = "DEGEN" as ExecutionAsset,
  decimals = 18,
  allowance = 0n,
  quoteToken = "USDC" as "USDC" | "WETH",
  transferable = true,
  mismatch = false,
} = {}) {
  const token = tokenContract(asset)!;
  const snapshot = structuredClone(sample);
  snapshot.wallet = wallet;
  snapshot.indexedAt = Date.now() / 1000;
  snapshot.pools = snapshot.pools.slice(0, 1);
  snapshot.pools[0].price = 2000;
  snapshot.discovery = {
    source: "The Graph Token API / Pinax",
    status: "complete",
    rpcBlock: 100,
    pages: 1,
    rejectedRows: 0,
    note: "",
    holdings: [
      {
        contract: token,
        symbol: asset,
        name: asset,
        recognized: true,
        sector: "DeFi",
        decimals,
        units: "100",
        market: {
          source: "The Graph / Uniswap V3",
          subgraphId: "test",
          indexedBlock: 100,
          indexedAt: snapshot.indexedAt,
          pool,
          quoteToken,
          fee: 3000,
          priceUsd: 2,
          liquidityUsd: 100000,
          latestDayVolumeUsd: 1000,
          history: [],
        },
        indexedBlock: 100,
      },
    ],
  };
  const readContract = vi.fn(
    async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: unknown[];
    }) => {
      if (functionName === "decimals") return decimals;
      if (functionName === "balanceOf") return parseUnits("100", decimals);
      if (functionName === "allowance") return allowance;
      if (functionName === "getPool")
        return mismatch
          ? contracts.router
          : String(args[0]).toLowerCase() === token
            ? pool
            : snapshot.pools[0].address;
      throw new Error("Unexpected contract call");
    },
  );
  const simulateContract = vi.fn(
    async ({ functionName }: { functionName: string }) => {
      if (functionName === "transfer") return { result: transferable };
      if (functionName === "quoteExactInput")
        return { result: [19900000n, [], [], 100000n] };
      throw new Error("Unexpected simulation");
    },
  );
  const call = vi.fn(async () => ({ data: "0x" }));
  const client = {
    getBlockNumber: vi.fn(async () => 100n),
    getBalance: vi.fn(async () => parseUnits("1", 18)),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1000000n })),
    readContract,
    simulateContract,
    call,
  } as unknown as ReturnType<typeof rpc>;
  return { snapshot, client, token, call, simulateContract };
}
function swap(q: Awaited<ReturnType<typeof quoteAssetExit>>) {
  const outer = decodeFunctionData({
    abi: routerAbi,
    data: q.transactions.at(-1)!.data as `0x${string}`,
  });
  if (outer.functionName !== "multicall") throw new Error("Missing deadline");
  const inner = decodeFunctionData({ abi: routerAbi, data: outer.args[1][0] });
  if (inner.functionName !== "exactInput") throw new Error("Wrong swap");
  return inner.args[0];
}
describe("additional token exits", () => {
  it.each([0, 6, 18])(
    "uses verified %i-decimal balances and exact approvals",
    async (decimals) => {
      const { snapshot, client, token } = setup({ decimals });
      const q = await quoteAssetExit(wallet, "DEGEN", "10", snapshot, client);
      const approval = decodeFunctionData({
        abi: erc20Abi,
        data: q.transactions[0].data as `0x${string}`,
      });
      expect(q.transactions[0].to).toBe(token);
      expect(approval.args).toEqual([
        contracts.router,
        parseUnits("10", decimals),
      ]);
      expect(swap(q).amountIn).toBe(parseUnits("10", decimals));
      expect(swap(q).recipient).toBe(wallet);
      expect(swap(q).amountOutMinimum).toBe(19800500n);
      expect(q.transactions.every((t) => t.value === "0")).toBe(true);
    },
  );
  it("encodes a verified token/WETH/USDC path and shows both fees", async () => {
    const { snapshot, client, token } = setup({ quoteToken: "WETH" });
    const q = await quoteAssetExit(wallet, "DEGEN", "10", snapshot, client);
    expect(swap(q).path).toBe(
      encodePacked(
        ["address", "uint24", "address", "uint24", "address"],
        [token, 3000, contracts.weth, snapshot.pools[0].fee, contracts.usdc],
      ),
    );
    expect(q.route?.assets).toEqual(["DEGEN", "WETH", "USDC"]);
    expect(q.route?.fees).toEqual([3000, snapshot.pools[0].fee]);
    expect(q.fee).toBeGreaterThan(3000);
    const delivered: Log = {
      address: contracts.usdc,
      blockHash: null,
      blockNumber: 100n,
      logIndex: 1,
      transactionHash: null,
      transactionIndex: 0,
      removed: false,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: getAddress(snapshot.pools[0].address), to: wallet },
      }) as Log["topics"],
      data: encodeAbiParameters([{ type: "uint256" }], [19800500n]),
    };
    expect(snapshot.pools[0].address.toLowerCase()).not.toBe(
      q.pool.toLowerCase(),
    );
    expect(verifyExitReceipt(wallet, q, [delivered])).toBe(19800500n);
    expect(() => verifyExitReceipt(wallet, q, [])).toThrow("minimum USDC");
  });
  it("resets an insufficient nonzero allowance before exact approval", async () => {
    const { snapshot, client } = setup({ allowance: 1n });
    const q = await quoteAssetExit(wallet, "DEGEN", "10", snapshot, client);
    expect(q.transactions).toHaveLength(3);
    expect(
      decodeFunctionData({
        abi: erc20Abi,
        data: q.transactions[0].data as `0x${string}`,
      }).args,
    ).toEqual([contracts.router, 0n]);
  });
  it("simulates the complete swap when allowance already covers it", async () => {
    const { snapshot, client, call } = setup({
      allowance: parseUnits("10", 18),
    });
    const q = await quoteAssetExit(wallet, "DEGEN", "10", snapshot, client);
    expect(q.transactions).toHaveLength(1);
    expect(call).toHaveBeenCalledOnce();
    expect(q.gasUsd).toBeCloseTo(0.02104, 8);
  });
  it("blocks restricted stock transfers even if approval exists", async () => {
    const { snapshot, client, simulateContract } = setup({
      asset: "AAPLc",
      transferable: false,
      allowance: parseUnits("10", 18),
    });
    await expect(
      quoteAssetExit(wallet, "AAPLc", "10", snapshot, client),
    ).rejects.toThrow("transfer simulation failed");
    expect(simulateContract).toHaveBeenCalledTimes(1);
  });
  it("rejects an unverified factory pool", async () => {
    const { snapshot, client } = setup({ mismatch: true });
    await expect(
      quoteAssetExit(wallet, "DEGEN", "10", snapshot, client),
    ).rejects.toThrow("canonical factory");
  });
  it.each([-301, 60, NaN])(
    "rejects stale or invalid indexed timestamps (%s)",
    async (offset) => {
      const { snapshot, client } = setup();
      snapshot.discovery!.holdings[0].market!.indexedAt =
        Date.now() / 1000 + offset;
      await expect(
        quoteAssetExit(wallet, "DEGEN", "10", snapshot, client),
      ).rejects.toThrow("Indexed evidence");
    },
  );
  it("does not trust a spoofed symbol on an unknown contract", async () => {
    const { snapshot, client } = setup();
    snapshot.discovery!.holdings[0].contract = getAddress(wallet);
    await expect(
      quoteAssetExit(wallet, "DEGEN", "10", snapshot, client),
    ).rejects.toThrow("No verified market");
  });
});
