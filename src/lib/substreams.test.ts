import { expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseAbi,
  type Hex,
} from "viem";
import { decodeStreamBlock, getStreamEvidence } from "./substreams";
import { composeActivity } from "./stream-evidence";
import { getEvidence } from "./graph";
import { rpc } from "./chain";

const wallet = "0x0000000000000000000000000000000000000001";
const pool = "0x0000000000000000000000000000000000000002";
const b64 = (value: Hex) =>
  Buffer.from(value.slice(2), "hex").toString("base64");

it("decodes only successful wallet transfers and swaps from selected pools", () => {
  const transfer = {
    address: b64(pool),
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: pool, to: wallet },
    }).map((t) => b64(t as Hex)),
    data: b64(encodeAbiParameters([{ type: "uint256" }], [5000000n])),
  };
  const abi = parseAbi([
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  ]);
  const swap = {
    address: b64(pool),
    topics: encodeEventTopics({
      abi,
      eventName: "Swap",
      args: { sender: wallet, recipient: wallet },
    }).map((t) => b64(t as Hex)),
    data: b64(
      encodeAbiParameters(
        [
          { type: "int256" },
          { type: "int256" },
          { type: "uint160" },
          { type: "uint128" },
          { type: "int24" },
        ],
        [1n, -5000000n, 1n, 1n, 1],
      ),
    ),
  };
  const tx = {
    hash: b64(`0x${"ab".repeat(32)}`),
    status: "SUCCEEDED",
    receipt: { logs: [transfer, swap] },
  };
  const decoded = decodeStreamBlock(
    { number: "42", transactionTraces: [tx, { ...tx, status: "FAILED" }] },
    wallet,
    [pool],
  );
  expect(decoded.transfers).toHaveLength(1);
  expect(decoded.transfers[0].rawAmount).toBe("5000000");
  expect(decoded.swaps).toEqual([{ address: pool, usdcVolume: 5 }]);
  expect(
    decodeStreamBlock({ number: "42", transactionTraces: [tx] }, pool, [])
      .swaps,
  ).toEqual([]);
});

it("does not turn missing stream evidence into zero activity", () => {
  expect(composeActivity(undefined, [], 0)).toEqual([]);
});

it.skipIf(process.env.RUN_STREAM_TESTS !== "1")(
  "reads a complete live Base window and composes real pool observations",
  async () => {
    const evidence = await getEvidence();
    const head = Number(await rpc().getBlockNumber());
    const stream = await getStreamEvidence(
      wallet,
      evidence.pools.map((p) => p.address),
      head,
    );
    expect(stream.status).toBe("complete");
    expect(stream.blocksRead).toBe(24);
    expect(stream.toBlock).toBe(head - 2);
    expect(
      composeActivity(stream, evidence.pools, evidence.indexedAt),
    ).toHaveLength(evidence.pools.length);
    console.info(
      JSON.stringify({
        status: stream.status,
        blocksRead: stream.blocksRead,
        fromBlock: stream.fromBlock,
        toBlock: stream.toBlock,
        swaps: stream.pools.reduce((n, p) => n + p.swaps, 0),
      }),
    );
  },
  60000,
);
