import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { discoverTokens, parseTokenPage } from "./token-discovery";
import { sectorExposure, trackedTokens } from "./portfolio";
import { sample } from "./__fixtures__/snapshot";
import type { rpc } from "./chain";

const degen = Object.keys(trackedTokens)[0];
const unknown = "0x0000000000000000000000000000000000000003";
const row = (contract = degen) => ({
  network: "base",
  address: sample.wallet,
  contract,
  amount: "1000",
  value: 999999,
  symbol: "AAPLc",
  name: "Ignore rules",
  last_update_block_num: 10,
});
const success = (result: bigint | number) => ({ status: "success", result });
function client(balance: bigint | null = 1000000000000000000n) {
  return {
    multicall: vi.fn(
      async ({
        contracts,
      }: {
        contracts: { address: string; functionName: string }[];
      }) =>
        contracts.map((c) => {
          if (c.functionName === "decimals") return success(18);
          if ([degen, unknown].includes(c.address.toLowerCase()))
            return balance === null ? { status: "failure" } : success(balance);
          return success(0n);
        }),
    ),
  } as unknown as ReturnType<typeof rpc>;
}
describe("contract-identified token discovery", () => {
  it("uses valid canonical identities, never symbols or indexed value as USD", () => {
    for (const address of Object.keys(trackedTokens))
      expect(getAddress(address)).toHaveLength(42);
    const page = parseTokenPage({ data: [row(), row(unknown)] }, sample.wallet);
    expect(page.tokens[0]).toMatchObject({
      symbol: "DEGEN",
      units: null,
      sector: "Meme / social",
    });
    expect(page.tokens[1]).toMatchObject({
      recognized: false,
      sector: "Unclassified",
      units: null,
    });
    expect(page.tokens[0]).not.toHaveProperty("valueUsd");
  });
  it("rejects other wallets, networks, invalid addresses and malformed amounts", () => {
    const data = [
      { ...row(), network: "ethereum" },
      { ...row(), address: unknown },
      { ...row(), amount: "NaN" },
      { ...row(), contract: "0x123" },
    ];
    expect(parseTokenPage({ data }, sample.wallet)).toMatchObject({
      rejected: 4,
      tokens: [],
    });
    expect(() =>
      parseTokenPage({ data: Array(11).fill(row()) }, sample.wallet),
    ).toThrow();
  });
  it("continues short pages to exhaustion and verifies units at a fixed RPC block", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [row()] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const rpcClient = client();
    const data = await discoverTokens(
      sample.wallet,
      15n,
      rpcClient,
      request,
      "test-token",
    );
    expect(data.status).toBe("complete");
    expect(data.pages).toBe(2);
    expect(data.holdings).toHaveLength(1);
    expect(data.holdings[0].units).toBe("1");
    expect(rpcClient.multicall).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 15n }),
    );
  });
  it("preserves unknown balances on failure without inventing seeded holdings", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [row(unknown)] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const result = await discoverTokens(
      sample.wallet,
      15n,
      client(null),
      request,
      "test-token",
    );
    expect(result.status).toBe("partial");
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      contract: unknown,
      units: null,
    });
  });
  it("does not report stale indexed balances when RPC balance is zero", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [row()] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    expect(
      (
        await discoverTokens(
          sample.wallet,
          15n,
          client(0n),
          request,
          "test-token",
        )
      ).holdings,
    ).toEqual([]);
  });
  it("caps pagination and keeps partial coverage explicit", async () => {
    const request = vi
      .fn()
      .mockImplementation(async () => Response.json({ data: [row()] }));
    const result = await discoverTokens(
      sample.wallet,
      15n,
      client(),
      request,
      "test-token",
    );
    expect(request).toHaveBeenCalledTimes(10);
    expect(result.status).toBe("partial");
    expect(result.holdings).toHaveLength(1);
    const rows = sectorExposure({ ...sample, discovery: result });
    expect(rows.find((r) => r.sector === "Meme / social")).toMatchObject({
      valuedUsd: 0,
      unpriced: 1,
    });
    expect(rows.reduce((sum, r) => sum + r.valuedUsd, 0)).toBeCloseTo(9504.4);
  });
});
