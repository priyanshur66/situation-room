export const panelKinds = [
  "holdings",
  "exposure",
  "history",
  "liquidity",
  "volume",
  "activity",
] as const;
export type DashboardSpec = {
  title: string;
  panels: { kind: (typeof panelKinds)[number]; days: 7 | 14 | 30 }[];
  unsupported: string[];
};
export const dashboardSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    panels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: panelKinds },
          days: { type: "integer", enum: [7, 14, 30] },
        },
        required: ["kind", "days"],
      },
    },
    unsupported: { type: "array", items: { type: "string" } },
  },
  required: ["title", "panels", "unsupported"],
};
export function validateDashboard(value: unknown): DashboardSpec {
  if (!value || typeof value !== "object")
    throw new Error("Invalid dashboard configuration.");
  const s = value as DashboardSpec;
  if (
    typeof s.title !== "string" ||
    !s.title.trim() ||
    s.title.length > 80 ||
    !Array.isArray(s.panels) ||
    s.panels.length > 6 ||
    s.panels.some(
      (p) =>
        !p || !panelKinds.includes(p.kind) || ![7, 14, 30].includes(p.days),
    ) ||
    !Array.isArray(s.unsupported) ||
    s.unsupported.length > 10 ||
    s.unsupported.some((x) => typeof x !== "string" || x.length > 300)
  )
    throw new Error("Unsupported dashboard configuration.");
  if (!s.panels.length && !s.unsupported.length)
    throw new Error("No supported panels were selected.");
  return {
    title: s.title.trim(),
    panels: s.panels.map((p) => ({ kind: p.kind, days: p.days })),
    unsupported: s.unsupported,
  };
}
