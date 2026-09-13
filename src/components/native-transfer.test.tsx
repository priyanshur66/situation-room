// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { NativeTransferForm } from "./native-transfer";
import {
  prepareNativeTransfer,
  verifyNativeTransfer,
} from "../lib/native-transfer";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  request: vi.fn(),
  wait: vi.fn(),
}));
vi.mock("@privy-io/react-auth", () => ({
  useSendTransaction: () => ({ sendTransaction: mocks.send }),
}));
vi.mock("../lib/native-transfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/native-transfer")>()),
  nativeTransferClient: () => ({ waitForTransactionReceipt: mocks.wait }),
  prepareNativeTransfer: vi.fn(),
  verifyNativeTransfer: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const address = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}`;
const plan = {
  from: address,
  to: recipient,
  value: "1000000000000000",
  nonce: 4,
  feeReserve: "1000",
  balance: "2000000000000000",
} as const;
describe("direct ETH payment UI", () => {
  let root: Root, container: HTMLDivElement;
  let refresh: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  const wallet = {
    address,
    walletClientType: "privy",
    switchChain: vi.fn(),
    getEthereumProvider: async () => ({ request: mocks.request }),
  } as unknown as ConnectedWallet;
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(prepareNativeTransfer).mockResolvedValue(plan);
    vi.mocked(verifyNativeTransfer).mockResolvedValue(true);
    mocks.send.mockResolvedValue({ hash });
    mocks.wait.mockResolvedValue({ status: "success" });
    refresh = vi.fn().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <NativeTransferForm
          wallet={wallet}
          refresh={refresh}
          blocked={false}
          onBusy={() => {}}
        />,
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function type(label: string, value: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(
        `[aria-label="${label}"]`,
      )!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(text: string) {
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent?.includes(text))!
        .click();
    });
  }
  async function review() {
    await type("ETH recipient", recipient);
    await type("ETH amount", "0.001");
    await click("Review ETH");
  }
  it("only requests a wallet signature after explicit review and send", async () => {
    await review();
    expect(mocks.send).not.toHaveBeenCalled();
    await click("Send 0.001");
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: recipient,
        value: 1000000000000000n,
        chainId: 8453,
        data: "0x",
        nonce: 4,
      }),
      expect.objectContaining({
        address,
        uiOptions: expect.objectContaining({ showWalletUIs: true }),
      }),
    );
    expect(container.textContent).toContain("Confirmed on Base");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
  });
  it("sends through the selected external wallet without a Privy signer", async () => {
    mocks.request.mockResolvedValue(hash);
    await act(async () =>
      root.render(
        <NativeTransferForm
          wallet={{ ...wallet, walletClientType: "metamask" }}
          refresh={refresh}
          blocked={false}
          onBusy={() => {}}
        />,
      ),
    );
    await review();
    await click("Send 0.001");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [
        {
          from: address,
          to: recipient,
          value: "0x38d7ea4c68000",
          data: "0x",
          chainId: "0x2105",
          nonce: "0x4",
        },
      ],
    });
    expect(container.textContent).toContain("Confirmed on Base");
  });
  it("asks for another review when network fees exceed the reviewed reserve", async () => {
    await review();
    vi.mocked(prepareNativeTransfer).mockResolvedValueOnce({
      ...plan,
      feeReserve: "3000",
    });
    await click("Send 0.001");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(container.textContent).toContain("fees changed");
    expect(localStorage.length).toBe(0);
  });
  it("unlocks a definitively rejected request without reporting success", async () => {
    mocks.send.mockRejectedValue({ code: 4001 });
    await review();
    await click("Send 0.001");
    expect(container.textContent).toContain("cancelled");
    expect(verifyNativeTransfer).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it("keeps an unknown request locked and restores it after remount", async () => {
    mocks.send.mockRejectedValue(new Error("timeout"));
    await review();
    await click("Send 0.001");
    expect(container.textContent).toContain("awaiting verification");
    expect(container.textContent).not.toContain("Review ETH transfer");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <NativeTransferForm
          wallet={wallet}
          refresh={refresh}
          blocked={false}
          onBusy={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain("awaiting verification");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    await type("ETH transaction hash", hash);
    await click("Check ETH confirmation");
    expect(container.textContent).toContain("Confirmed on Base");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("does not call a pending transaction successful", async () => {
    mocks.wait.mockRejectedValue(new Error("pending"));
    await review();
    await click("Send 0.001");
    expect(container.textContent).toContain("not yet verified");
    expect(container.textContent).not.toContain("Confirmed on Base");
    expect(localStorage.length).toBe(1);
  });
});
