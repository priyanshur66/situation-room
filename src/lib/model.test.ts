import { describe, expect, it } from "vitest";
import { analyze, parseAmount } from "./model";
import { sample } from "./__fixtures__/snapshot";
describe("exact amounts", () => {
  it("preserves 18 decimals without floating point", () => {
    expect(parseAmount("1.000000000000000001", 18)).toBe(1000000000000000001n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
  });
  it.each([
    "0",
    "-1",
    "1e3",
    " 1",
    "01",
    ".1",
    "1.",
    "NaN",
    "Infinity",
    "0.0000001",
    "1;alert(1)",
  ])("rejects %s for USDC", (value) =>
    expect(() => parseAmount(value, 6)).toThrow(),
  );
});
describe("exposure analysis", () => {
  it("combines ETH and WETH as one underlying", () => {
    const result = analyze(sample);
    expect(result.eth).toBeCloseTo(3.2 * 2517);
    expect(result.concentration).toBeCloseTo((result.eth / result.total) * 100);
    expect(result.signals.some((s) => s.id === "concentration")).toBe(true);
  });
  it("holds current units constant in historical comparisons", () => {
    const result = analyze(sample);
    for (const day of result.history)
      expect(day.value).toBeCloseTo(3.2 * day.price + 1450);
  });
  it("does not use an incomplete current day to trigger anomalies", () => {
    const s = structuredClone(sample);
    s.pools[0].days = Array.from({ length: 9 }, (_, i) => ({
      date: s.indexedAt - (9 - i) * 86400,
      price: 2500,
      volumeUsd: 100,
      tvlUsd: 1000,
    }));
    s.pools[0].days.push({
      date: s.indexedAt - 100,
      price: 2500,
      volumeUsd: 1000000,
      tvlUsd: 1,
    });
    expect(analyze(s).volumeRatio).toBe(1);
    expect(analyze(s).liquidityChange).toBe(0);
  });
  it("handles empty supported balances without a safety claim", () => {
    const s = structuredClone(sample);
    s.holdings = [];
    s.pools = [];
    expect(analyze(s).concentration).toBe(0);
    expect(analyze(s).signals[0].id).toBe("coverage");
  });
});
