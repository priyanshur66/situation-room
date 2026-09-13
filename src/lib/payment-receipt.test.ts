import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  type Log,
} from "viem";
import { contracts, routerAbi } from "./chain";
import { tokenContract } from "./execution-assets";
import { verifyLiquidationReceipt } from "./payment-receipt";
import type { PaymentTransaction } from "./policy";

const wallet = "0x0000000000000000000000000000000000000001";
const pool = "0x0000000000000000000000000000000000000002";
function transfer(
  value: bigint,
  outgoing = false,
  address: string = contracts.usdc,
): Log {
  return {
    address,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: outgoing ? wallet : pool, to: outgoing ? pool : wallet },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  } as Log;
}
function transaction(wrapped = false): PaymentTransaction {
  let data = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInput",
    args: [
      {
        path: encodePacked(
          ["address", "uint24", "address"],
          [tokenContract("DEGEN")!, 3000, contracts.usdc],
        ),
        recipient: wallet,
        amountIn: 1000n,
        amountOutMinimum: 5000000n,
      },
    ],
  });
  if (wrapped)
    data = encodeFunctionData({
      abi: routerAbi,
      functionName: "multicall",
      args: [1000n, [data]],
    });
  return {
    kind: "swap",
    to: contracts.router,
    data,
    value: "0",
    expiresAt: 1000000,
    label: "Swap",
  };
}
describe("payment liquidation receipt validation", () => {
  it.each([false, true])(
    "checks minimum output for delegated/wrapped swap (%s)",
    (wrapped) => {
      expect(
        verifyLiquidationReceipt(wallet, transaction(wrapped), [
          transfer(5000000n),
        ]),
      ).toBe(5000000n);
    },
  );
  it("rejects a successful receipt with insufficient or missing output", () => {
    expect(() =>
      verifyLiquidationReceipt(wallet, transaction(), [transfer(4999999n)]),
    ).toThrow("minimum USDC");
    expect(() => verifyLiquidationReceipt(wallet, transaction(), [])).toThrow(
      "minimum USDC",
    );
  });
  it("does not count spoofed-token events or USDC sent back out", () => {
    expect(() =>
      verifyLiquidationReceipt(wallet, transaction(), [
        transfer(5000000n, false, contracts.weth),
      ]),
    ).toThrow("minimum USDC");
    expect(() =>
      verifyLiquidationReceipt(wallet, transaction(), [
        transfer(5000000n),
        transfer(1n, true),
      ]),
    ).toThrow("minimum USDC");
  });
});
