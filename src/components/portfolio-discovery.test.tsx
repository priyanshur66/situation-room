import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PortfolioDiscoveryPanel } from "./portfolio-discovery";
import { sample } from "../lib/__fixtures__/snapshot";

it("does not substitute a zero valuation for an unpriced token", () => {
  const html = renderToStaticMarkup(
    <PortfolioDiscoveryPanel
      snapshot={{
        ...sample,
        holdings: [],
        discovery: {
          source: "The Graph Token API / Pinax",
          status: "partial",
          rpcBlock: 1,
          pages: 1,
          rejectedRows: 0,
          note: "Partial scan",
          holdings: [
            {
              contract: "0x0000000000000000000000000000000000000003",
              symbol: "<script>bad</script>",
              name: "Unknown",
              sector: "Unclassified",
              recognized: false,
              units: "12",
              decimals: 18,
              indexedBlock: 1,
            },
          ],
        },
      }}
    />,
  );
  expect(html).toContain("Unpriced");
  expect(html).not.toContain("$0.00");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Unrecognized tokens");
  expect(html).toContain("excluded from spending");
});
