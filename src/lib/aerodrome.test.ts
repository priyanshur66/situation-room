import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseUnits,
  zeroAddress,
} from "viem";
import { sample } from "./__fixtures__/snapshot";
import { contracts, rpc } from "./chain";
import { quoteAerodromeExit } from "./aerodrome";
import {
  aerodrome,
  aerodromeAbi,
  validateAerodromeExit,
} from "./aerodrome-contracts";

const wallet = sample.wallet;
const pool = "0x0000000000000000000000000000000000000002";
function setup({
  allowance = 0n,
  transferable = true,
  mismatch = false,
  output = 19940000n,
} = {}) {
  const snapshot = structuredClone(sample);
  snapshot.fetchedAt = Date.now();
  snapshot.indexedAt = Date.now() / 1000;
  snapshot.pools[0].price = 2000;
  const readContract = vi.fn(
    async ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: unknown[];
    }) => {
      switch (functionName) {
        case "defaultFactory":
          return aerodrome.factory;
        case "weth":
          return contracts.weth;
        case "decimals":
          return 18;
        case "balanceOf":
          return parseUnits("1", 18);
        case "allowance":
          return allowance;
        case "getPool":
          return pool;
        case "poolFor":
          return mismatch ? zeroAddress : pool;
        case "isPool":
          return true;
        case "getFee":
          return 30n;
        case "getAmountsOut":
          return [args![0], output];
        default:
          throw new Error("Unexpected call");
      }
    },
  );
  const call = vi.fn(async () => ({ data: "0x" }));
  const client = {
    getBlockNumber: vi.fn(async () => 100n),
    getBalance: vi.fn(async () => parseUnits("1", 18)),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1000000n })),
    readContract,
    simulateContract: vi.fn(async () => ({ result: transferable })),
    call,
    estimateGas: vi.fn(async () => 200000n),
  } as unknown as ReturnType<typeof rpc>;
  return { snapshot, client, call };
}
describe("Aerodrome classic exits", () => {
  it("encodes exact native input and a protected USDC output after full simulation", async () => {
    const { snapshot, client, call } = setup();
    const quote = await quoteAerodromeExit(
      wallet,
      "ETH",
      "0.01",
      snapshot,
      client,
    );
    expect(quote.venue).toBe("Aerodrome");
    expect(quote.transactions).toHaveLength(1);
    const swap = validateAerodromeExit(
      quote.transactions[0].data as `0x${string}`,
      quote.transactions[0].value,
      wallet,
    );
    expect(swap.native).toBe(true);
    expect(swap.minimum).toBe(19840300n);
    expect(quote.transactions[0].value).toBe(parseUnits("0.01", 18).toString());
    expect(call).toHaveBeenCalledOnce();
  });
  it("resets a nonzero insufficient allowance and approves only the exact input", async () => {
    const { snapshot, client } = setup({ allowance: 1n });
    const quote = await quoteAerodromeExit(
      wallet,
      "WETH",
      "0.01",
      snapshot,
      client,
    );
    expect(quote.transactions).toHaveLength(3);
    const approvals = quote.transactions
      .slice(0, 2)
      .map(
        (tx) =>
          decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` })
            .args,
      );
    expect(approvals).toEqual([
      [aerodrome.router, 0n],
      [aerodrome.router, parseUnits("0.01", 18)],
    ]);
  });
  it("rejects factory mismatch, price divergence and restricted token transfers", async () => {
    for (const options of [
      { mismatch: true },
      { output: 1n },
      { transferable: false },
    ]) {
      const { snapshot, client } = setup(options);
      await expect(
        quoteAerodromeExit(wallet, "WETH", "0.01", snapshot, client),
      ).rejects.toThrow();
    }
  });
  it("rejects invalid and stale evidence before requesting a route", async () => {
    const { snapshot, client } = setup();
    snapshot.fetchedAt = NaN;
    await expect(
      quoteAerodromeExit(wallet, "ETH", "0.01", snapshot, client),
    ).rejects.toThrow("Fresh matching");
    expect(client.getBlockNumber).not.toHaveBeenCalled();
  });
  it("rejects modified factories, wrong recipient and non-USDC output", () => {
    const route = {
      from: contracts.weth,
      to: contracts.usdc,
      stable: false,
      factory: aerodrome.factory,
    };
    for (const changed of [
      { ...route, factory: pool },
      { ...route, to: pool },
    ] as const) {
      const data = encodeFunctionData({
        abi: aerodromeAbi,
        functionName: "swapExactETHForTokens",
        args: [1n, [changed], wallet as `0x${string}`, 100n],
      });
      expect(() => validateAerodromeExit(data, "1", wallet)).toThrow(
        "Unsupported",
      );
    }
    const data = encodeFunctionData({
      abi: aerodromeAbi,
      functionName: "swapExactETHForTokens",
      args: [1n, [route], pool, 100n],
    });
    expect(() => validateAerodromeExit(data, "1", wallet)).toThrow(
      "Unsupported",
    );
  });
});
