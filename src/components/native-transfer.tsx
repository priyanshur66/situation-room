"use client";
import { useRef, useState } from "react";
import { useSendTransaction, type ConnectedWallet } from "@privy-io/react-auth";
import { formatEther, toHex, type Hex } from "viem";
import { base } from "viem/chains";
import { errorMessage } from "../lib/errors";
import {
  isWalletRejection,
  nativeTransferClient,
  prepareNativeTransfer,
  verifyNativeTransfer,
  type NativeTransfer,
} from "../lib/native-transfer";

export function NativeTransferForm({
  wallet,
  refresh,
  blocked,
  onBusy,
}: {
  wallet: ConnectedWallet;
  refresh: () => Promise<unknown>;
  blocked: boolean;
  onBusy: (message: string) => void;
}) {
  const { sendTransaction } = useSendTransaction();
  const storageKey = `native-payment:8453:${wallet.address.toLowerCase()}`;
  const [recovery] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return {
        pending: saved ? (JSON.parse(saved) as NativeTransfer) : null,
        ready: true,
        error: "",
      };
    } catch {
      return {
        pending: null,
        ready: false,
        error: "Enable browser storage to safely track pending ETH transfers.",
      };
    }
  });
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState<NativeTransfer | null>(null);
  const [pending, setPending] = useState<NativeTransfer | null>(
    recovery.pending,
  );
  const [recoveryHash, setRecoveryHash] = useState("");
  const [receipt, setReceipt] = useState<Hex | null>(null);
  const [error, setError] = useState(recovery.error);
  const [notice, setNotice] = useState("");
  const ready = recovery.ready;
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  function persist(value: NativeTransfer | null) {
    if (value) localStorage.setItem(storageKey, JSON.stringify(value));
    else localStorage.removeItem(storageKey);
    setPending(value);
  }
  async function run(label: string, task: () => Promise<void>) {
    if (running.current || blocked || !ready) return;
    running.current = true;
    setBusy(true);
    onBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      running.current = false;
      setBusy(false);
      onBusy("");
    }
  }
  async function client() {
    await wallet.switchChain(base.id);
    return nativeTransferClient(await wallet.getEthereumProvider());
  }
  async function check(transfer: NativeTransfer, hash: Hex) {
    const ok = await verifyNativeTransfer(await client(), transfer, hash);
    persist(null);
    setReview(null);
    setReceipt(hash);
    setNotice(
      ok
        ? `Sent ${formatEther(BigInt(transfer.value))} ETH. Confirmed on Base.`
        : "Transaction reverted. ETH was not transferred; a network fee may have been charged.",
    );
    try {
      await refresh();
    } catch {
      setError("Refresh wallet analysis to load the updated balance.");
    }
  }
  async function send() {
    if (!review || pending) return;
    const rpc = await client();
    const fresh = await prepareNativeTransfer(
      rpc,
      wallet.address,
      review.to,
      formatEther(BigInt(review.value)),
    );
    if (
      fresh.nonce !== review.nonce ||
      BigInt(fresh.feeReserve) / 2n > BigInt(review.feeReserve)
    ) {
      setReview(fresh);
      setNotice(
        "Wallet activity or fees changed. Review the updated details before confirming again.",
      );
      return;
    }
    // Persist before opening the wallet; a lost response must never cause an automatic resend.
    persist(fresh);
    let hash: Hex;
    try {
      if (wallet.walletClientType === "privy") {
        hash = (
          await sendTransaction(
            {
              to: fresh.to,
              value: BigInt(fresh.value),
              data: "0x",
              chainId: base.id,
              nonce: fresh.nonce,
            },
            {
              address: wallet.address,
              uiOptions: {
                showWalletUIs: true,
                isCancellable: true,
                description: `Send ${formatEther(BigInt(fresh.value))} ETH to ${fresh.to} on Base.`,
              },
            },
          )
        ).hash as Hex;
      } else {
        hash = (await (
          await wallet.getEthereumProvider()
        ).request({
          method: "eth_sendTransaction",
          params: [
            {
              from: fresh.from,
              to: fresh.to,
              value: toHex(BigInt(fresh.value)),
              data: "0x",
              chainId: toHex(base.id),
              nonce: toHex(fresh.nonce),
            },
          ],
        })) as Hex;
      }
    } catch (e) {
      if (isWalletRejection(e)) {
        persist(null);
        throw new Error(
          "Transfer cancelled in your wallet. No new transfer was requested.",
        );
      }
      throw new Error(
        "Wallet result unknown. Check wallet activity and verify its transaction hash below. Do not send again.",
      );
    }
    setPending({ ...fresh, hash });
    setRecoveryHash(hash);
    persist({ ...fresh, hash });
    onBusy("Confirming ETH transfer on Base…");
    try {
      await rpc.waitForTransactionReceipt({ hash, timeout: 45_000 });
      await check(fresh, hash);
    } catch {
      setNotice(
        "Transfer submitted. Confirmation is not yet verified; check below before sending again.",
      );
    }
  }
  const disabled = blocked || busy || !ready;
  return (
    <div className="payment-stack">
      <p>
        Send ETH directly on Base. No swap or liquidation permission needed.
        Network fees are paid in ETH.
      </p>
      {blocked && !busy && (
        <p className="payment-notice">
          Finish the active payment before sending ETH.
        </p>
      )}
      {error && (
        <p role="alert" className="payment-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="payment-notice">
          {notice}
        </p>
      )}
      {receipt && (
        <a
          href={`https://basescan.org/tx/${receipt}`}
          target="_blank"
          rel="noreferrer"
        >
          View transaction ↗
        </a>
      )}
      {!pending && (
        <>
          <label>
            Recipient address on Base
            <input
              aria-label="ETH recipient"
              value={recipient}
              disabled={disabled}
              autoComplete="off"
              placeholder="0x…"
              onChange={(e) => {
                setRecipient(e.target.value);
                setReview(null);
              }}
            />
          </label>
          <label>
            Amount · ETH
            <input
              aria-label="ETH amount"
              inputMode="decimal"
              value={amount}
              disabled={disabled}
              placeholder="0.001"
              onChange={(e) => {
                setAmount(e.target.value);
                setReview(null);
              }}
            />
          </label>
          <button
            className="button"
            disabled={disabled || !recipient || !amount}
            onClick={() =>
              run("Checking ETH balance and network fees…", async () => {
                setReceipt(null);
                setReview(
                  await prepareNativeTransfer(
                    await client(),
                    wallet.address,
                    recipient,
                    amount,
                  ),
                );
              })
            }
          >
            Review ETH transfer
          </button>
          {review && (
            <section className="payment-preview">
              <h3>Recipient gets {formatEther(BigInt(review.value))} ETH</h3>
              <p style={{ overflowWrap: "anywhere" }}>{review.to}</p>
              <p>Network: Base mainnet</p>
              <p>Balance: {formatEther(BigInt(review.balance))} ETH</p>
              <p>
                Network fee reserve: {formatEther(BigInt(review.feeReserve))}{" "}
                ETH
              </p>
              <p className="disclaimer">
                Includes a buffer over estimated network fees. Your wallet shows
                the final fee. Confirm that the recipient accepts ETH on Base;
                this is not Ethereum mainnet.
              </p>
              <button
                className="button primary"
                disabled={disabled}
                onClick={() =>
                  run("Confirm ETH transfer in your wallet…", send)
                }
              >
                Send {formatEther(BigInt(review.value))} ETH
              </button>
            </section>
          )}
        </>
      )}
      {pending && (
        <section className="payment-preview">
          <h3>ETH transfer awaiting verification</h3>
          <p style={{ overflowWrap: "anywhere" }}>
            {formatEther(BigInt(pending.value))} ETH → {pending.to}
          </p>
          <p>
            No automatic resend. Check your wallet activity if no hash was
            returned.
          </p>
          <input
            aria-label="ETH transaction hash"
            placeholder="0x transaction hash"
            disabled={disabled}
            value={recoveryHash || pending.hash || ""}
            onChange={(e) => setRecoveryHash(e.target.value)}
          />
          <button
            className="button"
            disabled={disabled || !(recoveryHash || pending.hash)}
            onClick={() =>
              run("Verifying ETH transfer…", () =>
                check(pending, (recoveryHash || pending.hash) as Hex),
              )
            }
          >
            Check ETH confirmation
          </button>
        </section>
      )}
    </div>
  );
}
