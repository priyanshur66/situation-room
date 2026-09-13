import {
  createAuthInterceptor,
  createRegistry,
  createRequest,
  fetchSubstream,
  streamBlocks,
  unpackMapOutput,
} from "@substreams/core";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  decodeEventLog,
  erc20Abi,
  formatUnits,
  parseAbi,
  type Hex,
} from "viem";
import type { StreamEvidence, StreamTransfer } from "./stream-evidence";

const swapAbi = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
type BlockJson = {
  number: string;
  transactionTraces?: {
    hash: string;
    status?: string;
    receipt?: {
      logs?: { address: string; topics?: string[]; data?: string }[];
    };
  }[];
};
const hex = (s: string): Hex => `0x${Buffer.from(s, "base64").toString("hex")}`;

export function decodeStreamBlock(
  value: BlockJson,
  wallet: string,
  pools: string[],
) {
  const transfers: StreamTransfer[] = [];
  const swaps: { address: string; usdcVolume: number }[] = [];
  const tracked = new Set(pools.map((p) => p.toLowerCase()));
  for (const tx of value.transactionTraces ?? []) {
    if (tx.status !== "SUCCEEDED") continue;
    for (const log of tx.receipt?.logs ?? []) {
      const address = hex(log.address).toLowerCase();
      const topics = (log.topics ?? []).map(hex) as [Hex, ...Hex[]];
      const data = hex(log.data ?? "");
      try {
        const event = decodeEventLog({
          abi: erc20Abi,
          eventName: "Transfer",
          topics,
          data,
        });
        if (
          [event.args.from, event.args.to].some(
            (a) => a.toLowerCase() === wallet.toLowerCase(),
          )
        )
          transfers.push({
            hash: hex(tx.hash),
            block: Number(value.number),
            token: address,
            from: event.args.from,
            to: event.args.to,
            rawAmount: event.args.value.toString(),
          });
      } catch {
        /* Other events are not ERC-20 transfers. */
      }
      if (!tracked.has(address)) continue;
      try {
        const event = decodeEventLog({
          abi: swapAbi,
          eventName: "Swap",
          topics,
          data,
        });
        // Only the verified Graph query's WETH token0 / native USDC token1 pools are accepted.
        const amount = event.args.amount1;
        swaps.push({
          address,
          usdcVolume: Number(formatUnits(amount < 0n ? -amount : amount, 6)),
        });
      } catch {
        /* Non-swap pool events do not contribute to volume. */
      }
    }
  }
  return { transfers, swaps };
}

export async function getStreamEvidence(
  wallet: string,
  pools: string[],
  head: number,
): Promise<StreamEvidence> {
  const fromBlock = Math.max(1, head - 25),
    toBlock = head - 2;
  const result: StreamEvidence = {
    source: "Substreams",
    status: "unavailable",
    fromBlock,
    toBlock: fromBlock - 1,
    requestedToBlock: toBlock,
    blocksRead: 0,
    checkedAt: Date.now(),
    transfers: [],
    pools: [],
    note: "Recent-block evidence unavailable. No streaming observations were substituted.",
  };
  const token = process.env.SUBSTREAMS_API_TOKEN;
  if (!token) return result;
  const blocks = new Map<number, ReturnType<typeof decodeStreamBlock>>();
  try {
    const pkg = await fetchSubstream(
      "https://spkg.io/streamingfast/ethereum-explorer-v0.1.2.spkg",
      { signal: AbortSignal.timeout(10000) },
    );
    const registry = createRegistry(pkg);
    const transport = createConnectTransport({
      baseUrl: "https://base-mainnet.streamingfast.io",
      httpVersion: "1.1",
      interceptors: [createAuthInterceptor(token)],
    });
    for await (const response of streamBlocks(
      transport,
      createRequest({
        substreamPackage: pkg,
        outputModule: "map_block_full",
        productionMode: true,
        startBlockNum: fromBlock,
        stopBlockNum: toBlock + 1,
      }),
      { timeoutMs: 25000 },
    )) {
      if (response.message.case === "blockUndoSignal") {
        const valid = Number(
          response.message.value.lastValidBlock?.number ?? 0,
        );
        for (const number of blocks.keys())
          if (number > valid) blocks.delete(number);
        result.cursor = response.message.value.lastValidCursor;
      }
      if (response.message.case !== "blockScopedData") continue;
      const block = unpackMapOutput(response, registry);
      if (!block) continue;
      const value = block.toJson() as unknown as BlockJson;
      const number = Number(value.number);
      if (
        !Number.isSafeInteger(number) ||
        number < fromBlock ||
        number > toBlock
      )
        continue;
      blocks.set(number, decodeStreamBlock(value, wallet, pools));
      result.cursor = response.message.value.cursor;
    }
  } catch {
    /* Provider errors must never expose credentials or become synthetic observations. */
  }
  result.blocksRead = blocks.size;
  result.toBlock = blocks.size ? Math.max(...blocks.keys()) : fromBlock - 1;
  result.status =
    blocks.size === toBlock - fromBlock + 1
      ? "complete"
      : blocks.size
        ? "partial"
        : "unavailable";
  const totals = new Map(
    pools.map((p) => [
      p.toLowerCase(),
      { address: p.toLowerCase(), swaps: 0, usdcVolume: 0 },
    ]),
  );
  for (const block of blocks.values()) {
    result.transfers.push(...block.transfers);
    for (const swap of block.swaps) {
      const aggregate = totals.get(swap.address)!;
      aggregate.swaps++;
      aggregate.usdcVolume += swap.usdcVolume;
    }
  }
  result.transfers = result.transfers.slice(-100);
  result.pools = [...totals.values()];
  result.note =
    result.status === "complete"
      ? "Recent Base blocks, not lifetime history. Unfinalized observations may change after a reorg; each refresh re-reads this window. Transfer list capped at 100."
      : result.status === "partial"
        ? "Incomplete recent-block coverage. Missing blocks are unknown, not zero activity. Do not use this sample for historical PnL."
        : result.note;
  return result;
}
