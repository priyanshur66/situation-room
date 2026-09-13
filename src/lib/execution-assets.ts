import { trackedTokens } from "./portfolio";
import type { ExecutionAsset, Snapshot } from "./model";

export const executionAssets: readonly ExecutionAsset[] = [
  "ETH",
  "WETH",
  "DEGEN",
  "AERO",
  "AAPLc",
  "NVDAc",
];
export function tokenContract(asset: ExecutionAsset) {
  return Object.entries(trackedTokens).find(
    ([, token]) => token.symbol === asset,
  )?.[0] as `0x${string}` | undefined;
}
export function executionHolding(snapshot: Snapshot, asset: ExecutionAsset) {
  const contract = tokenContract(asset);
  return snapshot.discovery?.holdings.find(
    (h) => h.contract.toLowerCase() === contract,
  );
}
export function executionBalance(snapshot: Snapshot, asset: ExecutionAsset) {
  return asset === "ETH" || asset === "WETH"
    ? snapshot.holdings.find((h) => h.symbol === asset)?.units
    : (executionHolding(snapshot, asset)?.units ??
        (snapshot.discovery?.status === "complete" ? "0" : undefined));
}
