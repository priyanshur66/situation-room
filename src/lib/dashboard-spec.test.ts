import { expect, it } from "vitest";
import { validateDashboard } from "./dashboard-spec";
import { generateDashboard } from "./dashboard-generator";

it("accepts supported panels but does not retain model-supplied values", () => {
  const spec = validateDashboard({
    title: " Exposure ",
    panels: [{ kind: "exposure", days: 14, value: 9999 }],
    unsupported: [],
    html: "<script>",
  });
  expect(spec).toEqual({
    title: "Exposure",
    panels: [{ kind: "exposure", days: 14 }],
    unsupported: [],
  });
});
it("rejects arbitrary panels, query execution and unsupported periods", () => {
  for (const panel of [
    { kind: "sql", days: 14 },
    { kind: "history", days: 365 },
    null,
  ]) {
    expect(() =>
      validateDashboard({ title: "View", panels: [panel], unsupported: [] }),
    ).toThrow();
  }
});
it("allows honest unsupported requests without invented panels", () => {
  expect(
    validateDashboard({
      title: "Stocks",
      panels: [],
      unsupported: ["Stock positions are not supported."],
    }).panels,
  ).toEqual([]);
  expect(() =>
    validateDashboard({ title: "Empty", panels: [], unsupported: [] }),
  ).toThrow();
});
it.skipIf(process.env.RUN_DASHBOARD_TESTS !== "1")(
  "builds a view through the live structured-output API",
  async () => {
    const spec = await generateDashboard(
      "Show my holdings, ETH exposure and 14-day pool liquidity, and predict next month's profit.",
    );
    expect(spec.panels.some((p) => p.kind === "holdings")).toBe(true);
    expect(spec.panels.some((p) => p.kind === "exposure")).toBe(true);
    expect(
      spec.panels.some((p) => p.kind === "liquidity" && p.days === 14),
    ).toBe(true);
    expect(spec.unsupported.length).toBeGreaterThan(0);
  },
  60000,
);
