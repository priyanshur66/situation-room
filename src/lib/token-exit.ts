import {
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatUnits,
  getAddress,
  parseAbi,
  zeroAddress,
  type Hex,
} from "viem";
import { contracts, quoteExit, routerAbi, rpc } from "./chain";
import { executionHolding, tokenContract } from "./execution-assets";
import {
  parseAmount,
  type ExecutionAsset,
  type Quote,
  type Snapshot,
} from "./model";

const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);

export async function quoteAssetExit(
  wallet: string,
  asset: ExecutionAsset,
  amount: string,
  snapshot: Snapshot,
  client = rpc(),
  lifetimeMs = 60000,
): Promise<Quote> {
  if (asset === "ETH" || asset === "WETH")
    return quoteExit(wallet, asset, amount, snapshot, client, lifetimeMs);
  const token = tokenContract(asset),
    holding = executionHolding(snapshot, asset),
    market = holding?.market;
  const account = getAddress(wallet);
  if (
    snapshot.mode !== "live" ||
    snapshot.wallet.toLowerCase() !== account.toLowerCase()
  )
    throw new Error("A matching live wallet snapshot is required.");
  if (!token || !holding?.recognized || !market || holding.decimals === null)
    throw new Error(
      "No verified market evidence for this token. Refresh or choose another asset.",
    );
  if (
    [market.indexedAt, snapshot.indexedAt].some(
      (at) =>
        !Number.isFinite(at) ||
        Date.now() - at * 1000 > 300000 ||
        at * 1000 > Date.now() + 30000,
    )
  )
    throw new Error(
      "Indexed evidence is stale or has an invalid timestamp. Refresh before quoting.",
    );
  if (
    ![100, 500, 3000, 10000].includes(market.fee) ||
    !["WETH", "USDC"].includes(market.quoteToken) ||
    !Number.isFinite(market.priceUsd) ||
    market.priceUsd <= 0
  )
    throw new Error("No verified market price and fee tier for this token.");
  const blockNumber = await client.getBlockNumber();
  const [decimals, balance, allowance, native, fees] = await Promise.all([
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
      blockNumber,
    }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
      blockNumber,
    }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, contracts.router],
      blockNumber,
    }),
    client.getBalance({ address: account, blockNumber }),
    client.estimateFeesPerGas(),
  ]);
  if (decimals !== holding.decimals || decimals > 36)
    throw new Error(
      "Token decimals changed or are unsupported. Refresh before quoting.",
    );
  const amountIn = parseAmount(amount, decimals);
  if (balance < amountIn) throw new Error(`Insufficient ${asset} balance.`);
  const quoteToken =
    market.quoteToken === "WETH" ? contracts.weth : contracts.usdc;
  const pool = await client.readContract({
    address: contracts.factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [token, quoteToken, market.fee],
    blockNumber,
  });
  if (pool === zeroAddress || pool.toLowerCase() !== market.pool.toLowerCase())
    throw new Error("No verified token pool matches the canonical factory.");

  // Approval is not proof of transfer eligibility, particularly for B20 stocks.
  // This is an eth_call only; the full swap is simulated again after approval.
  try {
    const transfer = await client.simulateContract({
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(pool), amountIn],
      account,
      blockNumber,
    });
    if (!transfer.result) throw new Error("Transfer rejected.");
  } catch {
    throw new Error(
      "Token transfer simulation failed. The asset may be restricted, paused or unsellable.",
    );
  }
  const paths: {
    path: Hex;
    fee: number;
    expectedFactor: number;
    assets: string[];
    fees: number[];
  }[] = [];
  if (market.quoteToken === "USDC") {
    paths.push({
      path: encodePacked(
        ["address", "uint24", "address"],
        [token, market.fee, contracts.usdc],
      ),
      fee: market.fee,
      expectedFactor: 1 - market.fee / 1e6,
      assets: [asset, "USDC"],
      fees: [market.fee],
    });
  } else {
    for (const hop of snapshot.pools) {
      if (![100, 500, 3000, 10000].includes(hop.fee)) continue;
      const actual = await client.readContract({
        address: contracts.factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [contracts.weth, contracts.usdc, hop.fee],
        blockNumber,
      });
      if (
        actual === zeroAddress ||
        actual.toLowerCase() !== hop.address.toLowerCase()
      )
        continue;
      const expectedFactor = (1 - market.fee / 1e6) * (1 - hop.fee / 1e6);
      paths.push({
        path: encodePacked(
          ["address", "uint24", "address", "uint24", "address"],
          [token, market.fee, contracts.weth, hop.fee, contracts.usdc],
        ),
        fee: (1 - expectedFactor) * 1e6,
        expectedFactor,
        assets: [asset, "WETH", "USDC"],
        fees: [market.fee, hop.fee],
      });
    }
  }
  const results = await Promise.allSettled(
    paths.map(async (route) => {
      const { result } = await client.simulateContract({
        address: contracts.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInput",
        args: [route.path, amountIn],
        blockNumber,
      });
      if (result[0] <= 0n) throw new Error("No output liquidity.");
      return { ...route, output: result[0], gas: result[3] };
    }),
  );
  const routes = results
    .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    .sort((a, b) => (a.output > b.output ? -1 : a.output < b.output ? 1 : 0));
  const best = routes[0];
  if (!best)
    throw new Error(
      "No verified route to USDC could be quoted. No transaction was prepared.",
    );
  const spot = Number(amount) * market.priceUsd * best.expectedFactor;
  const priceImpactPct = (1 - Number(formatUnits(best.output, 6)) / spot) * 100;
  if (!Number.isFinite(priceImpactPct) || Math.abs(priceImpactPct) > 5)
    throw new Error(
      "Quote diverges more than 5% from indexed evidence. Refresh and investigate before exiting.",
    );
  const minimumOut = (best.output * 9950n) / 10000n;
  if (minimumOut <= 0n)
    throw new Error("Amount is too small for a protected USDC output.");
  const expiresAt = Date.now() + Math.min(300000, Math.max(1000, lifetimeMs));
  const transactions: Quote["transactions"] = [];
  const approval = (value: bigint) => ({
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [contracts.router, value],
    }),
    value: "0",
    label: value
      ? `Approve exactly ${amount} ${asset}`
      : `Reset ${asset} router allowance`,
  });
  if (allowance < amountIn) {
    if (allowance > 0n) transactions.push(approval(0n));
    transactions.push(approval(amountIn));
  }
  const swap = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInput",
    args: [
      {
        path: best.path,
        recipient: account,
        amountIn,
        amountOutMinimum: minimumOut,
      },
    ],
  });
  transactions.push({
    to: contracts.router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "multicall",
      args: [BigInt(Math.floor(expiresAt / 1000)), [swap]],
    }),
    value: "0",
    label: `Swap ${amount} ${asset} for at least ${formatUnits(minimumOut, 6)} USDC`,
  });
  const gasUnits =
    best.gas + 160000n + BigInt(transactions.length - 1) * 70000n;
  const gasReserve =
    gasUnits * (fees.maxFeePerGas ?? 1000000000n) * 2n + 10000000000000n;
  if (native < gasReserve)
    throw new Error("Leave more ETH for gas and Base data fees.");
  if (transactions.length === 1)
    await client.call({
      account,
      to: contracts.router,
      data: transactions[0].data as Hex,
      value: 0n,
    });
  const ethPrice = snapshot.pools[0]?.price;
  if (!Number.isFinite(ethPrice) || ethPrice <= 0)
    throw new Error("A current ETH gas price valuation is required.");
  return {
    source: "live",
    asset,
    amountIn: amount,
    amountOut: formatUnits(best.output, 6),
    minimumOut: formatUnits(minimumOut, 6),
    gasUsd: Number(formatUnits(gasReserve, 18)) * ethPrice,
    gasUnits: gasUnits.toString(),
    fee: best.fee,
    pool,
    route: { assets: best.assets, fees: best.fees },
    block: Number(blockNumber),
    expiresAt,
    priceImpactPct,
    alternatives: routes.map((r) => ({
      fee: r.fee,
      output: formatUnits(r.output, 6),
    })),
    transactions,
  };
}
