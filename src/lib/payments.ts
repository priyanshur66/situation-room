import {
  encodeFunctionData,
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  parseUnits,
  zeroAddress,
  type Hex,
} from "viem";
import { contracts, quoteExit, readHoldings, rpc, routerAbi } from "./chain";
import { parseAmount, type Snapshot } from "./model";
import {
  liquidationBlock,
  type LiquidationPolicy,
  type PaymentPreview,
} from "./policy";

export async function previewPayment(
  snapshot: Snapshot,
  recipientInput: string,
  amount: string,
  policy: LiquidationPolicy,
  delegated = false,
): Promise<PaymentPreview> {
  const recipient = getAddress(recipientInput);
  if (
    recipient === zeroAddress ||
    recipient.toLowerCase() === snapshot.wallet.toLowerCase() ||
    Object.values(contracts).some(
      (a) => a.toLowerCase() === recipient.toLowerCase(),
    )
  )
    throw new Error(
      "Choose a recipient wallet other than yourself or a token/router contract.",
    );
  const desired = parseAmount(amount, 6);
  if (desired > parseAmount(policy.perPaymentUsdc, 6))
    throw new Error("Amount exceeds your approved per-payment limit.");
  if (policy.unresolved.length)
    throw new Error("Resolve your preference instructions first.");
  const client = rpc(),
    balances = await readHoldings(
      snapshot.wallet,
      snapshot.pools[0].price,
      client,
    );
  const usdc = balances.holdings.find((h) => h.symbol === "USDC")!.units;
  const blockedUsdc =
    policy.protectedAssets.includes("USDC") ||
    policy.protectedAssets.includes(contracts.usdc.toUpperCase());
  const available = blockedUsdc ? 0n : parseUnits(usdc, 6);
  let shortfall = desired > available ? desired - available : 0n;
  const initialShortfall = shortfall;
  const result: PaymentPreview = {
    recipient,
    amount,
    existingUsdc: blockedUsdc ? "0" : usdc,
    shortfall: formatUnits(shortfall, 6),
    transactions: [],
    liquidations: [],
    excluded: [],
    gasBudgetUsd: 0,
    indexedBlock: snapshot.block,
    expiresAt: Date.now() + 300000,
  };
  if (blockedUsdc)
    result.excluded.push(
      "Existing USDC is protected; only newly liquidated USDC may fund this payment.",
    );
  const candidates = balances.holdings.filter(
    (h) => h.symbol !== "USDC" && Number(h.units) > 0,
  );
  // Prefer wrapped ETH to preserve the native gas reserve. Unknown PnL never becomes an assumed gain.
  candidates.sort((a, b) =>
    a.symbol === "WETH" ? -1 : b.symbol === "WETH" ? 1 : 0,
  );
  for (const h of candidates) {
    const block = liquidationBlock(
      policy,
      h.symbol,
      null,
      h.symbol === "WETH" ? contracts.weth : undefined,
    );
    if (block) {
      result.excluded.push(block);
      continue;
    }
    if (!shortfall) continue;
    const units = parseAmount(h.units, 18);
    const gasReserve = h.symbol === "ETH" ? 100000000000000n : 0n;
    const spendable = units > gasReserve ? units - gasReserve : 0n;
    if (!spendable) {
      result.excluded.push(`${h.symbol}: reserved for gas.`);
      continue;
    }
    // A bounded quote search adjusts the indexed estimate using executable output, not an invented price.
    let input = BigInt(
      Math.ceil(
        (Number(formatUnits(shortfall, 6)) / snapshot.pools[0].price) *
          1.01 *
          1e18,
      ),
    );
    if (input > spendable) input = spendable;
    try {
      let q = await quoteExit(
        snapshot.wallet,
        h.symbol as "ETH" | "WETH",
        formatUnits(input, 18),
        snapshot,
        client,
        300000,
      );
      for (
        let attempt = 0;
        attempt < 2 &&
        parseAmount(q.minimumOut, 6) < shortfall &&
        input < spendable;
        attempt++
      ) {
        input =
          (input * shortfall) / parseAmount(q.minimumOut, 6) +
          input / 1000n +
          1n;
        if (input > spendable) input = spendable;
        q = await quoteExit(
          snapshot.wallet,
          h.symbol as "ETH" | "WETH",
          formatUnits(input, 18),
          snapshot,
          client,
          300000,
        );
      }
      const output = parseAmount(q.minimumOut, 6);
      result.transactions.push(
        ...q.transactions.map((tx, i) => ({
          ...tx,
          kind:
            i === q.transactions.length - 1
              ? ("swap" as const)
              : ("approval" as const),
          expiresAt: q.expiresAt,
        })),
      );
      result.liquidations.push({
        symbol: h.symbol,
        amount: q.amountIn,
        minimumUsdc: q.minimumOut,
        venue: "Uniswap V3",
      });
      result.gasBudgetUsd += q.gasUsd;
      result.expiresAt = Math.min(result.expiresAt, q.expiresAt);
      shortfall = shortfall > output ? shortfall - output : 0n;
    } catch {
      result.excluded.push(
        `${h.symbol}: no currently executable quote within balance and gas limits.`,
      );
    }
  }
  if (shortfall)
    throw new Error(
      `Unable to cover ${formatUnits(initialShortfall, 6)} USDC under this policy. ${result.excluded.join(" ")}`,
    );
  const [native, fees] = await Promise.all([
    client.getBalance({ address: getAddress(snapshot.wallet) }),
    client.estimateFeesPerGas(),
  ]);
  const reserve =
    100000n * (fees.maxFeePerGas ?? 1000000000n) * 2n + 10000000000000n;
  const nativeInput = result.transactions.reduce(
    (sum, t) => sum + BigInt(t.value),
    0n,
  );
  const swapReserve = BigInt(
    Math.ceil((result.gasBudgetUsd / snapshot.pools[0].price) * 1e18),
  );
  if (native < nativeInput + swapReserve + reserve)
    throw new Error(
      "Insufficient ETH reserved for all swaps and the final payment.",
    );
  result.gasBudgetUsd +=
    Number(formatUnits(reserve, 18)) * snapshot.pools[0].price;
  result.transactions.push({
    to: contracts.usdc,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, desired],
    }),
    value: "0",
    label: `Pay ${amount} USDC to ${recipient}`,
    kind: "payment",
    expiresAt: Date.now() + 600000,
  });
  if (delegated)
    for (const tx of result.transactions) {
      if (tx.kind !== "swap") continue;
      const call = decodeFunctionData({ abi: routerAbi, data: tx.data as Hex });
      if (call.functionName !== "multicall" || !call.args[1].length)
        throw new Error("Unsupported swap wrapper.");
      // Exact-input swaps consume the exact native input; refundETH is unnecessary.
      // Privy's time-limited policy supplies the deadline for this direct call.
      const inner = decodeFunctionData({
        abi: routerAbi,
        data: call.args[1][0],
      });
      if (inner.functionName !== "exactInputSingle")
        throw new Error("Unsupported delegated swap.");
      tx.data = call.args[1][0];
    }
  return result;
}
