"use client";
import { useRef, useState } from "react";
import type { Quote } from "@/lib/model";
import { errorMessage } from "../lib/errors";
import { mayCancelSwap } from "../lib/swap-recovery";

type Props = {
  plan: {
    status: string;
    step: number;
    issued?: boolean;
    nonce?: number;
    pendingHash?: string;
    payload: string;
  };
  pendingHash?: string;
  executing: boolean;
  onResume: () => Promise<string>;
  onCancel: () => Promise<string>;
  onRecover: (hash: string) => Promise<string>;
};

export function SwapRecovery({
  plan,
  pendingHash,
  executing,
  onResume,
  onCancel,
  onRecover,
}: Props) {
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const quote = JSON.parse(plan.payload) as Quote;
  const knownHash = pendingHash ?? plan.pendingHash;
  const submittedHash = knownHash ?? hash.trim();
  const canCancel = mayCancelSwap(plan) && !knownHash;
  const canResume =
    !knownHash &&
    (plan.issued === false ||
      (plan.issued === true && Number.isSafeInteger(plan.nonce)));
  async function run(action: () => Promise<string>) {
    if (lock.current || executing) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="panel swap-recovery"
      aria-label="Active swap recovery"
      aria-busy={busy || executing}
    >
      <h3>{executing ? "Swap in progress" : "Finish your active swap"}</h3>
      <p>
        {quote.amountIn} {quote.asset} → at least {quote.minimumOut} USDC · Step{" "}
        {plan.step + 1} of {quote.transactions.length}:{" "}
        {quote.transactions[plan.step]?.label}
      </p>
      {executing ? (
        <p role="status">
          Waiting for wallet approval or onchain confirmation…
        </p>
      ) : (
        <>
          <p>
            {knownHash
              ? "A transaction was submitted. Check its receipt before sending anything else."
              : canCancel
                ? "This step has not been issued. Resume the reviewed quote or cancel the remaining steps. Cancelling does not revoke an existing token approval."
                : "The wallet request may have been submitted. Recover its hash, or explicitly retry the same step and nonce while the quote remains valid."}
          </p>
          {knownHash ? (
            <a
              href={`https://basescan.org/tx/${knownHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View submitted transaction ↗
            </a>
          ) : (
            <label>
              Transaction hash, if submitted
              <input
                value={hash}
                onChange={(e) => setHash(e.target.value)}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <div className="recovery-actions">
            <button
              className="button"
              disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(submittedHash)}
              onClick={() => run(() => onRecover(submittedHash))}
            >
              Check receipt
            </button>
            {canResume && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => run(onResume)}
              >
                {plan.issued ? "Retry same nonce" : "Resume swap"}
              </button>
            )}
            {canCancel && (
              <button
                className="button"
                disabled={busy}
                onClick={() => run(onCancel)}
              >
                Cancel remaining steps
              </button>
            )}
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
