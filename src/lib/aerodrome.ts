import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { contracts, rpc } from "./chain";
import { executionHolding, tokenContract } from "./execution-assets";
import {
  parseAmount,
  type ExecutionAsset,
  type Quote,
  type Snapshot,
} from "./model";
import {
  aerodrome,
  aerodromeAbi,
  aerodromeFactoryAbi,
  type AeroRoute,
} from "./aerodrome-contracts";

export async function quoteAerodromeExit(
  wallet: string,
  asset: ExecutionAsset,
  amount: string,
  snapshot: Snapshot,
  client = rpc(),
  lifetimeMs = 60000,
): Promise<Quote> {
  const account = getAddress(wallet);
  const core = asset === "ETH" || asset === "WETH";
  const holding = executionHolding(snapshot, asset);
  const token = core ? contracts.weth : tokenContract(asset);
  const price = core ? snapshot.pools[0]?.price : holding?.market?.priceUsd;
  const indexedAt = core ? snapshot.indexedAt : holding?.market?.indexedAt;
  const decimals = core ? 18 : holding?.decimals;
  if (
    snapshot.mode !== "live" ||
    snapshot.wallet.toLowerCase() !== account.toLowerCase() ||
    !Number.isFinite(snapshot.fetchedAt) ||
    Date.now() - snapshot.fetchedAt > 300000 ||
    snapshot.fetchedAt > Date.now() + 30000 ||
    !token ||
    !price ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !indexedAt ||
    !Number.isFinite(indexedAt) ||
    Date.now() - indexedAt * 1000 > 300000 ||
    indexedAt * 1000 > Date.now() + 30000 ||
    decimals === null ||
    decimals === undefined ||
    (!core && !holding?.recognized)
  )
    throw new Error(
      "Fresh matching wallet and indexed market evidence are required for Aerodrome.",
    );
  const input = parseAmount(amount, decimals);
  const blockNumber = await client.getBlockNumber();
  const read = { blockNumber };
  const [
    factory,
    weth,
    native,
    tokenBalance,
    tokenDecimals,
    allowance,
    gasFees,
  ] = await Promise.all([
    client.readContract({
      ...read,
      address: aerodrome.router,
      abi: aerodromeAbi,
      functionName: "defaultFactory",
    }),
    client.readContract({
      ...read,
      address: aerodrome.router,
      abi: aerodromeAbi,
      functionName: "weth",
    }),
    client.getBalance({ ...read, address: account }),
    asset === "ETH"
      ? Promise.resolve(0n)
      : client.readContract({
          ...read,
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account],
        }),
    client.readContract({
      ...read,
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    asset === "ETH"
      ? Promise.resolve(0n)
      : client.readContract({
          ...read,
          address: token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account, aerodrome.router],
        }),
    client.estimateFeesPerGas(),
  ]);
  if (
    factory.toLowerCase() !== aerodrome.factory.toLowerCase() ||
    weth.toLowerCase() !== contracts.weth.toLowerCase()
  )
    throw new Error("Aerodrome deployment identity could not be verified.");
  if (tokenDecimals !== decimals) throw new Error("Token precision changed.");
  if ((asset === "ETH" ? native : tokenBalance) < input)
    throw new Error(`Insufficient ${asset} balance.`);

  const leg = (from: Address, to: Address, stable: boolean): AeroRoute => ({
    from,
    to,
    stable,
    factory: aerodrome.factory,
  });
  const candidates: AeroRoute[][] = [false, true].map((stable) => [
    leg(token, contracts.usdc, stable),
  ]);
  if (!core)
    for (const a of [false, true])
      for (const b of [false, true])
        candidates.push([
          leg(token, contracts.weth, a),
          leg(contracts.weth, contracts.usdc, b),
        ]);
  // Shared legs are verified once per quote at the same block.
  const verified = new Map<string, Promise<{ pool: Address; fee: number }>>();
  function verifyLeg(route: AeroRoute) {
    const key = `${route.from}:${route.to}:${route.stable}`;
    if (!verified.has(key))
      verified.set(
        key,
        (async () => {
          const args = [route.from, route.to, route.stable] as const;
          const [pool, routed] = await Promise.all([
            client.readContract({
              ...read,
              address: aerodrome.factory,
              abi: aerodromeFactoryAbi,
              functionName: "getPool",
              args,
            }),
            client.readContract({
              ...read,
              address: aerodrome.router,
              abi: aerodromeAbi,
              functionName: "poolFor",
              args: [...args, aerodrome.factory],
            }),
          ]);
          if (
            pool === zeroAddress ||
            pool.toLowerCase() !== routed.toLowerCase()
          )
            throw new Error("No canonical Aerodrome pool.");
          const [valid, fee] = await Promise.all([
            client.readContract({
              ...read,
              address: aerodrome.factory,
              abi: aerodromeFactoryAbi,
              functionName: "isPool",
              args: [pool],
            }),
            client.readContract({
              ...read,
              address: aerodrome.factory,
              abi: aerodromeFactoryAbi,
              functionName: "getFee",
              args: [pool, route.stable],
            }),
          ]);
          if (!valid || fee < 0n || fee > 100n)
            throw new Error("Unsupported pool or fee.");
          return { pool, fee: Number(fee) * 100 }; // Factory fee is bps; UI uses millionths.
        })(),
      );
    return verified.get(key)!;
  }
  const outcomes = await Promise.allSettled(
    candidates.map(async (routes) => {
      const pools = await Promise.all(routes.map(verifyLeg));
      const amounts = await client.readContract({
        ...read,
        address: aerodrome.router,
        abi: aerodromeAbi,
        functionName: "getAmountsOut",
        args: [input, routes],
      });
      if (
        amounts.length !== routes.length + 1 ||
        amounts[0] !== input ||
        amounts.some((v) => v <= 0n)
      )
        throw new Error("No output liquidity.");
      const out = amounts.at(-1)!;
      const reference =
        Number(amount) *
        price *
        pools.reduce((n, p) => n * (1 - p.fee / 1e6), 1);
      const impact = (1 - Number(formatUnits(out, 6)) / reference) * 100;
      if (!Number.isFinite(impact) || Math.abs(impact) > 5)
        throw new Error("Aerodrome quote diverges from indexed evidence.");
      return { routes, pools, out, impact };
    }),
  );
  const quotes = outcomes
    .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    .sort((a, b) => (a.out > b.out ? -1 : a.out < b.out ? 1 : 0));
  if (!quotes.length)
    throw new Error("No verified Aerodrome route could be quoted.");
  const best = quotes[0],
    minimum = (best.out * 9950n) / 10000n;
  if (minimum <= 0n)
    throw new Error("Amount is too small for protected output.");
  if (asset !== "ETH") {
    const transferable = await client.simulateContract({
      ...read,
      account,
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [best.pools[0].pool, input],
    });
    if (transferable.result !== true)
      throw new Error("Token transfer restriction prevents this exit.");
  }
  const expiresAt = Date.now() + Math.min(300000, Math.max(1000, lifetimeMs));
  const transactions: Quote["transactions"] = [];
  if (asset !== "ETH" && allowance < input) {
    for (const limit of allowance > 0n ? [0n, input] : [input])
      transactions.push({
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [aerodrome.router, limit],
        }),
        value: "0",
        label:
          limit === 0n
            ? `Reset ${asset} allowance`
            : `Approve exactly ${amount} ${asset} for Aerodrome`,
      });
  }
  const deadline = BigInt(Math.floor(expiresAt / 1000));
  const data =
    asset === "ETH"
      ? encodeFunctionData({
          abi: aerodromeAbi,
          functionName: "swapExactETHForTokens",
          args: [minimum, best.routes, account, deadline],
        })
      : encodeFunctionData({
          abi: aerodromeAbi,
          functionName: "swapExactTokensForTokens",
          args: [input, minimum, best.routes, account, deadline],
        });
  const swap = {
    to: aerodrome.router,
    data,
    value: asset === "ETH" ? input.toString() : "0",
    label: `Swap ${amount} ${asset} on Aerodrome for at least ${formatUnits(minimum, 6)} USDC`,
  };
  // Until approval exists, reserve a conservative per-hop execution budget.
  let gasUnits = 220000n + BigInt(best.routes.length) * 160000n;
  if (!transactions.length) {
    await client.call({
      ...read,
      account,
      to: swap.to,
      data: data as Hex,
      value: BigInt(swap.value),
    });
    const estimate = await client.estimateGas({
      account,
      to: swap.to,
      data,
      value: BigInt(swap.value),
    });
    if (estimate > gasUnits) gasUnits = estimate;
  }
  gasUnits += BigInt(transactions.length) * 70000n;
  const reserve =
    gasUnits * (gasFees.maxFeePerGas ?? 1000000000n) * 2n + 10000000000000n;
  if (native < reserve + (asset === "ETH" ? input : 0n))
    throw new Error("Leave more ETH for gas and Base data fees.");
  transactions.push(swap);
  return {
    source: "live",
    venue: "Aerodrome",
    asset,
    amountIn: amount,
    amountOut: formatUnits(best.out, 6),
    minimumOut: formatUnits(minimum, 6),
    gasUsd: Number(formatUnits(reserve, 18)) * snapshot.pools[0].price,
    gasUnits: gasUnits.toString(),
    fee: best.pools[0].fee,
    pool: best.pools[0].pool,
    route: {
      assets:
        best.routes.length === 1 ? [asset, "USDC"] : [asset, "WETH", "USDC"],
      fees: best.pools.map((p) => p.fee),
    },
    block: Number(blockNumber),
    expiresAt,
    priceImpactPct: Math.max(0, best.impact),
    alternatives: quotes.map((q) => ({
      fee: q.pools[0].fee,
      output: formatUnits(q.out, 6),
    })),
    transactions,
  };
}
