// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type DashboardActions } from "./dashboard";
import { sample } from "../lib/__fixtures__/snapshot";
import type { Quote, Snapshot } from "../lib/model";

vi.mock("recharts", () => ({
  ResponsiveContainer: () => null,
  Area: () => null,
  AreaChart: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("dashboard swap controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let actions: DashboardActions;
  beforeEach(async () => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const quote: Quote = {
      source: "live",
      asset: "ETH",
      amountIn: "0.01",
      amountOut: "25",
      minimumOut: "24.875",
      gasUsd: 0.01,
      gasUnits: "100000",
      fee: 3000,
      pool: sample.pools[0].address,
      block: sample.rpcBlock,
      expiresAt: Date.now() + 60_000,
      priceImpactPct: 0.01,
      alternatives: [],
      transactions: [],
    };
    actions = {
      ready: true,
      connected: true,
      wallet: sample.wallet,
      wallets: [{ address: sample.wallet, label: "Wallet" }],
      selectWallet: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      refresh: vi.fn().mockResolvedValue(sample),
      quote: vi.fn().mockResolvedValue(quote),
      execute: vi.fn(),
      ask: vi.fn().mockResolvedValue("Review your supported exposure."),
      funding: vi.fn(),
      verifyPending: vi.fn(),
    };
    await act(async () => root.render(<Dashboard actions={actions} />));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  function get<T extends Element>(selector: string): T {
    const element = container.querySelector<T>(selector);
    expect(element).not.toBeNull();
    return element!;
  }
  async function type(selector: string, value: string) {
    const input = get<HTMLInputElement>(selector);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submitSwap() {
    await act(async () => {
      get<HTMLFormElement>('[aria-label="Quick swap"]').dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  }
  it("shares swap inputs and requests a quote without executing a trade", async () => {
    expect(get<HTMLButtonElement>(".quick-swap button").disabled).toBe(true);
    await type('[aria-label="Quick swap amount"]', "0.01");
    expect(get<HTMLInputElement>("#sell-amount").value).toBe("0.01");
    await submitSwap();
    expect(actions.quote).toHaveBeenCalledWith("ETH", "0.01");
    expect(actions.execute).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(get("#exit"));
    expect(get("#exit").textContent).toContain("24.875 USDC");
    expect(get("#exit").textContent).toContain("Review & approve in wallet");
    await type("#sell-amount", "0.02");
    expect(
      get<HTMLInputElement>('[aria-label="Quick swap amount"]').value,
    ).toBe("0.02");
    expect(container.querySelector(".quote-result")).toBeNull();
  });
  it("shares the selected asset and invalidates the quote", async () => {
    await type('[aria-label="Quick swap amount"]', "0.01");
    await submitSwap();
    const select = get<HTMLSelectElement>('[aria-label="Quick swap asset"]');
    await act(async () => {
      select.value = "WETH";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(get<HTMLSelectElement>('[aria-label="Asset to sell"]').value).toBe(
      "WETH",
    );
    expect(container.querySelector(".quote-result")).toBeNull();
    await submitSwap();
    expect(actions.quote).toHaveBeenLastCalledWith("WETH", "0.01");
  });
  it("rejects empty or invalid amounts and surfaces quote failures", async () => {
    await submitSwap();
    expect(actions.quote).not.toHaveBeenCalled();
    await type('[aria-label="Quick swap amount"]', "-1");
    await submitSwap();
    expect(actions.quote).not.toHaveBeenCalled();
    actions.quote = vi
      .fn()
      .mockRejectedValue(new Error("Insufficient balance"));
    await type('[aria-label="Quick swap amount"]', "0.01");
    await submitSwap();
    expect(get('[role="alert"]').textContent).toContain("Insufficient balance");
    expect(actions.execute).not.toHaveBeenCalled();
  });
  it("keeps a working read-only assistant inside the exit planner", async () => {
    expect(get("#assistant").closest("#exit")).not.toBeNull();
    await type(
      '[aria-label="Ask the assistant"]',
      "What would an exit change?",
    );
    await act(async () =>
      get<HTMLButtonElement>('[aria-label="Send question"]').click(),
    );
    expect(actions.ask).toHaveBeenCalledWith("What would an exit change?");
    expect(get("#assistant").textContent).toContain(
      "Review your supported exposure.",
    );
    expect(actions.execute).not.toHaveBeenCalled();
  });
  it("shows every supported token with a zero balance after a complete scan", async () => {
    const empty: Snapshot = {
      ...sample,
      holdings: sample.holdings.map((holding) => ({
        ...holding,
        units: "0",
        valueUsd: 0,
      })),
      discovery: {
        source: "The Graph Token API / Pinax",
        status: "complete",
        rpcBlock: sample.rpcBlock,
        pages: 1,
        rejectedRows: 0,
        holdings: [],
        note: "",
      },
    };
    await act(async () => root.unmount());
    root = createRoot(container);
    actions.refresh = vi.fn().mockResolvedValue(empty);
    await act(async () => root.render(<Dashboard actions={actions} />));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    await type("#sell-amount", "1");
    for (const label of ["Quick swap asset", "Asset to sell"]) {
      const selector = get<HTMLSelectElement>(`[aria-label="${label}"]`);
      expect(
        Array.from(selector.options, (option) => option.textContent),
      ).toEqual([
        "ETH · 0",
        "WETH · 0",
        "DEGEN · 0",
        "AERO · 0",
        "AAPLc · 0",
        "NVDAc · 0",
      ]);
      for (const option of Array.from(selector.options)) {
        await act(async () => {
          selector.value = option.value;
          selector.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(get<HTMLButtonElement>(".quick-swap button").disabled).toBe(
          true,
        );
        expect(get<HTMLButtonElement>("#exit > button").disabled).toBe(true);
        await submitSwap();
      }
    }
    expect(actions.quote).not.toHaveBeenCalled();
  });
  it("does not display unverified missing balances as zero", async () => {
    const select = get<HTMLSelectElement>('[aria-label="Asset to sell"]');
    expect(
      Array.from(select.options).find((option) => option.value === "DEGEN")
        ?.textContent,
    ).toBe("DEGEN · Unavailable");
    await act(async () => {
      select.value = "DEGEN";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type("#sell-amount", "1");
    expect(get<HTMLButtonElement>("#exit > button").disabled).toBe(true);
    await submitSwap();
    expect(actions.quote).not.toHaveBeenCalled();
  });
  it("marks additional chains as upcoming without selectable unsupported networks", () => {
    expect(get(".sidebar-bottom").textContent).toContain("Base mainnet");
    expect(get(".network-roadmap").textContent).toContain(
      "More chains · Coming soon",
    );
    expect(container.querySelector(".sidebar-bottom select")).toBeNull();
  });
});
