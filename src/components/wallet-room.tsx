"use client";
import { useCallback, useRef, useState } from "react";
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  useSendTransaction,
} from "@privy-io/react-auth";
import {
  ConvexProviderWithAuth,
  ConvexReactClient,
  useConvexAuth,
  useAction,
  useMutation,
  useQuery,
} from "convex/react";
import { base } from "viem/chains";
import { toHex, type Hex } from "viem";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Quote, Snapshot } from "@/lib/model";
import { Dashboard } from "./dashboard";
import { PaymentCenter } from "./payment-center";
import { Investigation } from "./investigation";
import { SwapRecovery } from "./swap-recovery";

const client = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
function usePrivyAuth() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const fetchAccessToken = useCallback(
    async () => await getAccessToken(),
    [getAccessToken],
  );
  return {
    isLoading: !ready,
    isAuthenticated: authenticated,
    fetchAccessToken,
  };
}
export default function WalletRoom() {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: { theme: "dark", accentColor: "#a8e6ca" },
        defaultChain: base,
        supportedChains: [base],
        embeddedWallets: {
          ethereum: { createOnLogin: "all-users" },
          showWalletUIs: true,
        },
      }}
    >
      <ConvexProviderWithAuth client={client} useAuth={usePrivyAuth}>
        <ConnectedRoom />
      </ConvexProviderWithAuth>
    </PrivyProvider>
  );
}
function ConnectedRoom() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { sendTransaction } = useSendTransaction();
  const [selected, setSelected] = useState("");
  const linked = wallets.filter((w) =>
    user?.linkedAccounts.some(
      (a) =>
        a.type === "wallet" &&
        a.address.toLowerCase() === w.address.toLowerCase(),
    ),
  );
  const wallet =
    linked.find((w) => w.address === selected) ??
    linked.find((w) => w.walletClientType === "privy") ??
    linked[0];
  const address = wallet?.address;
  const active =
    ready && walletsReady && authenticated && isAuthenticated && !!address;
  const refresh = useAction(api.room.refresh),
    quote = useAction(api.room.quote),
    ask = useAction(api.room.ask);
  const funding = useAction(api.room.funding);
  const prepare = useAction(api.room.prepareStep),
    confirm = useAction(api.room.confirmStep);
  const claim = useMutation(api.state.claim),
    submitted = useMutation(api.state.submitted),
    cancelSwap = useMutation(api.state.cancelSwap);
  const activeSwap = useQuery(
    api.state.activeSwap,
    active ? { wallet: address } : "skip",
  );
  const executingRef = useRef(false);
  const [executing, setExecuting] = useState(false);
  const saved = useQuery(
    api.state.latest,
    active ? { wallet: address } : "skip",
  );
  const pending = useQuery(
    api.state.pending,
    active ? { wallet: address } : "skip",
  );
  const [localPending, setLocalPending] = useState<{
    id: Id<"plans">;
    index: number;
    hash: string;
    wallet: string;
  } | null>(null);
  const recovery =
    localPending?.wallet === address ? localPending : pending?.[0];
  async function verifyPending() {
    if (!recovery) throw new Error("No pending transaction.");
    const { id, index, hash } = recovery;
    const result = await confirm({ id, index, hash });
    setLocalPending(null);
    if (result.reverted)
      return "Transaction reverted. No remaining swap steps will run. Request a fresh quote.";
    return result.complete
      ? hash
      : "Approval confirmed. Resume the remaining swap or cancel the unissued steps.";
  }
  async function execute(q: Quote, start = 0, resume = false, retry = false) {
    if (!wallet || !active || !q.planId || q.source !== "live")
      throw new Error("Sign in and request a live quote first.");
    if (recovery)
      throw new Error(
        "Verify your pending transaction before submitting another exit.",
      );
    if (executingRef.current)
      throw new Error("A wallet operation is already running.");
    executingRef.current = true;
    setExecuting(true);
    try {
      const id = q.planId as Id<"plans">;
      await wallet.switchChain(base.id);
      if (!resume) await claim({ id });
      let lastHash = "";
      for (let index = start; index < q.transactions.length; index++) {
        const tx = await prepare({
          id,
          index,
          retry: retry && index === start,
        });
        try {
          if (wallet.walletClientType === "privy") {
            const result = await sendTransaction(
              {
                to: tx.to as Hex,
                data: tx.data as Hex,
                value: BigInt(tx.value),
                chainId: base.id,
                nonce: tx.nonce,
              },
              {
                address: wallet.address,
                uiOptions: {
                  showWalletUIs: true,
                  description: `${tx.label}. Base mainnet. USDC is sent only to your wallet.`,
                  isCancellable: true,
                },
              },
            );
            lastHash = result.hash;
          } else {
            const provider = await wallet.getEthereumProvider();
            lastHash = (await provider.request({
              method: "eth_sendTransaction",
              params: [
                {
                  from: wallet.address,
                  to: tx.to,
                  data: tx.data,
                  value: toHex(BigInt(tx.value)),
                  chainId: toHex(base.id),
                  nonce: toHex(tx.nonce),
                },
              ],
            })) as string;
          }
        } catch {
          throw new Error(
            "Wallet request was rejected or its result is unknown. Check your wallet activity before requesting another quote; this plan will not be resent.",
          );
        }
        setLocalPending({ id, index, hash: lastHash, wallet: address! });
        let result;
        try {
          await submitted({ id, index, hash: lastHash });
          result = await confirm({ id, index, hash: lastHash });
        } catch {
          throw new Error(
            `Transaction submitted: ${lastHash}. Confirmation is not yet verified. Use Check confirmation; do not send again.`,
          );
        }
        setLocalPending(null);
        if (result.reverted)
          throw new Error(
            "Transaction reverted. Remaining swap steps were stopped. Request a fresh quote.",
          );
      }
      return lastHash;
    } finally {
      executingRef.current = false;
      setExecuting(false);
    }
  }
  return (
    <Dashboard
      swapRecovery={
        activeSwap && (
          <SwapRecovery
            key={activeSwap._id}
            plan={activeSwap}
            pendingHash={recovery?.hash}
            executing={executing}
            onResume={async () => {
              const q = JSON.parse(activeSwap.payload) as Quote;
              const hash = await execute(
                { ...q, planId: activeSwap._id },
                activeSwap.step,
                true,
                activeSwap.issued === true,
              );
              await refresh({ wallet: address! });
              return `Swap confirmed: ${hash}`;
            }}
            onCancel={async () => {
              await cancelSwap({ id: activeSwap._id });
              return "Remaining swap cancelled. Existing token approvals are unchanged.";
            }}
            onRecover={async (hash) => {
              const result = await confirm({
                id: activeSwap._id,
                index: activeSwap.step,
                hash,
              });
              setLocalPending(null);
              await refresh({ wallet: address! });
              return result.reverted
                ? "Transaction reverted; the swap has stopped."
                : result.complete
                  ? `Swap confirmed: ${hash}`
                  : "Approval confirmed. Resume or cancel the remaining step.";
            }}
          />
        )
      }
      investigation={
        active
          ? (snapshot) => (
              <Investigation
                key={address}
                wallet={address!}
                snapshot={snapshot}
              />
            )
          : undefined
      }
      paymentControl={
        active && wallet ? (
          <PaymentCenter
            key={wallet.address}
            wallet={wallet}
            refresh={() => refresh({ wallet: address! })}
          />
        ) : undefined
      }
      key={`${user?.id ?? "guest"}:${address ?? "none"}`}
      savedSnapshot={
        saved ? (JSON.parse(saved.payload) as Snapshot) : undefined
      }
      actions={{
        connected: active,
        ready: ready && (!authenticated || (walletsReady && !isLoading)),
        wallet: address,
        wallets: linked.map((w) => ({
          address: w.address,
          label:
            w.walletClientType === "privy"
              ? "Embedded wallet"
              : "Connected wallet",
        })),
        selectWallet: setSelected,
        connect: login,
        disconnect: logout,
        refresh: () => refresh({ wallet: address! }),
        quote: (asset, amount) => quote({ wallet: address!, asset, amount }),
        ask: (question) => ask({ wallet: address!, question }),
        funding: (target) => funding({ wallet: address!, target }),
        execute,
        pendingHash: recovery?.hash,
        verifyPending,
      }}
    />
  );
}
