// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type DashboardActions } from "./dashboard";
import { sample } from "../lib/__fixtures__/snapshot";
import type { Snapshot } from "../lib/model";

vi.mock("recharts", () => ({
  ResponsiveContainer: () => null,
  Area: () => null,
  AreaChart: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const empty: Snapshot = {
  ...sample,
  holdings: sample.holdings.map((holding) => ({
    ...holding,
    units: "0",
    valueUsd: 0,
  })),
  pools: [],
};

function makeActions(): DashboardActions {
  return {
    ready: true,
    connected: true,
    wallet: empty.wallet,
    wallets: [{ address: empty.wallet, label: "Wallet" }],
    refresh: vi.fn().mockResolvedValue(empty),
    selectWallet: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    quote: vi.fn(),
    execute: vi.fn(),
    ask: vi.fn(),
    funding: vi.fn(),
    verifyPending: vi.fn(),
  };
}

describe("automatic wallet analysis", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  async function render(actions: DashboardActions, savedSnapshot?: Snapshot) {
    await act(async () =>
      root.render(
        <StrictMode>
          <Dashboard actions={actions} savedSnapshot={savedSnapshot} />
        </StrictMode>,
      ),
    );
  }
  async function tick() {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  }

  it("waits for authentication, then runs once even in Strict Mode and across callback churn", async () => {
    const actions = makeActions();
    await render({ ...actions, ready: false });
    await tick();
    expect(actions.refresh).not.toHaveBeenCalled();
    await render(actions);
    expect(container.textContent).toContain("Analyzing your wallet");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await tick();
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("$0.00");
    await render({ ...actions, refresh: () => actions.refresh() });
    await tick();
    expect(actions.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes on reconnect and clears displayed data on disconnect", async () => {
    const actions = makeActions();
    await render(actions);
    await tick();
    await render({ ...actions, connected: false });
    expect(container.textContent).not.toContain("$0.00");
    await render(actions);
    await tick();
    expect(actions.refresh).toHaveBeenCalledTimes(2);
  });

  it("analyzes a switched wallet and ignores the previous wallet's late response", async () => {
    let resolveOld!: (snapshot: Snapshot) => void;
    const old = makeActions();
    old.refresh = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render(old);
    await tick();
    const next = makeActions();
    next.wallet = "0x0000000000000000000000000000000000000002";
    next.wallets = [{ address: next.wallet, label: "Other wallet" }];
    next.refresh = vi.fn().mockResolvedValue({ ...empty, wallet: next.wallet });
    await render(next);
    await tick();
    expect(next.refresh).toHaveBeenCalledTimes(1);
    await act(async () => resolveOld(sample));
    expect(container.textContent).toContain("$0.00");
    expect(container.textContent).not.toContain("9,504");
  });

  it("retains an identified previous snapshot while refreshing", async () => {
    const actions = makeActions();
    actions.refresh = vi.fn(() => new Promise<Snapshot>(() => {}));
    await render(actions, empty);
    await tick();
    expect(container.textContent).toContain("Showing your previous snapshot");
    expect(container.textContent).toContain("$0.00");
    expect(actions.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows failures without invented data or retry loops and allows a deliberate retry", async () => {
    const actions = makeActions();
    actions.refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("Balance service unavailable"))
      .mockResolvedValue(empty);
    await render(actions);
    await tick();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Balance service unavailable",
    );
    expect(
      container.querySelector('[aria-label="Portfolio summary"]'),
    ).toBeNull();
    await render({ ...actions });
    await tick();
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry analysis",
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(actions.refresh).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("$0.00");
  });
});
