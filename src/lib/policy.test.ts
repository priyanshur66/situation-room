import { describe, expect, it } from "vitest";
import {
  defaultPolicy,
  liquidationBlock,
  policyMessage,
  validatePolicy,
} from "./policy";

describe("liquidation policy enforcement", () => {
  it("canonicalizes protected assets without dropping restrictions", () => {
    expect(
      validatePolicy({
        ...defaultPolicy,
        protectedAssets: ["weth", "ETH", "weth"],
      }).protectedAssets,
    ).toEqual(["ETH", "WETH"]);
  });
  it("blocks protected positions even if profitable", () => {
    expect(
      liquidationBlock(
        { ...defaultPolicy, protectedAssets: ["ETH"] },
        "ETH",
        100,
      ),
    ).toContain("protected");
  });
  it.each([
    { profitOnly: true },
    { maxLossPct: 5 },
    { order: "highest-profit" as const },
    { order: "smallest-loss" as const },
  ])("fails closed on missing cost basis %j", (overrides) => {
    expect(
      liquidationBlock({ ...defaultPolicy, ...overrides }, "WETH", null),
    ).toContain("unknown");
  });
  it("checks actual loss and profit thresholds", () => {
    expect(
      liquidationBlock({ ...defaultPolicy, profitOnly: true }, "ETH", 0),
    ).toContain("not in profit");
    expect(
      liquidationBlock({ ...defaultPolicy, maxLossPct: 5 }, "ETH", -6),
    ).toContain("maximum");
    expect(
      liquidationBlock({ ...defaultPolicy, maxLossPct: 5 }, "ETH", -5),
    ).toBeNull();
  });
  it("cannot approve more per payment than per day", () => {
    expect(() =>
      validatePolicy({ ...defaultPolicy, perPaymentUsdc: "30" }),
    ).toThrow("daily");
  });
  it.each(["NaN", "-1", "0", "1e5", "1.0000001"])(
    "rejects unsafe limit %s",
    (perPaymentUsdc) => {
      expect(() =>
        validatePolicy({ ...defaultPolicy, perPaymentUsdc }),
      ).toThrow();
    },
  );
  it("does not silently ignore unsupported preferences", () => {
    expect(
      liquidationBlock(
        { ...defaultPolicy, unresolved: ["Guarantee profit"] },
        "ETH",
        3,
      ),
    ).toContain("unresolved");
  });
  it("binds signatures to the wallet, network, exact policy and challenge", () => {
    const text = policyMessage(
      "0xABC",
      "nonce-1",
      1800000000000,
      defaultPolicy,
    );
    expect(text).toContain("Base (8453)");
    expect(text).toContain("0xabc");
    expect(text).toContain("nonce-1");
    expect(text).toContain(JSON.stringify(defaultPolicy));
    expect(text).toContain("does not grant spending permission");
  });
});
