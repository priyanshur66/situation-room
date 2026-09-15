import { decodeFunctionData, parseAbi, zeroAddress, type Hex } from "viem";
import { contracts } from "./chain";
import { trackedTokens } from "./portfolio";

// Aerodrome classic AMM deployments on Base. Slipstream uses a different router.
export const aerodrome = {
  router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
} as const;
export const aerodromeAbi = parseAbi([
  "function defaultFactory() view returns (address)",
  "function weth() view returns (address)",
  "function poolFor(address tokenA,address tokenB,bool stable,address factory) view returns (address)",
  "function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) payable returns (uint256[] amounts)",
]);
export const aerodromeFactoryAbi = parseAbi([
  "function getPool(address tokenA,address tokenB,bool stable) view returns (address)",
  "function isPool(address pool) view returns (bool)",
  "function getFee(address pool,bool stable) view returns (uint256)",
]);
export type AeroRoute = {
  from: `0x${string}`;
  to: `0x${string}`;
  stable: boolean;
  factory: `0x${string}`;
};

export function decodeAerodromeSwap(data: Hex) {
  const call = decodeFunctionData({ abi: aerodromeAbi, data });
  if (call.functionName === "swapExactTokensForTokens") {
    const [amountIn, minimum, routes, recipient, deadline] = call.args;
    return { amountIn, minimum, routes, recipient, deadline, native: false };
  }
  if (call.functionName === "swapExactETHForTokens") {
    const [minimum, routes, recipient, deadline] = call.args;
    return {
      amountIn: null,
      minimum,
      routes,
      recipient,
      deadline,
      native: true,
    };
  }
  throw new Error("Unsupported Aerodrome swap call.");
}

export function validateAerodromeExit(
  data: Hex,
  value: string,
  wallet?: string,
) {
  const swap = decodeAerodromeSwap(data);
  const routes = swap.routes;
  const first = routes[0]?.from.toLowerCase();
  if (
    routes.length < 1 ||
    routes.length > 2 ||
    swap.minimum <= 0n ||
    swap.deadline <= 0n ||
    swap.recipient === zeroAddress ||
    (wallet && swap.recipient.toLowerCase() !== wallet.toLowerCase()) ||
    (first !== contracts.weth.toLowerCase() &&
      !Object.hasOwn(trackedTokens, first ?? "")) ||
    routes.at(-1)?.to.toLowerCase() !== contracts.usdc.toLowerCase() ||
    routes.some(
      (r, i) =>
        r.factory.toLowerCase() !== aerodrome.factory.toLowerCase() ||
        r.from.toLowerCase() === r.to.toLowerCase() ||
        (i > 0 && routes[i - 1].to.toLowerCase() !== r.from.toLowerCase()) ||
        (i < routes.length - 1 &&
          r.to.toLowerCase() !== contracts.weth.toLowerCase()),
    ) ||
    (swap.native
      ? first !== contracts.weth.toLowerCase() || BigInt(value) <= 0n
      : BigInt(value) !== 0n || !swap.amountIn || swap.amountIn <= 0n)
  )
    throw new Error(
      "Unsupported Aerodrome liquidation route or protected output.",
    );
  return swap;
}
