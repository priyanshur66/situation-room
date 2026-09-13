import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard, type DashboardActions } from "./dashboard";
import { sample } from "../lib/__fixtures__/snapshot";
import type { Snapshot } from "../lib/model";

const actions: DashboardActions = {
  ready: true,
  connected: true,
  wallet: sample.wallet,
  wallets: [{ address: sample.wallet, label: "Wallet" }],
  selectWallet: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  refresh: vi.fn(),
  quote: vi.fn(),
  execute: vi.fn(),
  ask: vi.fn(),
  funding: vi.fn(),
  verifyPending: vi.fn(),
};

function expectNoPortfolio(html: string) {
  expect(html).not.toContain("Portfolio summary");
  expect(html).not.toContain("9,504");
  expect(html).not.toContain("1,450");
  expect(html).not.toContain("sell-amount");
  expect(html).not.toContain("Ask the assistant");
  expect(html).not.toContain("card balance");
  expect(html).toContain("NO WALLET DATA");
}

describe("real wallet data boundary", () => {
  it("does not fabricate balances while the wallet module loads", () => {
    const html = renderToStaticMarkup(<Dashboard />);
    expectNoPortfolio(html);
    expect(html).toContain("Loading wallet connection");
  });
  it("shows configuration failure without substitute data", () => {
    const html = renderToStaticMarkup(
      <Dashboard unavailableReason="Data service unavailable" />,
    );
    expectNoPortfolio(html);
    expect(html).toContain("Data service unavailable");
  });
  it("does not reveal a cached snapshot after disconnect", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        actions={{ ...actions, connected: false }}
        savedSnapshot={sample}
      />,
    );
    expectNoPortfolio(html);
    expect(html).toContain("Connect your wallet to begin");
  });
  it("shows an unloaded state for a connected wallet without a snapshot", () => {
    const html = renderToStaticMarkup(<Dashboard actions={actions} />);
    expectNoPortfolio(html);
    expect(html).toContain("Your wallet data has not been loaded");
  });
  it("rejects snapshots belonging to a different wallet", () => {
    expectNoPortfolio(
      renderToStaticMarkup(
        <Dashboard
          actions={{
            ...actions,
            wallet: "0x0000000000000000000000000000000000000002",
          }}
          savedSnapshot={sample}
        />,
      ),
    );
  });
  it("rejects legacy sample payloads at runtime", () => {
    const legacy = { ...sample, mode: "sample" } as unknown as Snapshot;
    expectNoPortfolio(
      renderToStaticMarkup(
        <Dashboard actions={actions} savedSnapshot={legacy} />,
      ),
    );
  });
  it("renders actual zero balances and leaves transaction inputs blank", () => {
    const empty = {
      ...sample,
      holdings: sample.holdings.map((h) => ({ ...h, units: "0", valueUsd: 0 })),
      pools: [],
    };
    const html = renderToStaticMarkup(
      <Dashboard actions={actions} savedSnapshot={empty} />,
    );
    expect(html).toContain("Portfolio summary");
    expect(html).toContain("$0.00");
    expect(html).toContain("0 HELD ASSETS");
    expect(html).toContain("No indexed history is available");
    expect(html).toMatch(/id="sell-amount"[^>]*value=""/);
    expect(html).toMatch(/id="funding-target"[^>]*value=""/);
    expect(html).not.toContain("card balance");
    expect(html).not.toContain("9,504");
  });
});
