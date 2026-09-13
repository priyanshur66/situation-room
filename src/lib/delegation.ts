import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import type { PrivyClient } from "@privy-io/node";
type Rule = Parameters<
  ReturnType<PrivyClient["policies"]>["create"]
>[0]["rules"][number];
type PolicyCondition = Rule["conditions"][number];
type AbiSchema = Extract<
  PolicyCondition,
  { field_source: "ethereum_calldata" }
>["abi"];
import { contracts, routerAbi } from "./chain";
import type { PaymentPreview } from "./policy";

// Compile only reviewed, narrowly scoped calls. Unknown selectors fail closed.
export function paymentRules(plan: PaymentPreview): Rule[] {
  return plan.transactions.map((tx, i) => {
    const conditions: PolicyCondition[] = [
      {
        field_source: "ethereum_transaction",
        field: "chain_id",
        operator: "eq",
        value: "8453",
      },
      {
        field_source: "ethereum_transaction",
        field: "to",
        operator: "eq",
        value: tx.to,
      },
      {
        field_source: "ethereum_transaction",
        field: "value",
        operator: "eq",
        value: tx.value,
      },
      {
        field_source: "system",
        field: "current_unix_timestamp",
        operator: "lt",
        value: String(Math.floor(tx.expiresAt / 1000)),
      },
    ];
    const equal = (abi: unknown, field: string, value: unknown) =>
      conditions.push({
        field_source: "ethereum_calldata",
        abi: abi as AbiSchema,
        field,
        operator: "eq",
        value: String(value),
      });
    if (
      tx.kind === "payment" &&
      tx.to.toLowerCase() === contracts.usdc.toLowerCase()
    ) {
      const decoded = decodeFunctionData({
        abi: erc20Abi,
        data: tx.data as Hex,
      });
      if (decoded.functionName !== "transfer")
        throw new Error("Unsupported payment call.");
      equal(erc20Abi, "transfer.recipient", decoded.args[0]);
      equal(erc20Abi, "transfer.amount", decoded.args[1]);
    } else if (
      tx.kind === "approval" &&
      tx.to.toLowerCase() === contracts.weth.toLowerCase()
    ) {
      const decoded = decodeFunctionData({
        abi: erc20Abi,
        data: tx.data as Hex,
      });
      if (
        decoded.functionName !== "approve" ||
        decoded.args[0].toLowerCase() !== contracts.router.toLowerCase()
      )
        throw new Error("Unsupported approval.");
      equal(erc20Abi, "approve.spender", decoded.args[0]);
      equal(erc20Abi, "approve.amount", decoded.args[1]);
    } else if (
      tx.kind === "swap" &&
      tx.to.toLowerCase() === contracts.router.toLowerCase()
    ) {
      const decoded = decodeFunctionData({
        abi: routerAbi,
        data: tx.data as Hex,
      });
      if (decoded.functionName !== "exactInputSingle")
        throw new Error(
          "Delegation supports only an individually constrained swap, not arbitrary multicalls.",
        );
      for (const [field, value] of Object.entries(decoded.args[0]))
        equal(routerAbi, `exactInputSingle.params.${field}`, value);
    } else throw new Error("Unsupported delegated transaction.");
    return {
      name: `Payment step ${i + 1}`,
      method: "eth_sendTransaction",
      action: "ALLOW",
      conditions,
    };
  });
}
