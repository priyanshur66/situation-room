import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi } from "viem";
import { paymentRules } from "./delegation";
import { contracts, routerAbi } from "./chain";
import type { PaymentPreview } from "./policy";
const recipient = "0x0000000000000000000000000000000000000001";
function plan(): PaymentPreview {
  return { recipient, amount: "5", existingUsdc: "5", shortfall: "0", gasBudgetUsd: 0, indexedBlock: 1, expiresAt: Date.now() + 300000, liquidations: [], excluded: [], transactions: [{ to: contracts.usdc, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 5000000n] }), kind: "payment", label: "Pay", expiresAt: Date.now() + 300000 }] };
}
describe("restricted payment policy compiler", () => {
  it("binds payment to Base, exact token, recipient, amount, native value and expiry", () => {
    const rules = paymentRules(plan());
    expect(rules).toHaveLength(1);
    expect(rules[0].method).toBe("eth_sendTransaction");
    expect(rules[0].conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "chain_id", value: "8453", operator: "eq" }),
      expect.objectContaining({ field: "to", value: contracts.usdc, operator: "eq" }),
      expect.objectContaining({ field: "value", value: "0", operator: "eq" }),
      expect.objectContaining({ field: "transfer.recipient", value: recipient, operator: "eq" }),
      expect.objectContaining({ field: "transfer.amount", value: "5000000", operator: "eq" }),
      expect.objectContaining({ field: "current_unix_timestamp", operator: "lt" }),
    ]));
  });
  it("denies arbitrary multicalls and unknown targets instead of generating broad allowances", () => {
    const p = plan();
    p.transactions[0].to = recipient;
    expect(() => paymentRules(p)).toThrow(/Unsupported/);
    p.transactions[0] = { ...p.transactions[0], to: contracts.router, kind: "swap", data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [1n, []] }) };
    expect(() => paymentRules(p)).toThrow(/multicalls/);
  });
  it("constrains every direct swap parameter", () => {
    const p = plan();
    p.transactions[0] = { ...p.transactions[0], to: contracts.router, kind: "swap", data: encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: contracts.weth, tokenOut: contracts.usdc, fee: 500, recipient, amountIn: 1000n, amountOutMinimum: 900n, sqrtPriceLimitX96: 0n }] }) };
    const fields = paymentRules(p)[0].conditions.map(c => c.field);
    for (const field of ["tokenIn", "tokenOut", "fee", "recipient", "amountIn", "amountOutMinimum", "sqrtPriceLimitX96"]) expect(fields).toContain(`exactInputSingle.params.${field}`);
  });
});
