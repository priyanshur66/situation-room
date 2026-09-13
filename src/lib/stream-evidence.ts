export type StreamTransfer = {
  hash: string;
  block: number;
  token: string;
  from: string;
  to: string;
  rawAmount: string;
};
export type StreamEvidence = {
  status: "complete" | "partial" | "unavailable";
  source: "Substreams";
  fromBlock: number;
  toBlock: number;
  requestedToBlock: number;
  blocksRead: number;
  checkedAt: number;
  cursor?: string;
  transfers: StreamTransfer[];
  pools: { address: string; swaps: number; usdcVolume: number }[];
  note: string;
};

export function composeActivity(
  stream: StreamEvidence | undefined,
  pools: { address: string; days: { date: number; volumeUsd: number }[] }[],
  indexedAt: number,
) {
  if (!stream || stream.status !== "complete" || stream.blocksRead < 2)
    return [];
  // Base block intervals are not used to extrapolate a tiny sample into a daily forecast.
  return stream.pools.map((live) => {
    const pool = pools.find((p) => p.address.toLowerCase() === live.address);
    const prior =
      pool?.days.filter((d) => d.date + 86400 <= indexedAt).slice(0, 7) ?? [];
    const averageDailyVolume = prior.length
      ? prior.reduce((sum, day) => sum + day.volumeUsd, 0) / prior.length
      : null;
    return {
      ...live,
      averageDailyVolume,
      fractionOfAverageDay: averageDailyVolume
        ? live.usdcVolume / averageDailyVolume
        : null,
    };
  });
}
