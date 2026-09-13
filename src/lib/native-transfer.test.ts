import { describe, expect, it, vi } from "vitest";
import { parseEther, type Hex } from "viem";
import {
  nativeTransferInput,
  prepareNativeTransfer,
  verifyNativeTransfer,
  isWalletRejection,
  type NativeTransferClient,
} from "./native-transfer";

const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}` as Hex;
function mockClient() {
  return {
    getChainId: vi.fn().mockResolvedValue(8453),
    getBalance: vi.fn().mockResolvedValue(parseEther("1")),
    getTransactionCount: vi.fn().mockResolvedValue(7),
    estimateTotalFee: vi.fn().mockResolvedValue(parseEther("0.00001")),
    getTransaction: vi.fn().mockResolvedValue({
      from,
      to,
      value: parseEther("0.1"),
      nonce: 7,
      input: "0x",
    }),
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
  };
}
describe("native ETH transfers", () => {
  it("preserves wei precision and sends no contract calldata", () => {
    expect(nativeTransferInput(from, to, "0.000000000000000001")).toEqual({
      account: from,
      to,
      value: 1n,
      data: "0x",
    });
  });
  it.each(["0", "-1", "1e3", "0.0000000000000000001", "NaN", "", "1.2.3"])(
    "rejects invalid amount %s",
    (amount) => {
      expect(() => nativeTransferInput(from, to, amount)).toThrow();
    },
  );
  it("rejects malformed and zero recipients", () => {
    expect(() => nativeTransferInput(from, "0x123", "1")).toThrow();
    expect(() =>
      nativeTransferInput(from, `0x${"0".repeat(40)}`, "1"),
    ).toThrow();
  });
  it("reads pending balance and reserves twice the total fee estimate", async () => {
    const rpc = mockClient();
    const result = await prepareNativeTransfer(
      rpc as unknown as NativeTransferClient,
      from,
      to,
      "0.1",
    );
    expect(result.nonce).toBe(7);
    expect(BigInt(result.feeReserve)).toBe(parseEther("0.00002"));
    expect(rpc.getBalance).toHaveBeenCalledWith({
      address: from,
      blockTag: "pending",
    });
  });
  it("blocks insufficient gas and non-Base transfers", async () => {
    const rpc = mockClient();
    rpc.getBalance.mockResolvedValue(parseEther("0.1"));
    await expect(
      prepareNativeTransfer(
        rpc as unknown as NativeTransferClient,
        from,
        to,
        "0.1",
      ),
    ).rejects.toThrow("network fees");
    rpc.getChainId.mockResolvedValue(1);
    await expect(
      prepareNativeTransfer(
        rpc as unknown as NativeTransferClient,
        from,
        to,
        "0.1",
      ),
    ).rejects.toThrow("Base");
  });
  it("requires a matching on-chain transfer and successful receipt", async () => {
    const rpc = mockClient();
    const client = rpc as unknown as NativeTransferClient;
    const plan = await prepareNativeTransfer(client, from, to, "0.1");
    expect(await verifyNativeTransfer(client, plan, hash)).toBe(true);
    rpc.getTransactionReceipt.mockResolvedValue({ status: "reverted" });
    expect(await verifyNativeTransfer(client, plan, hash)).toBe(false);
    rpc.getTransaction.mockResolvedValue({
      from,
      to: from,
      value: parseEther("0.1"),
      nonce: 7,
      input: "0x",
    });
    await expect(verifyNativeTransfer(client, plan, hash)).rejects.toThrow(
      "does not match",
    );
  });
  it("does not treat ambiguous wallet errors as rejections", () => {
    expect(isWalletRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isWalletRejection(new Error("timeout"))).toBe(false);
  });
});
