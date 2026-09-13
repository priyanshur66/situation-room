import {
  decodeFunctionData,
  erc20Abi,
  parseEventLogs,
  type Hex,
  type Log,
} from "viem";
import { contracts, routerAbi } from "./chain";
import type { PaymentTransaction } from "./policy";
import { parseAmount, type Quote } from "./model";

export function verifyExitReceipt(wallet: string, quote: Quote, logs: Log[]) {
  const swap = quote.transactions.at(-1);
  if (!swap) throw new Error("Missing exit transaction.");
  // A multi-hop route delivers USDC from its final pool, not its first pool.
  // Check the canonical token's net receipt against the approved calldata.
  const received = verifyLiquidationReceipt(
    wallet,
    { ...swap, kind: "swap", expiresAt: quote.expiresAt },
    logs,
  );
  if (received < parseAmount(quote.minimumOut, 6))
    throw new Error("Exit receipt is below the reviewed minimum USDC.");
  return received;
}

export function verifyLiquidationReceipt(
  wallet: string,
  tx: PaymentTransaction,
  logs: Log[],
) {
  if (
    tx.kind !== "swap" ||
    tx.to.toLowerCase() !== contracts.router.toLowerCase()
  )
    throw new Error("Unsupported liquidation transaction.");
  let decoded = decodeFunctionData({ abi: routerAbi, data: tx.data as Hex });
  if (decoded.functionName === "multicall") {
    const calls = decoded.args[1];
    if (
      calls.length < 1 ||
      calls.length > 2 ||
      (calls.length === 2 &&
        decodeFunctionData({ abi: routerAbi, data: calls[1] }).functionName !==
          "refundETH")
    )
      throw new Error("Unexpected liquidation calls.");
    decoded = decodeFunctionData({ abi: routerAbi, data: calls[0] });
  }
  if (
    decoded.functionName !== "exactInput" &&
    decoded.functionName !== "exactInputSingle"
  )
    throw new Error("Unsupported liquidation call.");
  const params = decoded.args[0];
  const output =
    "tokenOut" in params ? params.tokenOut : `0x${params.path.slice(-40)}`;
  if (
    params.recipient.toLowerCase() !== wallet.toLowerCase() ||
    output.toLowerCase() !== contracts.usdc.toLowerCase() ||
    params.amountOutMinimum <= 0n
  )
    throw new Error("Liquidation must deliver protected USDC to the wallet.");
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: logs.filter(
      (l) => l.address.toLowerCase() === contracts.usdc.toLowerCase(),
    ),
  });
  const net = transfers.reduce(
    (sum, event) =>
      sum +
      (event.args.to.toLowerCase() === wallet.toLowerCase()
        ? event.args.value
        : 0n) -
      (event.args.from.toLowerCase() === wallet.toLowerCase()
        ? event.args.value
        : 0n),
    0n,
  );
  if (net < params.amountOutMinimum)
    throw new Error(
      "Liquidation receipt does not prove the approved minimum USDC output.",
    );
  return net;
}
