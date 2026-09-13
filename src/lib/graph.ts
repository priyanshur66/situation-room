import type { Pool } from "./model";
type GraphPool = {
  id: string;
  feeTier: string;
  token1Price: string;
  totalValueLockedUSD: string;
  poolDayData: {
    date: number;
    token1Price: string;
    volumeUSD: string;
    tvlUSD: string;
  }[];
};
type GraphData = {
  _meta: {
    block: { number: number; timestamp: number };
    hasIndexingErrors: boolean;
  };
  pools: GraphPool[];
};
export const marketQuery = `query SituationEvidence {
  _meta { block { number timestamp } hasIndexingErrors }
  pools(first:4,where:{token0:"0x4200000000000000000000000000000000000006",token1:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},orderBy:totalValueLockedUSD,orderDirection:desc) {
    id feeTier token1Price totalValueLockedUSD
    poolDayData(first:30,orderBy:date,orderDirection:desc) { date token1Price volumeUSD tvlUSD }
  }
}`;
export function parseEvidence(data: GraphData, now = Date.now()) {
  const meta = data?._meta;
  if (!meta?.block?.timestamp || meta.hasIndexingErrors)
    throw new Error("The subgraph is unavailable or reports indexing errors.");
  const age = now / 1000 - meta.block.timestamp;
  if (age > 300 || age < -60)
    throw new Error(
      "The Graph evidence is stale or has an invalid timestamp. Execution is disabled.",
    );
  const number = (value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0)
      throw new Error("Invalid indexed market value.");
    return n;
  };
  const pools: Pool[] = data.pools
    .filter((p) => [100, 500, 3000, 10000].includes(Number(p.feeTier)))
    .map((p) => ({
      address: p.id,
      fee: Number(p.feeTier),
      price: number(p.token1Price),
      tvlUsd: number(p.totalValueLockedUSD),
      days: p.poolDayData.map((d) => ({
        date: d.date,
        price: number(d.token1Price),
        volumeUsd: number(d.volumeUSD),
        tvlUsd: number(d.tvlUSD),
      })),
    }))
    .filter((p) => p.price > 0 && p.tvlUsd > 0);
  if (!pools.length || pools[0].days.length < 8)
    throw new Error("Insufficient indexed pool history for this analysis.");
  return { pools, block: meta.block.number, indexedAt: meta.block.timestamp };
}
export async function getEvidence() {
  const key = process.env.GRAPH_API_KEY,
    id = process.env.GRAPH_SUBGRAPH_ID;
  if (!key || !id) throw new Error("The Graph is not configured.");
  const response = await fetch(
    `https://gateway.thegraph.com/api/subgraphs/id/${id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: marketQuery }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok)
    throw new Error(`The Graph request failed (${response.status}).`);
  const body = await response.json();
  if (body.errors?.length)
    throw new Error(
      "The Graph could not provide complete evidence. Try again shortly.",
    );
  return { ...parseEvidence(body.data), subgraphId: id };
}
