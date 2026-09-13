import { getAddress, parseAbi } from "viem";
import { contracts, rpc } from "./chain";
import {
  trackedTokens,
  type PortfolioDiscovery,
  type TokenMarket,
} from "./portfolio";
import type { Pool } from "./model";

export const tokenMarketQuery = `query TokenMarkets($tokens:[String!]!,$references:[String!]!) {
  _meta { block { number timestamp } hasIndexingErrors }
  forward:pools(first:100,where:{token0_in:$tokens,token1_in:$references},orderBy:totalValueLockedUSD,orderDirection:desc) {
    id feeTier token0 { id } token1 { id } token0Price token1Price totalValueLockedUSD
    poolDayData(first:30,orderBy:date,orderDirection:desc) { date token0Price token1Price volumeUSD tvlUSD }
  }
  reverse:pools(first:100,where:{token1_in:$tokens,token0_in:$references},orderBy:totalValueLockedUSD,orderDirection:desc) {
    id feeTier token0 { id } token1 { id } token0Price token1Price totalValueLockedUSD
    poolDayData(first:30,orderBy:date,orderDirection:desc) { date token0Price token1Price volumeUSD tvlUSD }
  }
}`;
type IndexedPool = {
  id: string;
  feeTier: string;
  token0: { id: string };
  token1: { id: string };
  token0Price: string;
  token1Price: string;
  totalValueLockedUSD: string;
  poolDayData: {
    date: number;
    token0Price: string;
    token1Price: string;
    volumeUSD: string;
    tvlUSD: string;
  }[];
};
type MarketResponse = {
  _meta: {
    block: { number: number; timestamp: number };
    hasIndexingErrors: boolean;
  };
  forward: IndexedPool[];
  reverse: IndexedPool[];
};
const number = (value: unknown) =>
  typeof value === "string" &&
  value.trim() !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;

export function parseTokenMarkets(
  data: MarketResponse,
  tokens: string[],
  eth: Pool,
  subgraphId: string,
  now = Date.now(),
) {
  const meta = data?._meta;
  if (
    !meta ||
    meta.hasIndexingErrors ||
    !Number.isSafeInteger(meta.block?.number) ||
    !Number.isSafeInteger(meta.block?.timestamp) ||
    now / 1000 - meta.block.timestamp > 300 ||
    meta.block.timestamp - now / 1000 > 60 ||
    !Array.isArray(data.forward) ||
    !Array.isArray(data.reverse)
  )
    throw new Error("Token market evidence unavailable or stale.");
  const markets: {
    token: string;
    token0: string;
    token1: string;
    market: TokenMarket;
  }[] = [];
  for (const p of [...data.forward, ...data.reverse].slice(0, 200)) {
    if (
      !p ||
      !addressPattern.test(p.id) ||
      !addressPattern.test(p.token0?.id) ||
      !addressPattern.test(p.token1?.id)
    )
      continue;
    const t0 = p.token0.id.toLowerCase(),
      t1 = p.token1.id.toLowerCase();
    const token = tokens.includes(t0) ? t0 : tokens.includes(t1) ? t1 : null;
    if (!token || !trackedTokens[token]) continue;
    const quote = token === t0 ? t1 : t0;
    if (
      ![contracts.usdc.toLowerCase(), contracts.weth.toLowerCase()].includes(
        quote,
      )
    )
      continue;
    const fee = Number(p.feeTier),
      tvl = number(p.totalValueLockedUSD);
    const ratio = number(token === t0 ? p.token1Price : p.token0Price);
    if (
      ![100, 500, 3000, 10000].includes(fee) ||
      tvl === null ||
      tvl < 10000 ||
      ratio === null ||
      ratio <= 0 ||
      !Array.isArray(p.poolDayData)
    )
      continue;
    const wethQuoted = quote === contracts.weth.toLowerCase();
    const priceUsd = ratio * (wethQuoted ? eth.price : 1);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    const days = p.poolDayData
      .filter(
        (d) =>
          Number.isSafeInteger(d.date) &&
          d.date > 0 &&
          d.date <= meta.block.timestamp &&
          number(d.tvlUSD) !== null &&
          number(d.volumeUSD) !== null,
      )
      .slice(0, 30);
    const history = days.flatMap((d) => {
      const price = number(token === t0 ? d.token1Price : d.token0Price);
      const usd = wethQuoted
        ? eth.days.find((e) => e.date === d.date)?.price
        : 1;
      return price !== null &&
        price > 0 &&
        usd !== undefined &&
        Number.isFinite(price * usd)
        ? [{ date: d.date, priceUsd: price * usd }]
        : [];
    });
    markets.push({
      token,
      token0: t0,
      token1: t1,
      market: {
        source: "The Graph / Uniswap V3",
        subgraphId,
        indexedBlock: meta.block.number,
        indexedAt: meta.block.timestamp,
        pool: p.id.toLowerCase(),
        fee,
        quoteToken: wethQuoted ? "WETH" : "USDC",
        priceUsd,
        liquidityUsd: tvl,
        latestDayVolumeUsd: days[0] ? number(days[0].volumeUSD) : null,
        history,
      },
    });
  }
  return markets.sort((a, b) => b.market.liquidityUsd - a.market.liquidityUsd);
}

export async function enrichTokenMarkets(
  discovery: PortfolioDiscovery,
  eth: Pool,
  client = rpc(),
  request: typeof fetch = fetch,
): Promise<PortfolioDiscovery> {
  const tokens = discovery.holdings
    .filter((h) => h.recognized && h.units !== null && Number(h.units) > 0)
    .map((h) => h.contract);
  if (!tokens.length) return discovery;
  const key = process.env.GRAPH_API_KEY,
    id = process.env.GRAPH_SUBGRAPH_ID;
  if (!key || !id)
    return {
      ...discovery,
      marketNote:
        "Additional token prices unavailable: market source not configured.",
    };
  try {
    const response = await request(
      `https://gateway.thegraph.com/api/subgraphs/id/${id}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: tokenMarketQuery,
          variables: {
            tokens,
            references: [
              contracts.weth.toLowerCase(),
              contracts.usdc.toLowerCase(),
            ],
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error("Market request failed.");
    const body = await response.json();
    if (body.errors?.length) throw new Error("Incomplete market evidence.");
    const candidates = parseTokenMarkets(body.data, tokens, eth, id);
    const abi = parseAbi([
      "function getPool(address,address,uint24) view returns(address)",
    ]);
    const checks = await client.multicall({
      allowFailure: true,
      contracts: candidates.map((p) => ({
        address: contracts.factory,
        abi,
        functionName: "getPool" as const,
        args: [
          getAddress(p.token0),
          getAddress(p.token1),
          p.market.fee,
        ] as const,
      })),
    });
    const byToken = new Map<string, TokenMarket>();
    candidates.forEach((p, i) => {
      const check = checks[i];
      if (
        check?.status === "success" &&
        typeof check.result === "string" &&
        check.result.toLowerCase() === p.market.pool &&
        !byToken.has(p.token)
      )
        byToken.set(p.token, p.market);
    });
    return {
      ...discovery,
      holdings: discovery.holdings.map((h) => ({
        ...h,
        market: byToken.get(h.contract),
      })),
      marketNote:
        "Indexed reference prices from factory-verified pools with at least $10,000 TVL. USDC assumed $1. These are not executable cash-out quotes; unpriced assets remain excluded.",
    };
  } catch {
    return {
      ...discovery,
      marketNote:
        "Additional token prices unavailable. Verified units remain visible; no prices were substituted.",
    };
  }
}
