export type Asset = "ETH" | "WETH" | "USDC";
export type Day = {
  date: number;
  price: number;
  volumeUsd: number;
  tvlUsd: number;
};
export type Pool = {
  address: string;
  fee: number;
  tvlUsd: number;
  price: number;
  days: Day[];
};
export type Snapshot = {
  mode: "sample" | "live";
  wallet: string;
  fetchedAt: number;
  indexedAt: number;
  block: number;
  rpcBlock: number;
  subgraphId: string;
  holdings: { symbol: Asset; units: string; valueUsd: number }[];
  pools: Pool[];
};
export type Quote = {
  source: "sample" | "live";
  asset: "ETH" | "WETH";
  amountIn: string;
  amountOut: string;
  minimumOut: string;
  gasUsd: number;
  gasUnits: string;
  fee: number;
  pool: string;
  block: number;
  expiresAt: number;
  priceImpactPct: number;
  alternatives: { fee: number; output: string }[];
  transactions: { to: string; data: string; value: string; label: string }[];
  planId?: string;
};
export type FundingPlan = {
  target: string;
  existingUsdc: string;
  shortfall: string;
  quote: Quote | null;
  options: { asset: "ETH" | "WETH"; amount: string; costUsd: number }[];
  note: string;
};
export function analyze(s: Snapshot) {
  const total = s.holdings.reduce((sum, h) => sum + h.valueUsd, 0);
  const eth = s.holdings
    .filter((h) => h.symbol !== "USDC")
    .reduce((sum, h) => sum + h.valueUsd, 0);
  const concentration = total ? (eth / total) * 100 : 0;
  const days = [...(s.pools[0]?.days ?? [])].sort((a, b) => a.date - b.date);
  const completed = days.filter((d) => d.date + 86400 <= s.indexedAt);
  const latest = completed.at(-1),
    prior = completed.slice(-8, -1);
  const average = prior.length
    ? prior.reduce((sum, d) => sum + d.volumeUsd, 0) / prior.length
    : 0;
  const volumeRatio = latest && average > 0 ? latest.volumeUsd / average : null;
  const lastTvl = completed.at(-2)?.tvlUsd;
  const liquidityChange =
    latest && lastTvl ? ((latest.tvlUsd - lastTvl) / lastTvl) * 100 : null;
  const signals: {
    id: string;
    title: string;
    detail: string;
    evidence: string;
    watch: boolean;
  }[] = [];
  if (concentration > 60)
    signals.push({
      id: "concentration",
      title: "One underlying, two positions",
      detail: `${concentration.toFixed(1)}% of supported value depends on ETH. Wrapping ETH does not diversify its price exposure.`,
      evidence: "ETH + WETH balances × indexed price",
      watch: true,
    });
  if (volumeRatio !== null && volumeRatio > 2)
    signals.push({
      id: "volume",
      title: "Unusual pool activity",
      detail: `Last complete day's volume is ${volumeRatio.toFixed(1)}× its preceding ${prior.length}-day average. Activity alone does not imply an exploit.`,
      evidence: "The Graph · poolDayDatas.volumeUSD",
      watch: true,
    });
  if (liquidityChange !== null && liquidityChange < -15)
    signals.push({
      id: "liquidity",
      title: "Liquidity is thinning",
      detail: `Pool TVL fell ${Math.abs(liquidityChange).toFixed(1)}% between the last two completed days. Asset prices also affect TVL.`,
      evidence: "The Graph · poolDayDatas.tvlUSD",
      watch: true,
    });
  if (!signals.length)
    signals.push({
      id: "coverage",
      title: "No threshold triggered",
      detail:
        "Supported concentration, volume and TVL checks did not trigger. This is not a safety rating or smart-contract audit.",
      evidence: "Three deterministic checks · supported assets only",
      watch: false,
    });
  const units = s.holdings
    .filter((h) => h.symbol !== "USDC")
    .reduce((sum, h) => sum + Number(h.units), 0);
  const stables = s.holdings.find((h) => h.symbol === "USDC")?.valueUsd ?? 0;
  return {
    total,
    eth,
    stables,
    concentration,
    signals,
    volumeRatio,
    liquidityChange,
    history: days.map((d) => ({ ...d, value: units * d.price + stables })),
  };
}
export const money = (v: number, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(v);
export const shortAddress = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
export function parseAmount(value: string, decimals: number): bigint {
  if (
    !new RegExp(`^(?:0|[1-9]\\d{0,12})(?:\\.\\d{1,${decimals}})?$`).test(value)
  )
    throw new Error(
      `Enter a positive amount with up to ${decimals} decimal places.`,
    );
  const [whole, part = ""] = value.split(".");
  const amount =
    BigInt(whole) * BigInt(10) ** BigInt(decimals) +
    BigInt(part.padEnd(decimals, "0"));
  if (amount <= BigInt(0)) throw new Error("Amount must be greater than zero.");
  return amount;
}
