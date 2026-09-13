import {
  createPublicClient,
  http,
  parseAbi,
  erc20Abi,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { parseAmount, type Pool, type Quote, type Snapshot } from "./model";

export const contracts = {
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  router: "0x2626664c2603336E57B271c5C0b26F421741e481",
} as const;
export const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);
export function rpc() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org", {
      timeout: 15000,
      retryCount: 1,
    }),
  });
}

export async function readHoldings(wallet: string, price: number) {
  const client = rpc(),
    address = getAddress(wallet),
    blockNumber = await client.getBlockNumber();
  const [native, weth, usdc] = await Promise.all([
    client.getBalance({ address, blockNumber }),
    client.readContract({
      address: contracts.weth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
      blockNumber,
    }),
    client.readContract({
      address: contracts.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
      blockNumber,
    }),
  ]);
  return {
    rpcBlock: Number(blockNumber),
    holdings: [
      {
        symbol: "ETH" as const,
        units: formatUnits(native, 18),
        valueUsd: Number(formatUnits(native, 18)) * price,
      },
      {
        symbol: "WETH" as const,
        units: formatUnits(weth, 18),
        valueUsd: Number(formatUnits(weth, 18)) * price,
      },
      {
        symbol: "USDC" as const,
        units: formatUnits(usdc, 6),
        valueUsd: Number(formatUnits(usdc, 6)),
      },
    ],
  };
}

export async function quoteExit(
  wallet: string,
  asset: "ETH" | "WETH",
  amount: string,
  snapshot: Snapshot,
  client = rpc(),
): Promise<Quote> {
  const address = getAddress(wallet),
    amountIn = parseAmount(amount, 18);
  if (Date.now() - snapshot.indexedAt * 1000 > 300000)
    throw new Error(
      "Indexed evidence is older than five minutes. Refresh before quoting.",
    );
  if (
    snapshot.mode !== "live" ||
    snapshot.wallet.toLowerCase() !== wallet.toLowerCase()
  )
    throw new Error("A matching live wallet snapshot is required.");
  const blockNumber = await client.getBlockNumber();
  const results = await Promise.allSettled(
    snapshot.pools.map(async (pool: Pool) => {
      const actual = await client.readContract({
        address: contracts.factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [contracts.weth, contracts.usdc, pool.fee],
        blockNumber,
      });
      if (actual.toLowerCase() !== pool.address.toLowerCase())
        throw new Error("Indexed pool does not match factory.");
      const { result } = await client.simulateContract({
        address: contracts.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: contracts.weth,
            tokenOut: contracts.usdc,
            amountIn,
            fee: pool.fee,
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
        blockNumber,
      });
      if (result[0] <= BigInt(0)) throw new Error("No output liquidity.");
      return { pool, out: result[0], gas: result[3] };
    }),
  );
  const routes = results
    .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    .sort((a, b) => (a.out > b.out ? -1 : a.out < b.out ? 1 : 0));
  if (!routes.length)
    throw new Error(
      "No verified direct pool could be quoted. No transaction was prepared.",
    );
  const best = routes[0],
    minOut = (best.out * BigInt(9950)) / BigInt(10000);
  const spot = Number(amount) * best.pool.price;
  const impact =
    spot > 0
      ? (1 -
          Number(formatUnits(best.out, 6)) /
            (spot * (1 - best.pool.fee / 1000000))) *
        100
      : 0;
  if (!Number.isFinite(impact) || impact > 5 || impact < -5)
    throw new Error(
      "Quote diverges more than 5% from indexed evidence. Refresh and investigate before exiting.",
    );
  const expiresAt = Date.now() + 60000;
  const transactions: Quote["transactions"] = [];
  const [native, tokenBalance, allowance, fees] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: contracts.weth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
    client.readContract({
      address: contracts.weth,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, contracts.router],
    }),
    client.estimateFeesPerGas(),
  ]);
  if ((asset === "ETH" ? native : tokenBalance) < amountIn)
    throw new Error(`Insufficient ${asset} balance.`);
  if (asset === "WETH" && allowance < amountIn)
    transactions.push({
      to: contracts.weth,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [contracts.router, amountIn],
      }),
      value: "0",
      label: `Approve exactly ${amount} WETH`,
    });
  const swap = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: contracts.weth,
        tokenOut: contracts.usdc,
        fee: best.pool.fee,
        recipient: address,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: BigInt(0),
      },
    ],
  });
  const calls: Hex[] = [swap];
  if (asset === "ETH")
    calls.push(
      encodeFunctionData({ abi: routerAbi, functionName: "refundETH" }),
    );
  transactions.push({
    to: contracts.router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "multicall",
      args: [BigInt(Math.floor(expiresAt / 1000)), calls],
    }),
    value: asset === "ETH" ? amountIn.toString() : "0",
    label: `Swap ${amount} ${asset} for at least ${formatUnits(minOut, 6)} USDC`,
  });
  // Reserve conservatively for execution and Base's additional L1 data charge.
  const gasUnits =
    best.gas +
    BigInt(160000) +
    (transactions.length > 1 ? BigInt(70000) : BigInt(0));
  const gasReserve =
    gasUnits * (fees.maxFeePerGas ?? BigInt(1000000000)) * BigInt(2) +
    BigInt(10000000000000);
  if (native < (asset === "ETH" ? amountIn : BigInt(0)) + gasReserve)
    throw new Error("Leave more ETH for gas and Base data fees.");
  if (transactions.length === 1)
    await client.call({
      account: address,
      to: contracts.router,
      data: transactions[0].data as Hex,
      value: BigInt(transactions[0].value),
    });
  return {
    source: "live",
    asset,
    amountIn: amount,
    amountOut: formatUnits(best.out, 6),
    minimumOut: formatUnits(minOut, 6),
    gasUsd: Number(formatUnits(gasReserve, 18)) * best.pool.price,
    gasUnits: gasUnits.toString(),
    fee: best.pool.fee,
    pool: best.pool.address,
    block: Number(blockNumber),
    expiresAt,
    priceImpactPct: Math.max(0, impact),
    alternatives: routes.map((r) => ({
      fee: r.pool.fee,
      output: formatUnits(r.out, 6),
    })),
    transactions,
  };
}

export async function simulateStep(
  wallet: string,
  quote: Quote,
  index: number,
) {
  if (Date.now() > quote.expiresAt)
    throw new Error(
      "Quote expired. Request a new quote; do not reuse this transaction.",
    );
  const tx = quote.transactions[index];
  if (!tx) throw new Error("Invalid transaction step.");
  await rpc().call({
    account: getAddress(wallet),
    to: tx.to as Address,
    data: tx.data as Hex,
    value: BigInt(tx.value),
  });
  return tx;
}
