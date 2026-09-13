import { parseAmount } from "./model";

export type LiquidationPolicy = {
  protectedAssets: string[];
  order: "lowest-cost" | "highest-profit" | "smallest-loss";
  profitOnly: boolean;
  maxLossPct: number | null;
  perPaymentUsdc: string;
  dailyUsdc: string;
  unresolved: string[];
};
export const defaultPolicy: LiquidationPolicy = {
  protectedAssets: [],
  order: "lowest-cost",
  profitOnly: false,
  maxLossPct: null,
  perPaymentUsdc: "10",
  dailyUsdc: "25",
  unresolved: [],
};
export const policySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    protectedAssets: { type: "array", items: { type: "string" } },
    order: {
      type: "string",
      enum: ["lowest-cost", "highest-profit", "smallest-loss"],
    },
    profitOnly: { type: "boolean" },
    maxLossPct: { type: ["number", "null"] },
    perPaymentUsdc: { type: "string" },
    dailyUsdc: { type: "string" },
    unresolved: { type: "array", items: { type: "string" } },
  },
  required: [
    "protectedAssets",
    "order",
    "profitOnly",
    "maxLossPct",
    "perPaymentUsdc",
    "dailyUsdc",
    "unresolved",
  ],
};
export function validatePolicy(input: unknown): LiquidationPolicy {
  if (!input || typeof input !== "object") throw new Error("Invalid policy.");
  const p = input as LiquidationPolicy;
  if (
    !Array.isArray(p.protectedAssets) ||
    p.protectedAssets.length > 40 ||
    p.protectedAssets.some(
      (s) => typeof s !== "string" || !/^[a-zA-Z0-9.]{1,42}$/.test(s),
    ) ||
    !["lowest-cost", "highest-profit", "smallest-loss"].includes(p.order) ||
    typeof p.profitOnly !== "boolean" ||
    (p.maxLossPct !== null &&
      (!Number.isFinite(p.maxLossPct) ||
        p.maxLossPct < 0 ||
        p.maxLossPct > 100)) ||
    !Array.isArray(p.unresolved) ||
    p.unresolved.some((s) => typeof s !== "string" || s.length > 300)
  )
    throw new Error("Invalid liquidation preferences.");
  const per = parseAmount(p.perPaymentUsdc, 6),
    daily = parseAmount(p.dailyUsdc, 6);
  if (per > daily || daily > 100000000000n)
    throw new Error(
      "Payment limit must be within the daily limit (maximum 100,000 USDC).",
    );
  return {
    protectedAssets: [
      ...new Set(p.protectedAssets.map((s) => s.toUpperCase())),
    ].sort(),
    order: p.order,
    profitOnly: p.profitOnly,
    maxLossPct: p.maxLossPct,
    perPaymentUsdc: p.perPaymentUsdc,
    dailyUsdc: p.dailyUsdc,
    unresolved: p.unresolved,
  };
}
export function liquidationBlock(
  policy: LiquidationPolicy,
  symbol: string,
  pnlPct: number | null,
  address?: string,
): string | null {
  if (policy.unresolved.length)
    return "Preferences contain unresolved instructions.";
  if (
    policy.protectedAssets.includes(symbol.toUpperCase()) ||
    (address && policy.protectedAssets.includes(address.toUpperCase()))
  )
    return `${symbol} is protected.`;
  if (
    (policy.profitOnly ||
      policy.maxLossPct !== null ||
      policy.order !== "lowest-cost") &&
    pnlPct === null
  )
    return `${symbol}: verified cost basis is unknown; the profit/loss rule cannot be checked.`;
  if (policy.profitOnly && pnlPct !== null && pnlPct <= 0)
    return `${symbol} is not in profit.`;
  if (
    policy.maxLossPct !== null &&
    pnlPct !== null &&
    pnlPct < -policy.maxLossPct
  )
    return `${symbol} exceeds your maximum realized loss.`;
  return null;
}
export function policyMessage(
  wallet: string,
  nonce: string,
  expiresAt: number,
  policy: LiquidationPolicy,
) {
  return `Situation Room liquidation preferences\nChain: Base (8453)\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\nPolicy: ${JSON.stringify(validatePolicy(policy))}\nThis signature saves preferences only. It does not grant spending permission. Payments require separate authorization.`;
}

export type PaymentTransaction = {
  to: string;
  data: string;
  value: string;
  label: string;
  kind: "approval" | "swap" | "payment";
  expiresAt: number;
};
export type PaymentPreview = {
  recipient: string;
  amount: string;
  existingUsdc: string;
  shortfall: string;
  transactions: PaymentTransaction[];
  liquidations: {
    symbol: string;
    amount: string;
    minimumUsdc: string;
    venue: string;
  }[];
  excluded: string[];
  gasBudgetUsd: number;
  indexedBlock: number;
  expiresAt: number;
};
