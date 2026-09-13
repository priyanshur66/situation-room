import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { quoteExit, planFunding, contracts, routerAbi, rpc } from "./chain";
import { sample } from "./__fixtures__/snapshot";
const wallet = "0x0000000000000000000000000000000000000001";
function setup({
  balance = 1000000000000000000n,
  allowance = 0n,
  factoryMismatch = false,
  output = 250000000n,
} = {}) {
  const snapshot = structuredClone(sample);
  snapshot.mode = "live";
  snapshot.wallet = wallet;
  snapshot.indexedAt = Date.now() / 1000;
  snapshot.pools = snapshot.pools.slice(0, 1);
  snapshot.pools[0].price = 2510;
  const call = vi.fn().mockResolvedValue({ data: "0x" });
  const client = {
    getBlockNumber: vi.fn().mockResolvedValue(123n),
    getBalance: vi.fn().mockResolvedValue(balance),
    readContract: vi
      .fn()
      .mockImplementation(async ({ functionName }) =>
        functionName === "getPool"
          ? factoryMismatch
            ? wallet
            : snapshot.pools[0].address
          : functionName === "allowance"
            ? allowance
            : balance,
      ),
    simulateContract: vi
      .fn()
      .mockResolvedValue({ result: [output, 0n, 0, 100000n] }),
    estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 1000000n }),
    call,
  } as unknown as ReturnType<typeof rpc>;
  return { snapshot, client, call };
}
describe("bounded exit transactions", () => {
  it("sends native ETH only to the canonical router with a wallet-bound recipient", async () => {
    const { snapshot, client, call } = setup();
    const q = await quoteExit(wallet, "ETH", "0.1", snapshot, client);
    expect(q.transactions).toHaveLength(1);
    expect(q.transactions[0].to).toBe(contracts.router);
    expect(q.transactions[0].value).toBe("100000000000000000");
    const outer = decodeFunctionData({
      abi: routerAbi,
      data: q.transactions[0].data as `0x${string}`,
    });
    expect(outer.functionName).toBe("multicall");
    if (outer.functionName !== "multicall")
      throw new Error("Wrong router call");
    expect(Number(outer.args[0]) * 1000).toBeLessThanOrEqual(q.expiresAt);
    const swap = decodeFunctionData({ abi: routerAbi, data: outer.args[1][0] });
    if (swap.functionName !== "exactInputSingle")
      throw new Error("Wrong swap call");
    expect(swap.args[0].recipient.toLowerCase()).toBe(wallet);
    expect(swap.args[0].amountOutMinimum).toBe(248750000n);
    expect(swap.args[0].tokenOut).toBe(contracts.usdc);
    expect(call).toHaveBeenCalledOnce();
  });
  it("approves the exact WETH amount, never an unlimited allowance", async () => {
    const { snapshot, client } = setup();
    const q = await quoteExit(wallet, "WETH", "0.1", snapshot, client);
    expect(q.transactions).toHaveLength(2);
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: q.transactions[0].data as `0x${string}`,
    });
    expect(approval.functionName).toBe("approve");
    expect(approval.args).toEqual([contracts.router, 100000000000000000n]);
    expect(q.transactions.every((t) => t.value === "0")).toBe(true);
  });
  it("skips approval when sufficient allowance exists", async () => {
    const { snapshot, client } = setup({ allowance: 100000000000000000n });
    expect(
      (await quoteExit(wallet, "WETH", "0.1", snapshot, client)).transactions,
    ).toHaveLength(1);
  });
  it("rejects an indexed address that is not factory-verified", async () => {
    const { snapshot, client } = setup({ factoryMismatch: true });
    await expect(
      quoteExit(wallet, "ETH", "0.1", snapshot, client),
    ).rejects.toThrow(/No verified/);
  });
  it("reserves ETH for gas instead of spending the entire balance", async () => {
    const { snapshot, client } = setup({ balance: 100000000000000000n });
    await expect(
      quoteExit(wallet, "ETH", "0.1", snapshot, client),
    ).rejects.toThrow(/Leave more ETH/);
  });
  it("rejects a stale snapshot", async () => {
    const { snapshot, client } = setup();
    snapshot.indexedAt -= 301;
    await expect(
      quoteExit(wallet, "ETH", "0.1", snapshot, client),
    ).rejects.toThrow(/older/);
  });
  it("rejects a different wallet's snapshot", async () => {
    const { snapshot, client } = setup();
    snapshot.wallet = contracts.router;
    await expect(
      quoteExit(wallet, "ETH", "0.1", snapshot, client),
    ).rejects.toThrow(/matching/);
  });
  it("rejects excessive divergence from indexed price", async () => {
    const { snapshot, client } = setup({ output: 100000000n });
    await expect(
      quoteExit(wallet, "ETH", "0.1", snapshot, client),
    ).rejects.toThrow(/diverges/);
  });
});

describe("USDC funding targets", () => {
  it("does not propose liquidation when existing USDC covers the target", async () => {
    const { snapshot, client } = setup({ balance: 2000000000n });
    const plan = await planFunding(snapshot, "1000", client);
    expect(plan.existingUsdc).toBe("2000");
    expect(plan.shortfall).toBe("0");
    expect(plan.quote).toBeNull();
    expect(client.simulateContract).not.toHaveBeenCalled();
  });
  it("rejects malformed targets before reading balances", async () => {
    const { snapshot, client } = setup();
    await expect(planFunding(snapshot, "-1", client)).rejects.toThrow();
    expect(client.getBalance).not.toHaveBeenCalled();
  });
  it("fails closed when no supported position can cover the shortfall", async () => {
    const { snapshot, client } = setup({ balance: 0n });
    await expect(planFunding(snapshot, "100", client)).rejects.toThrow(
      /No single supported position/,
    );
  });
});
