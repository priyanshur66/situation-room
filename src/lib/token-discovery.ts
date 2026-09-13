import { erc20Abi, formatUnits, getAddress } from "viem";
import { contracts, rpc } from "./chain";
import {
  trackedTokens,
  type DiscoveredHolding,
  type PortfolioDiscovery,
} from "./portfolio";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const core = new Set([
  contracts.weth.toLowerCase(),
  contracts.usdc.toLowerCase(),
]);
function label(value: unknown, fallback: string, max: number) {
  return typeof value === "string"
    ? value
        .replace(
          /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
          "",
        )
        .trim()
        .slice(0, max) || fallback
    : fallback;
}
export function parseTokenPage(body: unknown, wallet: string) {
  if (
    !body ||
    typeof body !== "object" ||
    !("data" in body) ||
    !Array.isArray(body.data) ||
    body.data.length > 10
  )
    throw new Error("Invalid token discovery response.");
  let rejected = 0;
  const tokens: DiscoveredHolding[] = [];
  for (const item of body.data) {
    if (
      !item ||
      typeof item !== "object" ||
      item.network !== "base" ||
      typeof item.address !== "string" ||
      item.address.toLowerCase() !== wallet.toLowerCase() ||
      typeof item.contract !== "string" ||
      !addressPattern.test(item.contract) ||
      typeof item.amount !== "string" ||
      !/^\d{1,78}$/.test(item.amount) ||
      !Number.isSafeInteger(item.last_update_block_num) ||
      item.last_update_block_num < 0
    ) {
      rejected++;
      continue;
    }
    const contract = item.contract.toLowerCase();
    if (core.has(contract) || BigInt(item.amount) === 0n) continue;
    const known = trackedTokens[contract];
    tokens.push({
      contract,
      symbol: known?.symbol ?? label(item.symbol, "Unknown token", 24),
      name: known?.name ?? label(item.name, "Unverified metadata", 80),
      sector: known?.sector ?? "Unclassified",
      recognized: !!known,
      // Indexed `value` is token units, NOT USD. Re-read units/decimals onchain.
      units: null,
      decimals: null,
      indexedBlock: item.last_update_block_num,
    });
  }
  return { tokens, rejected, empty: body.data.length === 0 };
}

export async function discoverTokens(
  wallet: string,
  blockNumber: bigint,
  client = rpc(),
  request: typeof fetch = fetch,
  token = process.env.TOKEN_API_KEY || process.env.SUBSTREAMS_API_TOKEN,
): Promise<PortfolioDiscovery> {
  const address = getAddress(wallet);
  const result: PortfolioDiscovery = {
    source: "The Graph Token API / Pinax",
    status: "unavailable",
    rpcBlock: Number(blockNumber),
    pages: 0,
    rejectedRows: 0,
    holdings: [],
    note: "Token discovery unavailable; directly checked tracked contracts only.",
  };
  const found = new Map<string, DiscoveredHolding>(
    Object.entries(trackedTokens).map(([contract, info]) => [
      contract,
      {
        contract,
        ...info,
        recognized: true,
        units: null,
        decimals: null,
        indexedBlock: null,
      },
    ]),
  );
  if (token) {
    const signal = AbortSignal.timeout(20000);
    try {
      for (let page = 1; page <= 10; page++) {
        const url = new URL("https://api.pinax.network/v1/evm/balances");
        url.search = new URLSearchParams({
          network: "base",
          address,
          limit: "10",
          page: String(page),
        }).toString();
        const response = await request(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok) throw new Error("Token discovery request failed.");
        const parsed = parseTokenPage(await response.json(), address);
        result.pages++;
        result.rejectedRows += parsed.rejected;
        for (const holding of parsed.tokens)
          found.set(holding.contract, holding);
        result.status =
          parsed.empty && !result.rejectedRows ? "complete" : "partial";
        if (parsed.empty) break;
      }
    } catch {
      result.status = result.pages ? "partial" : "unavailable";
    }
  }
  const candidates = [...found.values()];
  // Bounded batches also support B20 precompiles; no bytecode-presence assumption.
  let rpcFailures = 0;
  for (let offset = 0; offset < candidates.length; offset += 12) {
    const batch = candidates.slice(offset, offset + 12);
    const reads = await client
      .multicall({
        contracts: batch.flatMap((h) => [
          {
            address: getAddress(h.contract),
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [address] as const,
          },
          {
            address: getAddress(h.contract),
            abi: erc20Abi,
            functionName: "decimals" as const,
          },
        ]),
        blockNumber,
        allowFailure: true,
      })
      .catch(() => null);
    for (let index = 0; index < batch.length; index++) {
      const holding = batch[index],
        balance = reads?.[index * 2],
        decimals = reads?.[index * 2 + 1];
      if (
        balance?.status === "success" &&
        typeof balance.result === "bigint" &&
        balance.result === 0n
      )
        continue;
      if (
        balance?.status === "success" &&
        typeof balance.result === "bigint" &&
        balance.result >= 0n &&
        decimals?.status === "success" &&
        typeof decimals.result === "number" &&
        Number.isInteger(decimals.result) &&
        decimals.result >= 0 &&
        decimals.result <= 36
      ) {
        result.holdings.push({
          ...holding,
          units: formatUnits(balance.result, decimals.result),
          decimals: decimals.result,
        });
      } else {
        rpcFailures++;
        // An unavailable seed does not prove that this wallet holds that token.
        if (holding.indexedBlock !== null) result.holdings.push(holding);
      }
    }
  }
  if (rpcFailures && result.status === "complete") result.status = "partial";
  result.holdings.sort(
    (a, b) =>
      Number(b.recognized) - Number(a.recognized) ||
      a.contract.localeCompare(b.contract),
  );
  result.note =
    result.status === "complete"
      ? "Indexed pages exhausted; balances checked on Base. Indexing may lag. Additional holdings are excluded from the ETH/WETH/USDC total and spending."
      : result.status === "partial"
        ? "Partial discovery: pagination, rejected rows or balance checks are incomplete. Missing assets are unknown, not zero. Additional holdings are excluded from the ETH/WETH/USDC total and spending."
        : "Token discovery unavailable. Tracked contracts checked directly; other assets may be missing. Additional holdings are excluded from the ETH/WETH/USDC total and spending.";
  return result;
}
