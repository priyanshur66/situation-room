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
import { contracts, readHoldings, rpc, routerAbi } from "./chain";
import { quoteAssetExit } from "./token-exit";
import {
  executionAssets,
  executionHolding,
  tokenContract,
} from "./execution-assets";
import { parseAmount, type Snapshot } from "./model";
import { chooseFunding, type FundingCandidate } from "./liquidation-planner";
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
  client = rpc(),
): Promise<PaymentPreview> {
  const recipient = getAddress(recipientInput);
  if (
    recipient === zeroAddress ||
    recipient.toLowerCase() === snapshot.wallet.toLowerCase() ||
    [
      ...Object.values(contracts),
      ...executionAssets.flatMap((a) => tokenContract(a) ?? []),
    ].some((a) => a.toLowerCase() === recipient.toLowerCase())
  )
    throw new Error(
      "Choose a recipient wallet other than yourself or a token/router contract.",
    );
  const desired = parseAmount(amount, 6);
  if (desired > parseAmount(policy.perPaymentUsdc, 6))
    throw new Error("Amount exceeds your approved per-payment limit.");
  if (policy.unresolved.length)
    throw new Error("Resolve your preference instructions first.");
  const balances = await readHoldings(
    snapshot.wallet,
    snapshot.pools[0].price,
    client,
  );
  const usdc = balances.holdings.find((h) => h.symbol === "USDC")!.units;
  const blockedUsdc =
    policy.protectedAssets.includes("USDC") ||
    policy.protectedAssets.includes(contracts.usdc.toUpperCase());
  const available = blockedUsdc ? 0n : parseUnits(usdc, 6);
  const shortfall = desired > available ? desired - available : 0n;
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
  const candidates: FundingCandidate[] = [];
  for (const h of balances.holdings) {
    if (h.symbol === "USDC" || Number(h.units) <= 0) continue;
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
    const units = parseAmount(h.units, 18);
    const gasReserve = h.symbol === "ETH" ? 100000000000000n : 0n;
    const spendable = units > gasReserve ? units - gasReserve : 0n;
    if (!spendable) {
      result.excluded.push(`${h.symbol}: reserved for gas.`);
      continue;
    }
    candidates.push({ symbol: h.symbol, spendable });
  }
  const [native, fees] = await Promise.all([
    client.getBalance({ address: getAddress(snapshot.wallet) }),
    client.estimateFeesPerGas(),
  ]);
  if (shortfall > 0n)
    for (const asset of executionAssets) {
      const token = tokenContract(asset),
        h = executionHolding(snapshot, asset);
      if (!token || !h || Number(h.units) <= 0) continue;
      const blocked = liquidationBlock(policy, asset, null, token);
      if (blocked) {
        result.excluded.push(blocked);
        continue;
      }
      if (!h.market || h.decimals === null) {
        result.excluded.push(`${asset}: current market evidence unavailable.`);
        continue;
      }
      try {
        const [spendable, decimals] = await Promise.all([
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [getAddress(snapshot.wallet)],
          }),
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "decimals",
          }),
        ]);
        if (decimals !== h.decimals || decimals > 36)
          throw new Error("Invalid token decimals.");
        if (spendable > 0n)
          candidates.push({
            symbol: asset,
            spendable,
            decimals,
            priceUsd: h.market.priceUsd,
          });
      } catch {
        result.excluded.push(
          `${asset}: live token balance or decimals unavailable.`,
        );
      }
    }
  const reserve =
    100000n * (fees.maxFeePerGas ?? 1000000000n) * 2n + 10000000000000n;
  let funding: Awaited<ReturnType<typeof chooseFunding>>;
  try {
    funding = await chooseFunding(
      candidates,
      shortfall,
      snapshot.pools[0].price,
      native,
      reserve,
      (asset, input) =>
        quoteAssetExit(snapshot.wallet, asset, input, snapshot, client, 300000),
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "Unable to fund payment."} ${result.excluded.join(" ")}`,
    );
  }
  for (const q of funding.selected.quotes) {
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
      symbol: q.asset,
      amount: q.amountIn,
      minimumUsdc: q.minimumOut,
      venue: "Uniswap V3",
    });
    result.expiresAt = Math.min(result.expiresAt, q.expiresAt);
  }
  result.gasBudgetUsd =
    funding.selected.gasBudgetUsd +
    Number(formatUnits(reserve, 18)) * snapshot.pools[0].price;
  result.comparison = funding.alternatives.map((option) => ({
    assets: option.quotes.map((q) => q.asset),
    estimatedCostUsd: option.estimatedCostUsd,
    gasBudgetUsd: option.gasBudgetUsd,
  }));
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
      if (
        inner.functionName !== "exactInputSingle" &&
        inner.functionName !== "exactInput"
      )
        throw new Error("Unsupported delegated swap.");
      tx.data = call.args[1][0];
    }
  return result;
}
