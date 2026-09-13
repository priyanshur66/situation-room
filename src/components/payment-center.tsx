"use client";
import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  useSendTransaction,
  useSignMessage,
  useSigners,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { CreditCard, LoaderCircle, Send, ShieldCheck, X } from "lucide-react";
import { toHex, type Hex } from "viem";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  defaultPolicy,
  type LiquidationPolicy,
  type PaymentPreview,
} from "@/lib/policy";
import { money, shortAddress } from "@/lib/model";
import { errorMessage } from "@/lib/errors";

export function PaymentCenter({
  wallet,
  refresh,
}: {
  wallet: ConnectedWallet;
  refresh: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState<"wallet" | "card" | "policy">("wallet");
  const [instruction, setInstruction] = useState(""),
    [draft, setDraft] = useState<LiquidationPolicy | null>(null);
  const [amount, setAmount] = useState(""),
    [recipient, setRecipient] = useState("");
  const [plan, setPlan] = useState<
    (PaymentPreview & { id: Id<"payments"> }) | null
  >(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [recoveryHash, setRecoveryHash] = useState("");
  const [delegated, setDelegated] = useState(false),
    [authorizedId, setAuthorizedId] = useState<string | null>(null);
  const [cardName, setCardName] = useState(""),
    [cardConfigured, setCardConfigured] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const [today] = useState(() => Math.floor(Date.now() / 86400000) * 86400000);
  const { sendTransaction } = useSendTransaction(),
    { signMessage } = useSignMessage();
  const { addSigners, removeSigners } = useSigners();
  const permission = useAction(api.delegation.permission),
    permissionStatus = useAction(api.delegation.status),
    delegatedSend = useAction(api.delegation.sendStep);
  const resumeBackground = useMutation(api.paymentWorkerState.resume);
  const pref = useQuery(api.paymentState.preferences, {
    wallet: wallet.address,
  });
  const history = useQuery(api.paymentState.history, {
    wallet: wallet.address,
  });
  const interpret = useAction(api.payments.interpret),
    challenge = useAction(api.payments.challenge),
    save = useAction(api.payments.save);
  const preview = useAction(api.payments.preview),
    prepare = useAction(api.payments.prepare),
    confirm = useAction(api.payments.confirm);
  const claim = useMutation(api.paymentState.claim),
    submitted = useMutation(api.paymentState.submitted),
    cancel = useMutation(api.paymentState.cancel);
  const current = pref ? (JSON.parse(pref.payload) as LiquidationPolicy) : null;
  const edit = draft ?? current ?? defaultPolicy;
  const active = history?.find((p) => p.status === "active");
  const watchedPayments = useRef(new Set<string>());
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    for (const payment of history ?? []) {
      if (payment.background && payment.status === "active")
        watchedPayments.current.add(payment._id);
      if (
        payment.status === "confirmed" &&
        watchedPayments.current.delete(payment._id)
      ) {
        setNotice(
          `Paid ${payment.amount} USDC. Recipient transfer verified on Base.`,
        );
        void refreshRef
          .current()
          .catch(() =>
            setError(
              "Payment confirmed. Refresh wallet analysis to load the new balances.",
            ),
          );
      }
    }
  }, [history]);
  const spent =
    history
      ?.filter(
        (p) =>
          ["active", "confirmed"].includes(p.status) &&
          (p.startedAt ?? 0) >= today,
      )
      .reduce((sum, p) => sum + Number(p.amount), 0) ?? 0;
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement as HTMLElement | null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) setOpen(false);
      if (e.key !== "Tab") return;
      const nodes = dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input, textarea, select, a[href]",
      );
      if (!nodes?.length) return;
      if (e.shiftKey && document.activeElement === nodes[0]) {
        e.preventDefault();
        nodes[nodes.length - 1].focus();
      } else if (
        !e.shiftKey &&
        document.activeElement === nodes[nodes.length - 1]
      ) {
        e.preventDefault();
        nodes[0].focus();
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = priorOverflow;
      prior?.focus();
    };
  }, [open, busy]);
  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function savePolicy() {
    const c = await challenge({
      wallet: wallet.address,
      payload: JSON.stringify(edit),
    });
    let signature: string;
    if (wallet.walletClientType === "privy")
      signature = (
        await signMessage({ message: c.message }, { address: wallet.address })
      ).signature;
    else
      signature = (await (
        await wallet.getEthereumProvider()
      ).request({
        method: "personal_sign",
        params: [toHex(c.message), wallet.address],
      })) as string;
    await save({ id: c.id, signature });
    setDraft(null);
    setPlan(null);
    setTab("wallet");
    setNotice(
      "Preferences signed and saved. No spending permissions were granted.",
    );
  }
  async function execute(
    p: PaymentPreview & { id: Id<"payments"> },
    start = 0,
    resume = false,
    retry = false,
    useDelegation = false,
  ) {
    await wallet.switchChain(8453);
    if (useDelegation && !resume) {
      await claim({ id: p.id, background: true });
      watchedPayments.current.add(p.id);
      setPlan(null);
      setNotice(
        "Payment started in the background. You can close this dialog; progress and verified receipts are saved.",
      );
      return;
    }
    if (!resume) await claim({ id: p.id });
    for (let step = start; step < p.transactions.length; step++) {
      setBusy(p.transactions[step].label);
      const tx = p.transactions[step];
      let hash: string;
      try {
        if (useDelegation) {
          hash = (await delegatedSend({ id: p.id, step })).hash;
        } else {
          const prepared = await prepare({
            id: p.id,
            step,
            retry: retry && step === start,
          });
          if (wallet.walletClientType === "privy") {
            hash = (
              await sendTransaction(
                {
                  to: tx.to as Hex,
                  data: tx.data as Hex,
                  value: BigInt(tx.value),
                  chainId: 8453,
                  nonce: prepared.nonce,
                },
                {
                  address: wallet.address,
                  uiOptions: {
                    showWalletUIs: true,
                    description: tx.label,
                    isCancellable: true,
                  },
                },
              )
            ).hash;
          } else {
            hash = (await (
              await wallet.getEthereumProvider()
            ).request({
              method: "eth_sendTransaction",
              params: [
                {
                  from: wallet.address,
                  to: tx.to,
                  data: tx.data,
                  value: toHex(BigInt(tx.value)),
                  chainId: toHex(8453),
                  nonce: toHex(prepared.nonce),
                },
              ],
            })) as string;
          }
        }
      } catch {
        throw new Error(
          "Wallet request rejected or result unknown. This step is locked against automatic resends. Check wallet activity and enter its transaction hash below if it was sent.",
        );
      }
      setRecoveryHash(hash);
      try {
        localStorage.setItem(
          `payment:${wallet.address.toLowerCase()}:${p.id}:${step}`,
          hash,
        );
      } catch {
        /* Confirmation also persists on the server. */
      }
      await submitted({ id: p.id, step, hash });
      setBusy(`Confirming ${tx.kind} on Base…`);
      const result = await confirm({ id: p.id, step, hash });
      if (result.reverted)
        throw new Error(
          "Transaction reverted. Payment cancelled; prior completed swaps remain in your wallet.",
        );
      setRecoveryHash("");
      if (result.complete)
        setNotice(
          `Paid ${p.amount} USDC. Recipient transfer verified on Base.`,
        );
    }
    setPlan(null);
    await refresh();
  }
  return (
    <>
      <button className="button primary" onClick={() => setOpen(true)}>
        <Send size={16} /> Pay
      </button>
      {open && (
        <div className="payment-backdrop">
          <div
            ref={dialog}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="payment-title"
            className="payment-dialog"
          >
            <header>
              <div>
                <span className="eyebrow">BASE MAINNET · REAL FUNDS</span>
                <h2 id="payment-title">Pay from your portfolio</h2>
              </div>
              <button
                aria-label="Close payment dialog"
                disabled={!!busy}
                onClick={() => setOpen(false)}
              >
                <X />
              </button>
            </header>
            <div className="payment-tabs">
              {(
                [
                  ["wallet", "Pay to wallet"],
                  ["card", "Pay via card"],
                  ["policy", "Preferences"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={tab === id ? "active" : ""}
                  disabled={!!busy}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {busy && (
              <div role="status" className="payment-progress">
                <LoaderCircle className="spin" size={18} />
                {busy}
                <div className="analysis-track" />
              </div>
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
            {tab === "policy" && (
              <div className="payment-stack">
                <p>
                  Describe what can be sold. Review the exact rules before
                  signing. Unknown cost basis blocks profit/loss-dependent
                  sales.
                </p>
                <label>
                  Your instructions
                  <textarea
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="Protect WETH. Use ETH if needed. Limit payments to 5 USDC and 20 USDC a day."
                    maxLength={2000}
                  />
                </label>
                <button
                  className="button"
                  disabled={!!busy || !instruction.trim()}
                  onClick={() =>
                    run("Interpreting preferences…", async () =>
                      setDraft(
                        await interpret({
                          wallet: wallet.address,
                          instruction,
                        }),
                      ),
                    )
                  }
                >
                  Interpret with assistant
                </button>
                <label>
                  Protected assets (comma-separated symbols or addresses)
                  <input
                    value={edit.protectedAssets.join(", ")}
                    onChange={(e) =>
                      setDraft({
                        ...edit,
                        protectedAssets: e.target.value
                          .split(",")
                          .map((s) => s.trim().toUpperCase())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <div className="payment-fields">
                  <label>
                    Per payment · USDC
                    <input
                      inputMode="decimal"
                      value={edit.perPaymentUsdc}
                      onChange={(e) =>
                        setDraft({ ...edit, perPaymentUsdc: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Daily limit · USDC
                    <input
                      inputMode="decimal"
                      value={edit.dailyUsdc}
                      onChange={(e) =>
                        setDraft({ ...edit, dailyUsdc: e.target.value })
                      }
                    />
                  </label>
                </div>
                <label>
                  Liquidation order
                  <select
                    value={edit.order}
                    onChange={(e) =>
                      setDraft({
                        ...edit,
                        order: e.target.value as LiquidationPolicy["order"],
                      })
                    }
                  >
                    <option value="lowest-cost">
                      Liquidity / execution cost
                    </option>
                    <option value="highest-profit">
                      Highest profit first (requires cost basis)
                    </option>
                    <option value="smallest-loss">
                      Smallest loss first (requires cost basis)
                    </option>
                  </select>
                </label>
                <label className="payment-check">
                  <input
                    type="checkbox"
                    checked={edit.profitOnly}
                    onChange={(e) =>
                      setDraft({ ...edit, profitOnly: e.target.checked })
                    }
                  />
                  Only liquidate profitable assets
                </label>
                <label>
                  Maximum realized loss % (blank = no loss filter)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={edit.maxLossPct ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...edit,
                        maxLossPct:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
                {!!edit.unresolved.length && (
                  <div role="alert" className="payment-error">
                    Needs clarification: {edit.unresolved.join(" ")} Edit your
                    instruction and interpret again.
                  </div>
                )}
                <button
                  className="button primary"
                  disabled={!!busy || !!edit.unresolved.length}
                  onClick={() =>
                    run("Review and sign preferences…", savePolicy)
                  }
                >
                  <ShieldCheck size={16} />
                  Sign & save preferences
                </button>
              </div>
            )}
            {tab === "card" && (
              <div className="payment-stack">
                <CreditCard size={32} />
                <h3>Card payment preview</h3>
                <p>
                  Demo only. No card is issued or charged. Do not enter card
                  numbers or security codes.
                </p>
                <label>
                  Card nickname
                  <input
                    value={cardName}
                    onChange={(e) => setCardName(e.target.value)}
                    placeholder="My demo card"
                    maxLength={40}
                  />
                </label>
                <button
                  className="button"
                  disabled={!cardName.trim()}
                  onClick={() => setCardConfigured(true)}
                >
                  Configure demo card
                </button>
                {cardConfigured && (
                  <div className="demo-card">
                    <span>DEMO · NOT A PAYMENT CARD</span>
                    <strong>{cardName}</strong>
                    <p>
                      Portfolio → eligible liquidations → USDC → card settlement
                    </p>
                    <small>
                      Use Pay to wallet for a real, verified payment.
                    </small>
                  </div>
                )}
              </div>
            )}
            {tab === "wallet" && (
              <div className="payment-stack">
                {!current ? (
                  <div className="payment-notice">
                    <p>First, choose what this wallet may liquidate.</p>
                    <button className="button" onClick={() => setTab("policy")}>
                      Set liquidation preferences
                    </button>
                  </div>
                ) : (
                  <div className="payment-capacity">
                    <ShieldCheck size={18} />
                    <span>
                      Approved limit {current.perPaymentUsdc} USDC / payment ·{" "}
                      {Math.max(0, Number(current.dailyUsdc) - spent).toFixed(
                        2,
                      )}{" "}
                      USDC remaining today
                      <br />
                      <small>
                        {authorizedId
                          ? "Restricted payment permission approved. Server checks limits and receipts at every step."
                          : "No delegated spending enabled. Preferences alone do not grant access."}
                      </small>
                    </span>
                  </div>
                )}
                <label>
                  Recipient Ethereum-compatible address on Base
                  <input
                    value={recipient}
                    onChange={(e) => {
                      setRecipient(e.target.value);
                      setPlan(null);
                    }}
                    placeholder="0x…"
                    autoComplete="off"
                  />
                </label>
                <label>
                  Payment amount · USDC
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setPlan(null);
                    }}
                    placeholder="5.00"
                  />
                </label>
                {wallet.walletClientType === "privy" && (
                  <>
                    <label className="payment-check">
                      <input
                        type="checkbox"
                        checked={delegated}
                        disabled={!!busy || !!active}
                        onChange={(e) => {
                          setDelegated(e.target.checked);
                          setPlan(null);
                          setAuthorizedId(null);
                        }}
                      />
                      Authorize Privy to execute this reviewed payment
                    </label>
                    <p className="disclaimer">
                      Optional, time-limited permission for exact swap inputs,
                      approvals and recipient amount. The server enforces the
                      payment budget. This is not a recurring spending
                      allowance; signed calls remain possible until permission
                      expiry. Revoke after use.
                    </p>
                    <button
                      className="button"
                      disabled={!!busy}
                      onClick={() =>
                        run("Removing additional wallet signers…", async () => {
                          await removeSigners({ address: wallet.address });
                          setAuthorizedId(null);
                          setNotice(
                            "All additional signers removed from this wallet. Already broadcast transactions cannot be cancelled by revocation.",
                          );
                        })
                      }
                    >
                      Revoke all additional wallet signers
                    </button>
                  </>
                )}
                <button
                  className="button"
                  disabled={
                    !!busy || !current || !!active || !amount || !recipient
                  }
                  onClick={() =>
                    run(
                      "Reading balances and building liquidation queue…",
                      async () => {
                        await refresh();
                        setPlan(
                          await preview({
                            wallet: wallet.address,
                            recipient,
                            amount,
                            delegated,
                          }),
                        );
                      },
                    )
                  }
                >
                  Preview liquidation & payment
                </button>
                {plan && (
                  <section className="payment-preview">
                    <h3>Recipient gets {plan.amount} USDC</h3>
                    <p>{shortAddress(plan.recipient)} · Base</p>
                    <div className="payment-fields">
                      <span>
                        Existing USDC
                        <br />
                        <strong>{plan.existingUsdc}</strong>
                      </span>
                      <span>
                        Gas reserve estimate
                        <br />
                        <strong>{money(plan.gasBudgetUsd)}</strong>
                      </span>
                    </div>
                    {!!plan.comparison?.length && (
                      <details>
                        <summary>Why this liquidation sequence?</summary>
                        <p className="disclaimer">
                          Lowest estimated swap loss plus gas among the feasible
                          supported sequences. The final transfer gas is
                          reserved separately. This is not a market-wide
                          best-price guarantee.
                        </p>
                        {plan.comparison.map((option, i) => (
                          <p key={i}>
                            {i === 0 ? "Selected: " : "Alternative: "}
                            {option.assets.join(" → ") || "Use existing USDC"} ·
                            estimated cost {money(option.estimatedCostUsd)}
                          </p>
                        ))}
                      </details>
                    )}
                    <ol>
                      {plan.transactions.map((t, i) => (
                        <li key={i}>
                          <span>{i + 1}</span>
                          {t.label}
                        </li>
                      ))}
                    </ol>
                    {plan.excluded.map((s) => (
                      <p key={s} className="disclaimer">
                        {s}
                      </p>
                    ))}
                    <p className="disclaimer">
                      Sequential transactions, not atomic. A completed swap
                      cannot be undone if a later step fails. Excess USDC stays
                      in your wallet. Quotes expire; no future price is
                      guaranteed.
                    </p>
                    <button
                      className="button primary"
                      disabled={!!busy || !!active}
                      onClick={() =>
                        run("Starting payment…", async () => {
                          if (
                            delegated &&
                            !(await permissionStatus({ id: plan.id }))
                              .authorized
                          )
                            throw new Error(
                              "Authorize this payment's restricted permission first.",
                            );
                          await execute(plan, 0, false, false, delegated);
                        })
                      }
                    >
                      Pay {plan.amount} USDC
                    </button>
                    {delegated && (
                      <button
                        className="button"
                        disabled={!!busy || !!active}
                        onClick={() =>
                          run(
                            "Review restricted payment permission…",
                            async () => {
                              const grant = await permission({ id: plan.id });
                              await addSigners({
                                address: wallet.address,
                                signers: [
                                  {
                                    signerId: grant.signerId,
                                    policyIds: [grant.policyId],
                                  },
                                ],
                              });
                              const result = await permissionStatus({
                                id: plan.id,
                              });
                              if (!result.authorized)
                                throw new Error(
                                  "Privy has not confirmed this restricted permission.",
                                );
                              setAuthorizedId(plan.id);
                              setNotice(
                                `Permission verified for this ${plan.amount} USDC payment. Expires ${new Date(grant.expiresAt).toLocaleTimeString()}.`,
                              );
                            },
                          )
                        }
                      >
                        Review & authorize payment execution
                      </button>
                    )}
                  </section>
                )}
                {active && (
                  <section className="payment-preview">
                    <h3>Payment in progress · step {active.step + 1}</h3>
                    <p>
                      {
                        (JSON.parse(active.payload) as PaymentPreview)
                          .transactions[active.step]?.label
                      }
                    </p>
                    {active.background && (
                      <div role="status" aria-live="polite">
                        {active.workerState === "attention" ? (
                          <>
                            <p>{active.workerMessage}</p>
                            {(!active.issued || active.pendingHash) && (
                              <button
                                className="button primary"
                                disabled={!!busy}
                                onClick={() =>
                                  run(
                                    "Resuming background payment…",
                                    async () => {
                                      await resumeBackground({
                                        id: active._id,
                                      });
                                    },
                                  )
                                }
                              >
                                Resume background payment
                              </button>
                            )}
                          </>
                        ) : (
                          <p>
                            <LoaderCircle size={16} className="spin" />{" "}
                            Processing on the server. You may close this dialog
                            or return later.
                          </p>
                        )}
                        {!active.issued && (
                          <button
                            className="button"
                            disabled={!!busy}
                            onClick={() =>
                              run("Stopping remaining steps…", async () => {
                                await cancel({ id: active._id });
                                setNotice(
                                  "Remaining steps stopped. Completed swaps cannot be undone.",
                                );
                              })
                            }
                          >
                            Stop remaining steps
                          </button>
                        )}
                        {active.pendingHash && (
                          <p>
                            <a
                              href={`https://basescan.org/tx/${active.pendingHash}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Pending transaction ↗
                            </a>
                          </p>
                        )}
                      </div>
                    )}
                    {active.issued &&
                    (!active.background ||
                      active.workerState === "attention") ? (
                      <>
                        <p>
                          Check this transaction before continuing. Never resend
                          an unknown transaction.
                        </p>
                        {!active.pendingHash && !active.background && (
                          <button
                            className="button"
                            disabled={!!busy}
                            onClick={() =>
                              run("Retrying the same reserved nonce…", () =>
                                execute(
                                  {
                                    ...JSON.parse(active.payload),
                                    id: active._id,
                                  },
                                  active.step,
                                  true,
                                  true,
                                  !!active.delegationPolicyId,
                                ),
                              )
                            }
                          >
                            Retry rejected request · same nonce
                          </button>
                        )}
                        <input
                          aria-label="Transaction hash to recover"
                          value={recoveryHash || active.pendingHash || ""}
                          onChange={(e) => setRecoveryHash(e.target.value)}
                          placeholder="0x transaction hash from wallet activity"
                        />
                        <button
                          className="button"
                          disabled={!!busy}
                          onClick={() =>
                            run("Verifying transaction…", async () => {
                              const hash =
                                recoveryHash ||
                                active.pendingHash ||
                                localStorage.getItem(
                                  `payment:${wallet.address.toLowerCase()}:${active._id}:${active.step}`,
                                ) ||
                                "";
                              const r = await confirm({
                                id: active._id,
                                step: active.step,
                                hash,
                              });
                              setRecoveryHash("");
                              setNotice(
                                r.complete
                                  ? "Recipient payment verified."
                                  : r.reverted
                                    ? "Transaction reverted; payment stopped."
                                    : "Step confirmed. Continue the remaining steps.",
                              );
                              await refresh();
                            })
                          }
                        >
                          Check confirmation
                        </button>
                      </>
                    ) : !active.background ? (
                      <>
                        <button
                          className="button primary"
                          disabled={!!busy}
                          onClick={() =>
                            run("Continuing payment…", () =>
                              execute(
                                {
                                  ...JSON.parse(active.payload),
                                  id: active._id,
                                },
                                active.step,
                                true,
                                false,
                                !!active.delegationPolicyId,
                              ),
                            )
                          }
                        >
                          Continue payment
                        </button>
                        <button
                          className="button"
                          disabled={!!busy}
                          onClick={() =>
                            run("Cancelling remaining steps…", async () => {
                              await cancel({ id: active._id });
                              setPlan(null);
                              setNotice(
                                "Remaining steps cancelled. Prior completed swaps stay in your wallet.",
                              );
                            })
                          }
                        >
                          Cancel remaining steps
                        </button>
                      </>
                    ) : null}
                  </section>
                )}
                {!!history?.some((p) => p.status === "confirmed") && (
                  <section>
                    <h3>Verified payments</h3>
                    {history
                      .filter((p) => p.status === "confirmed")
                      .slice(0, 5)
                      .map((p) => (
                        <p key={p._id}>
                          {p.amount} USDC →{" "}
                          {shortAddress(
                            (JSON.parse(p.payload) as PaymentPreview).recipient,
                          )}{" "}
                          <a
                            href={`https://basescan.org/tx/${p.hashes.at(-1)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Receipt ↗
                          </a>
                        </p>
                      ))}
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
