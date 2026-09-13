import { describe, expect, it } from "vitest";
import { encodeFunctionData, encodePacked, erc20Abi } from "viem";
import { paymentRules } from "./delegation";
import { contracts, routerAbi } from "./chain";
import type { PaymentPreview } from "./policy";
import { PrivyClient } from "@privy-io/node";
import { tokenContract } from "./execution-assets";
const recipient = "0x0000000000000000000000000000000000000001";
function plan(): PaymentPreview {
  return {
    recipient,
    amount: "5",
    existingUsdc: "5",
    shortfall: "0",
    gasBudgetUsd: 0,
    indexedBlock: 1,
    expiresAt: Date.now() + 300000,
    liquidations: [],
    excluded: [],
    transactions: [
      {
        to: contracts.usdc,
        value: "0",
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, 5000000n],
        }),
        kind: "payment",
        label: "Pay",
        expiresAt: Date.now() + 300000,
      },
    ],
  };
}
function tokenSwap(): PaymentPreview["transactions"][number] {
  return {
    ...plan().transactions[0],
    to: contracts.router,
    kind: "swap",
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInput",
      args: [
        {
          path: encodePacked(
            ["address", "uint24", "address", "uint24", "address"],
            [
              tokenContract("DEGEN")!,
              3000,
              contracts.weth,
              500,
              contracts.usdc,
            ],
          ),
          recipient,
          amountIn: 1000n,
          amountOutMinimum: 900n,
        },
      ],
    }),
  };
}
describe("restricted payment policy compiler", () => {
  it("binds multi-hop swaps to the exact path, input, minimum and recipient", () => {
    const p = plan();
    p.transactions = [tokenSwap()];
    const fields = paymentRules(p)[0].conditions.map((c) => c.field);
    for (const field of ["path", "recipient", "amountIn", "amountOutMinimum"])
      expect(fields).toContain(`exactInput.params.${field}`);
  });
  it("binds payment to Base, exact token, recipient, amount, native value and expiry", () => {
    const rules = paymentRules(plan());
    expect(rules).toHaveLength(1);
    expect(rules[0].method).toBe("eth_sendTransaction");
    expect(rules[0].conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "chain_id",
          value: "8453",
          operator: "eq",
        }),
        expect.objectContaining({
          field: "to",
          value: contracts.usdc,
          operator: "eq",
        }),
        expect.objectContaining({ field: "value", value: "0", operator: "eq" }),
        expect.objectContaining({
          field: "transfer.recipient",
          value: recipient,
          operator: "eq",
        }),
        expect.objectContaining({
          field: "transfer.amount",
          value: "5000000",
          operator: "eq",
        }),
        expect.objectContaining({
          field: "current_unix_timestamp",
          operator: "lt",
        }),
      ]),
    );
  });
  it("denies arbitrary multicalls and unknown targets instead of generating broad allowances", () => {
    const p = plan();
    p.transactions[0].to = recipient;
    expect(() => paymentRules(p)).toThrow(/Unsupported/);
    p.transactions[0] = {
      ...p.transactions[0],
      to: contracts.router,
      kind: "swap",
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "multicall",
        args: [1n, []],
      }),
    };
    expect(() => paymentRules(p)).toThrow(/multicalls/);
  });
  it("constrains every direct swap parameter", () => {
    const p = plan();
    p.transactions[0] = {
      ...p.transactions[0],
      to: contracts.router,
      kind: "swap",
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: contracts.weth,
            tokenOut: contracts.usdc,
            fee: 500,
            recipient,
            amountIn: 1000n,
            amountOutMinimum: 900n,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    };
    const fields = paymentRules(p)[0].conditions.map((c) => c.field);
    for (const field of [
      "tokenIn",
      "tokenOut",
      "fee",
      "recipient",
      "amountIn",
      "amountOutMinimum",
      "sqrtPriceLimitX96",
    ])
      expect(fields).toContain(`exactInputSingle.params.${field}`);
  });
});

it.skipIf(process.env.RUN_POLICY_TESTS !== "1")(
  "Privy accepts exact payment and tuple swap rules without attaching any wallet",
  async () => {
    const p = plan();
    p.transactions.push({
      ...p.transactions[0],
      to: contracts.router,
      kind: "swap",
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: contracts.weth,
            tokenOut: contracts.usdc,
            fee: 500,
            recipient,
            amountIn: 1000n,
            amountOutMinimum: 900n,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    });
    const client = new PrivyClient({
      appId: process.env.PRIVY_APP_ID!,
      appSecret: process.env.PRIVY_APP_SECRET!,
      timeout: 15000,
      maxRetries: 0,
    });
    p.transactions.push(tokenSwap());
    const policy = await client.policies().create({
      name: "Payment rule validation",
      version: "1.0",
      chain_type: "ethereum",
      rules: paymentRules(p),
    });
    try {
      expect(policy.id).toBeTruthy();
    } finally {
      await client.policies()._delete(policy.id);
    }
  },
  40000,
);
