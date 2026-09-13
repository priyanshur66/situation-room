"use client";
import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronRight,
  Command,
  CreditCard,
  Database,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  analyze,
  money,
  shortAddress,
  type Snapshot,
  type Quote,
  type FundingPlan,
} from "../lib/model";
import { errorMessage } from "../lib/errors";
export type DashboardActions = {
  connected: boolean;
  ready: boolean;
  wallet?: string;
  wallets: { address: string; label: string }[];
  selectWallet: (address: string) => void;
  pendingHash?: string;
  verifyPending: () => Promise<string>;
  connect: () => void;
  disconnect: () => void;
  refresh: () => Promise<Snapshot>;
  quote: (asset: "ETH" | "WETH", amount: string) => Promise<Quote>;
  execute: (q: Quote) => Promise<string>;
  ask: (question: string) => Promise<string>;
  funding: (target: string) => Promise<FundingPlan>;
};

type DashboardProps = {
  actions?: DashboardActions;
  savedSnapshot?: Snapshot;
  unavailableReason?: string;
};

export function Dashboard(props: DashboardProps) {
  const { actions } = props;
  const connection =
    actions?.ready && actions.connected
      ? actions.wallet?.toLowerCase()
      : undefined;
  return <WalletDashboard key={connection ?? "disconnected"} {...props} />;
}

function AnalysisLoading({ compact = false }: { compact?: boolean }) {
  return (
    <section
      className={`panel analysis-loading ${compact ? "analysis-compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="analysis-orbit" aria-hidden="true">
        <Wallet size={28} />
      </div>
      <div className="analysis-copy">
        <h2>
          {compact ? "Refreshing your wallet…" : "Analyzing your wallet…"}
        </h2>
        <p>Reading Base balances and indexed evidence from The Graph.</p>
        {compact ? (
          <p>Showing your previous snapshot until fresh data arrives.</p>
        ) : (
          <>
            <div className="analysis-sources" aria-hidden="true">
              <span>Base balances</span>
              <span>Market history</span>
              <span>Exposure analysis</span>
            </div>
            <div className="analysis-track" aria-hidden="true" />
            <p className="disclaimer">
              Only verified data will appear. No wallet signature is needed.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function WalletDashboard({
  actions,
  savedSnapshot,
  unavailableReason,
}: DashboardProps) {
  const canAnalyze = !!(actions?.ready && actions.connected && actions.wallet);
  const [localSnapshot, setSnapshot] = useState<Snapshot | null>(null),
    [section, setSection] = useState("Overview"),
    [days, setDays] = useState(14);
  const [asset, setAsset] = useState<"ETH" | "WETH">("ETH"),
    [amount, setAmount] = useState(""),
    [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(canAnalyze ? "refresh" : ""),
    [error, setError] = useState(""),
    [receipt, setReceipt] = useState(""),
    [question, setQuestion] = useState(""),
    [answer, setAnswer] = useState(""),
    [evidence, setEvidence] = useState(false);
  const snapshot = localSnapshot ?? savedSnapshot;
  const [target, setTarget] = useState(""),
    [fundingPlan, setFundingPlan] = useState<FundingPlan | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const modalRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (quote?.source !== "live") return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote]);
  useEffect(() => {
    if (!evidence || !modalRef.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const controls =
      modalRef.current.querySelectorAll<HTMLElement>("button, a[href]");
    const first = controls[0],
      last = controls[controls.length - 1];
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEvidence(false);
      if (event.key === "Tab") {
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
    };
  }, [evidence]);
  const quoteExpired = !!quote && clock >= quote.expiresAt;
  const live =
    snapshot?.mode === "live" &&
    actions?.connected &&
    snapshot.wallet.toLowerCase() === actions.wallet?.toLowerCase();
  const view = live ? snapshot : undefined,
    data = view ? analyze(view) : undefined,
    history = data?.history.slice(-days) ?? [],
    change = data && history.length ? data.total - history[0].value : 0;
  async function run(
    label: string,
    fn: () => Promise<void>,
    isCurrent = () => true,
  ) {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (isCurrent()) setError(errorMessage(e));
    } finally {
      if (isCurrent()) setBusy("");
    }
  }
  const refresh = (isCurrent = () => true) =>
    run(
      "refresh",
      async () => {
        if (actions) {
          const result = await actions.refresh();
          if (!isCurrent()) return;
          setSnapshot(result);
          setQuote(null);
          setFundingPlan(null);
          setAnswer("");
          setReceipt("");
        }
      },
      isCurrent,
    );
  const autoRefresh = useEffectEvent((isCurrent: () => boolean) =>
    refresh(isCurrent),
  );
  useEffect(() => {
    if (!canAnalyze) return;
    let current = true;
    // Defer one tick so Strict Mode's discarded setup never starts a request.
    const timer = setTimeout(() => {
      void autoRefresh(() => current);
    }, 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [canAnalyze]);
  const requestQuote = () =>
    run("quote", async () => {
      setReceipt("");
      setFundingPlan(null);
      if (live && actions) {
        setQuote(await actions.quote(asset, amount));
        return;
      }
      throw new Error(
        "Connect and analyze your wallet before requesting a quote.",
      );
    });
  const nav = [
    { label: "Overview", id: "overview", icon: Command },
    { label: "Exposure", id: "exposure", icon: GitBranch },
    { label: "Exit planner", id: "exit", icon: ArrowUpRight },
    { label: "Assistant", id: "assistant", icon: Activity },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-icon">
            <Command size={22} />
          </span>
          <span>
            Situation
            <br />
            <b>Room</b>
          </span>
        </Link>
        <div className="workspace-label">YOUR COMMAND CENTER</div>
        <nav>
          {nav.map(({ label, id, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${section === label ? "active" : ""}`}
              onClick={() => {
                setSection(label);
                document
                  .getElementById(id)
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <Icon size={18} />
              {label}
              {section === label && <span className="dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="network">
            <span className="base-icon" />
            Base mainnet
            <span className="dot" />
          </div>
          <p className="network-roadmap">More chains · Coming soon</p>
          <button disabled={!live} onClick={() => setEvidence(true)}>
            Data & methodology ↗
          </button>
          <div className="powered">
            <Database size={14} /> Indexed by The Graph
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <span>Situation overview</span>
          </div>
          <div className="topbar-actions">
            <span className={`status-pill ${live ? "green" : "amber"}`}>
              <span className="dot" />
              {live ? "WALLET SNAPSHOT" : "NO WALLET DATA"}
            </span>
            <button
              className="button"
              title={actions?.connected ? "Sign out" : "Connect wallet"}
              disabled={!!busy || !actions?.ready}
              onClick={() =>
                actions
                  ? actions.connected
                    ? actions.disconnect()
                    : actions.connect()
                  : setError("Wallet connection is unavailable.")
              }
            >
              <Wallet size={16} />
              {actions?.connected && actions.wallet
                ? shortAddress(actions.wallet)
                : "Connect wallet"}
            </button>
          </div>
        </header>
        <main id="overview">
          {actions?.connected && (
            <div className="wallet-selection">
              <label htmlFor="active-wallet">Active wallet</label>
              <select
                id="active-wallet"
                value={actions.wallet}
                onChange={(e) => actions.selectWallet(e.target.value)}
                disabled={!!busy}
              >
                {actions.wallets.map((w) => (
                  <option key={w.address} value={w.address}>
                    {w.label} · {shortAddress(w.address)}
                  </option>
                ))}
              </select>
              <button
                className="text-button"
                onClick={() => navigator.clipboard.writeText(actions.wallet!)}
              >
                Copy address
              </button>
              <span>Base ETH / WETH / USDC only</span>
            </div>
          )}
          {actions?.pendingHash && (
            <div className="status-banner" role="status">
              <span>
                Transaction submitted. Verify its receipt before sending again.
              </span>
              <a
                href={`https://basescan.org/tx/${actions.pendingHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction ↗
              </a>
              <button
                disabled={!!busy}
                onClick={() =>
                  run("verify", async () => {
                    const result = await actions.verifyPending();
                    if (result.startsWith("0x")) setReceipt(result);
                    else setError(result);
                    setQuote(null);
                  })
                }
              >
                {busy === "verify" ? "Checking…" : "Check confirmation"}
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <h1>Your positions</h1>
            </div>
            <button
              className="button"
              disabled={!!busy || !actions?.connected}
              onClick={() => refresh()}
            >
              <RefreshCw
                size={15}
                className={busy === "refresh" ? "spin" : ""}
              />
              {busy === "refresh"
                ? "Analyzing…"
                : error
                  ? "Retry analysis"
                  : "Refresh wallet"}
            </button>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={17} />
              </button>
            </div>
          )}
          {busy === "refresh" && <AnalysisLoading compact={!!view} />}
          {!view && busy !== "refresh" && (
            <section className="panel empty-wallet" role="status">
              <Wallet size={32} />
              <h2>
                {unavailableReason
                  ? "Wallet connection unavailable"
                  : !actions?.ready
                    ? "Loading wallet connection…"
                    : actions.connected
                      ? "Wallet analysis could not be completed"
                      : "Connect your wallet to begin"}
              </h2>
              <p>
                {unavailableReason ??
                  "Base balances. Prices and history from The Graph."}
              </p>
              <button
                className="button primary"
                disabled={!!busy || !actions?.ready}
                onClick={() =>
                  actions?.connected ? refresh() : actions?.connect()
                }
              >
                {actions?.connected ? "Retry analysis" : "Connect wallet"}
              </button>
              <p className="disclaimer">
                ETH, WETH and USDC on Base only.
              </p>
            </section>
          )}
          {view && data && (
            <>
              <section className="stats-grid" aria-label="Portfolio summary">
                {[
                  {
                    label: "Supported portfolio value",
                    value: money(data.total),
                    note: `${view.holdings.filter((h) => Number(h.units) > 0).length} held assets · Base only`,
                    icon: Wallet,
                  },
                  {
                    label: "ETH price exposure",
                    value: `${data.concentration.toFixed(1)}%`,
                    note:
                      data.concentration > 60
                        ? "Concentrated underlying exposure"
                        : "ETH + WETH combined",
                    icon: GitBranch,
                  },
                  {
                    label: "Ready in USDC",
                    value: money(data.stables),
                    note: "No swap needed",
                    icon: CreditCard,
                  },
                  {
                    label: "Signals to investigate",
                    value: String(
                      data.signals.filter((s) => s.watch).length,
                    ).padStart(2, "0"),
                    note: "Evidence, not a safety score",
                    icon: Activity,
                  },
                ].map(({ label, value, note, icon: Icon }, i) => (
                  <div className={`stat stat-${i}`} key={label}>
                    <div className="stat-label">
                      {label}
                      <Icon size={17} />
                    </div>
                    <strong>
                      {value}
                      {i === 3 && <small>WATCH</small>}
                    </strong>
                    <div
                      className={`stat-note ${i === 1 ? "amber" : i === 2 ? "green" : ""}`}
                    >
                      {i === 1 && <span className="dot" />}
                      {note}
                      {i === 2 && <Check size={12} />}
                    </div>
                  </div>
                ))}
              </section>
              <div className="content-grid">
                <div className="left-column">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Historical value</h2>
                      </div>
                      <div className="segmented">
                        {[7, 14].map((d) => (
                          <button
                            key={d}
                            className={days === d ? "selected" : ""}
                            onClick={() => setDays(d)}
                          >
                            {d}D
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="chart-head">
                      <strong>{money(data.total)}</strong>
                      {history.length > 0 && (
                        <span className={change < 0 ? "amber" : "green"}>
                          {change < 0 ? "↘" : "↗"} {money(Math.abs(change))}{" "}
                          {change < 0 ? "below" : "above"} first day
                        </span>
                      )}
                    </div>
                    <div className="chart">
                      {history.length === 0 ? (
                        <p>
                          No indexed history is available for this snapshot.
                        </p>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart
                            data={history}
                            margin={{ top: 15, right: 6, left: 0, bottom: 0 }}
                          >
                            <defs>
                              <linearGradient
                                id="history-fill"
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1"
                              >
                                <stop
                                  offset="0%"
                                  stopColor="#b8f0c9"
                                  stopOpacity={0.22}
                                />
                                <stop
                                  offset="100%"
                                  stopColor="#b8f0c9"
                                  stopOpacity={0}
                                />
                              </linearGradient>
                            </defs>
                            <XAxis
                              dataKey="date"
                              tickFormatter={(v) =>
                                new Date(v * 1000).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                  timeZone: "UTC",
                                })
                              }
                              minTickGap={45}
                              tickLine={false}
                              axisLine={false}
                              tick={{ fill: "#85988a", fontSize: 11 }}
                            />
                            <YAxis
                              domain={["auto", "auto"]}
                              tickFormatter={(v) =>
                                `$${(v / 1000).toFixed(1)}k`
                              }
                              orientation="right"
                              axisLine={false}
                              tickLine={false}
                              width={55}
                              tick={{ fill: "#85988a", fontSize: 11 }}
                            />
                            <Tooltip
                              labelFormatter={(v) =>
                                new Date(Number(v) * 1000).toLocaleDateString(
                                  "en-US",
                                  { timeZone: "UTC" },
                                )
                              }
                              formatter={(v) => [
                                money(Number(v)),
                                "Indexed value",
                              ]}
                              contentStyle={{
                                background: "#1a2920",
                                border: "1px solid #3b4a43",
                                borderRadius: 8,
                              }}
                            />
                            <Area
                              type="monotone"
                              dataKey="value"
                              stroke="#b8f0c9"
                              strokeWidth={2}
                              fill="url(#history-fill)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                    <div className="chart-foot">
                      <span>
                        <span className="legend-dot" /> Constant holdings ×
                        historical price
                      </span>
                      <button onClick={() => setEvidence(true)}>
                        View evidence ↗
                      </button>
                    </div>
                    <p className="disclaimer">
                      Historical indexed valuation before fees, gas and
                      slippage. Not an executable past quote or a forecast.
                    </p>
                  </section>
                  <section className="panel" id="exposure">
                    <div className="panel-heading">
                      <div>
                        <h2>Exposure</h2>
                      </div>
                      <GitBranch size={20} />
                    </div>
                    <div className="exposure-map">
                      <div className="map-wallet">
                        <Wallet size={21} />
                        <span>
                          Your wallet<strong>{money(data.total, 0)}</strong>
                        </span>
                      </div>
                      <div className="map-connector" />
                      <div className="map-assets">
                        <div>
                          <span className="token eth">Ξ</span>
                          <span>
                            ETH + WETH<small>{money(data.eth, 0)}</small>
                          </span>
                          <span className="map-tag">ETH price</span>
                        </div>
                        <div>
                          <span className="token usdc">$</span>
                          <span>
                            USDC<small>{money(data.stables, 0)}</small>
                          </span>
                          <span className="map-tag">USD peg</span>
                        </div>
                      </div>
                    </div>
                    <form
                      className="quick-swap"
                      aria-label="Quick swap"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (
                          busy ||
                          !Number.isFinite(Number(amount)) ||
                          Number(amount) <= 0
                        )
                          return;
                        void requestQuote();
                        setSection("Exit planner");
                        const planner = document.getElementById("exit");
                        planner?.focus({ preventScroll: true });
                        planner?.scrollIntoView({
                          behavior: window.matchMedia(
                            "(prefers-reduced-motion: reduce)",
                          ).matches
                            ? "instant"
                            : "smooth",
                        });
                      }}
                    >
                      <div className="quick-swap-heading">
                        <h3>Swap to USDC</h3>
                        <span>Base · Review before approval</span>
                      </div>
                      <div className="quick-swap-controls">
                        <div className="amount-field">
                          <input
                            aria-label="Quick swap amount"
                            inputMode="decimal"
                            placeholder="Amount"
                            disabled={!!busy}
                            value={amount}
                            onChange={(event) => {
                              setAmount(event.target.value);
                              setQuote(null);
                              setFundingPlan(null);
                            }}
                          />
                          <select
                            aria-label="Quick swap asset"
                            disabled={!!busy}
                            value={asset}
                            onChange={(event) => {
                              setAsset(event.target.value as "ETH" | "WETH");
                              setQuote(null);
                              setFundingPlan(null);
                            }}
                          >
                            <option>ETH</option>
                            <option>WETH</option>
                          </select>
                        </div>
                        <button
                          className="button primary"
                          disabled={
                            !!busy ||
                            !Number.isFinite(Number(amount)) ||
                            Number(amount) <= 0
                          }
                        >
                          {busy === "quote" ? (
                            <LoaderCircle size={16} className="spin" />
                          ) : (
                            <ArrowUpRight size={16} />
                          )}
                          Get quote
                        </button>
                      </div>
                      <div className="balance-label">
                        Available{" "}
                        {view.holdings.find(
                          (holding) => holding.symbol === asset,
                        )?.units ?? "Unavailable"}{" "}
                        {asset}
                      </div>
                    </form>
                    <div className="risk-list">
                      {data.signals.map((s) => (
                        <div className="risk-row" key={s.id}>
                          <span
                            className={`signal-icon ${s.watch ? "amber" : "green"}`}
                          >
                            <Activity size={15} />
                          </span>
                          <div>
                            <h3>{s.title}</h3>
                            <p>{s.detail}</p>
                            <small>{s.evidence}</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Your supported positions</h2>
                      <span className="badge">
                        {
                          view.holdings.filter((h) => Number(h.units) > 0)
                            .length
                        }{" "}
                        HELD ASSETS
                      </span>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Asset</th>
                            <th>Balance</th>
                            <th>Indexed value</th>
                            <th>Exposure</th>
                          </tr>
                        </thead>
                        <tbody>
                          {view.holdings.map((h) => (
                            <tr key={h.symbol}>
                              <td>
                                <span
                                  className={`token ${h.symbol === "USDC" ? "usdc" : "eth"}`}
                                >
                                  {h.symbol === "USDC" ? "$" : "Ξ"}
                                </span>
                                <b>{h.symbol}</b>
                              </td>
                              <td>
                                {Number(h.units).toLocaleString("en-US", {
                                  maximumFractionDigits: 6,
                                })}
                              </td>
                              <td>{money(h.valueUsd)}</td>
                              <td>
                                {h.symbol === "USDC" ? "USD peg" : "ETH price"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="disclaimer">
                      Other tokens, lending, LPs, debt and other chains are
                      excluded. USDC is valued at $1, not guaranteed to redeem
                      at $1.
                    </p>
                  </section>
                </div>
                <div className="right-column">
                  <section
                    className="panel exit-panel"
                    id="exit"
                    tabIndex={-1}
                    aria-label="Exit planner"
                  >
                    <div className="panel-heading">
                      <div>
                        <h2>Exit planner</h2>
                      </div>
                      <span className="round-icon">
                        <ArrowUpRight size={21} />
                      </span>
                    </div>
                    <label className="field-label" htmlFor="sell-amount">
                      You sell
                    </label>
                    <div className="amount-field">
                      <input
                        id="sell-amount"
                        inputMode="decimal"
                        disabled={!!busy}
                        value={amount}
                        onChange={(e) => {
                          setAmount(e.target.value);
                          setQuote(null);
                          setFundingPlan(null);
                        }}
                      />
                      <select
                        aria-label="Asset to sell"
                        disabled={!!busy}
                        value={asset}
                        onChange={(e) => {
                          setAsset(e.target.value as "ETH" | "WETH");
                          setQuote(null);
                          setFundingPlan(null);
                        }}
                      >
                        <option>ETH</option>
                        <option>WETH</option>
                      </select>
                    </div>
                    <div className="balance-label">
                      Available{" "}
                      {view.holdings.find((h) => h.symbol === asset)?.units ??
                        "Unavailable"}{" "}
                      {asset}
                    </div>
                    <div className="route-line">↓</div>
                    <div className="receive-box">
                      <div>
                        <span className="field-label">Estimated receipt</span>
                        <strong>
                          {quote
                            ? Number(quote.amountOut).toLocaleString("en-US", {
                                maximumFractionDigits: 6,
                              })
                            : "—"}
                        </strong>
                      </div>
                      <span className="asset-label">
                        <span className="token usdc">$</span>USDC
                      </span>
                    </div>
                    <div className="quote-details">
                      <div>
                        <span>Network</span>
                        <span>Base</span>
                      </div>
                      <div>
                        <span>Slippage limit</span>
                        <span>0.50%</span>
                      </div>
                      <div>
                        <span>Conservative gas budget</span>
                        <span>
                          {quote
                            ? money(quote.gasUsd, 4)
                            : "Quote to calculate"}
                        </span>
                      </div>
                      {quote && (
                        <>
                          <div>
                            <span>Minimum received</span>
                            <span>{quote.minimumOut} USDC</span>
                          </div>
                          <div>
                            <span>Pool fee</span>
                            <span>{(quote.fee / 10000).toFixed(2)}%</span>
                          </div>
                          <div>
                            <span>Price impact</span>
                            <span>{quote.priceImpactPct.toFixed(2)}%</span>
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      className="button primary full-width"
                      disabled={
                        !!busy ||
                        !Number.isFinite(Number(amount)) ||
                        Number(amount) <= 0
                      }
                      onClick={requestQuote}
                    >
                      {busy === "quote" ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : (
                        <GitBranch size={17} />
                      )}{" "}
                      Get quote
                    </button>
                    {quote && (
                      <div className="quote-result">
                        <span>{`LIVE QUOTE · BLOCK ${quote.block}`}</span>
                        <p>
                          {quoteExpired
                            ? "Quote expired. Find a fresh route before approving."
                            : "Check the minimum received and gas. Quotes expire after 60 seconds."}
                        </p>
                        {quote.source === "live" && live && (
                          <button
                            className="button primary full-width"
                            disabled={!!busy || quoteExpired}
                            onClick={() =>
                              run("execute", async () => {
                                if (actions) {
                                  setReceipt(await actions.execute(quote));
                                  setQuote(null);
                                  setFundingPlan(null);
                                  setSnapshot(await actions.refresh());
                                }
                              })
                            }
                          >
                            {busy === "execute"
                              ? "Waiting for approval / receipt…"
                              : "Review & approve in wallet"}
                          </button>
                        )}
                      </div>
                    )}
                    {receipt && (
                      <a
                        className="receipt-link"
                        href={`https://basescan.org/tx/${receipt}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ShieldCheck size={16} />
                        Confirmed on Base ↗
                      </a>
                    )}
                    <div className="safety-note">
                      <ShieldCheck size={14} />
                      <span>
                        No automatic liquidation. Every transaction requires
                        your approval.
                      </span>
                    </div>
                    <section
                      className="assistant-panel"
                      id="assistant"
                      aria-label="Exit assistant"
                    >
                      <div className="panel-heading">
                        <h2>
                          <span className="assistant-mark">✳</span>Exit
                          assistant
                        </h2>
                        <span className="badge">READ ONLY</span>
                      </div>
                      <div className="prompt-chips">
                        {[
                          "Where is my biggest exposure?",
                          "What would an exit change?",
                        ].map((q) => (
                          <button key={q} onClick={() => setQuestion(q)}>
                            {q}
                            <ArrowUpRight size={12} />
                          </button>
                        ))}
                      </div>
                      {answer && (
                        <div className="assistant-answer" role="status">
                          {answer}
                        </div>
                      )}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          run("assistant", async () => {
                            if (actions) setAnswer(await actions.ask(question));
                          });
                        }}
                      >
                        <input
                          aria-label="Ask the assistant"
                          placeholder="Ask about your exposure or exit…"
                          value={question}
                          onChange={(e) => setQuestion(e.target.value)}
                          maxLength={1000}
                        />
                        <button
                          aria-label="Send question"
                          disabled={!!busy || !question.trim()}
                        >
                          {busy === "assistant" ? (
                            <LoaderCircle size={17} className="spin" />
                          ) : (
                            <Send size={17} />
                          )}
                        </button>
                      </form>
                      <small className="assistant-caption">
                        Questions and supported balances go to OpenAI; your
                        wallet address is omitted. AI explanations are not
                        financial advice.
                      </small>
                    </section>
                  </section>
                  <section className="panel funding-panel">
                    <h2>USDC target</h2>
                    <p className="panel-description">
                      Use existing stables before selling a position. Funds stay
                      in your wallet.
                    </p>
                    <label className="field-label" htmlFor="funding-target">
                      Target total USDC balance
                    </label>
                    <div className="amount-field">
                      <input
                        id="funding-target"
                        inputMode="decimal"
                        disabled={!!busy}
                        value={target}
                        onChange={(e) => {
                          setTarget(e.target.value);
                          setFundingPlan(null);
                          setQuote(null);
                        }}
                      />
                      <span>USDC</span>
                    </div>
                    <button
                      className="button full-width"
                      disabled={
                        !!busy ||
                        !Number.isFinite(Number(target)) ||
                        Number(target) <= 0
                      }
                      onClick={() =>
                        run("funding", async () => {
                          if (live && actions) {
                            const plan = await actions.funding(target);
                            setFundingPlan(plan);
                            setQuote(plan.quote);
                            if (plan.quote) {
                              setAsset(plan.quote.asset);
                              setAmount(plan.quote.amountIn);
                            }
                          }
                        })
                      }
                    >
                      {busy === "funding"
                        ? "Comparing positions…"
                        : "Prepare funding plan"}
                    </button>
                    {fundingPlan && (
                      <div className="funding-result" role="status">
                        <div className="quote-details">
                          <div>
                            <span>Already in USDC</span>
                            <span>
                              {money(Number(fundingPlan.existingUsdc))}
                            </span>
                          </div>
                          <div>
                            <span>Additional USDC needed</span>
                            <span>{money(Number(fundingPlan.shortfall))}</span>
                          </div>
                          {fundingPlan.options.map((o) => (
                            <div key={o.asset}>
                              <span>
                                {o.asset} · indexed input + gas budget
                              </span>
                              <span>{money(o.costUsd)}</span>
                            </div>
                          ))}
                        </div>
                        <p>{fundingPlan.note}</p>
                        {fundingPlan.quote && (
                          <p>
                            Selected {fundingPlan.quote.asset}. Review the
                            prepared quote above. No funds have moved.
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                </div>
              </div>
              <footer>
                <span>
                  <span className="dot" />
                  {`Balances fetched ${new Date(view.fetchedAt).toLocaleString()} · balance block ${view.rpcBlock.toLocaleString()} · indexed block ${view.block.toLocaleString()}`}
                </span>
                <button onClick={() => setEvidence(true)}>
                  The Graph → evidence · Privy → control ↗
                </button>
              </footer>
            </>
          )}
        </main>
      </div>
      {evidence && view && (
        <div className="modal-backdrop" onClick={() => setEvidence(false)}>
          <section
            ref={modalRef}
            className="evidence-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="evidence-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="Close methodology"
              onClick={() => setEvidence(false)}
            >
              <X size={20} />
            </button>
            <span className="eyebrow">TRACE THE NUMBERS</span>
            <h2 id="evidence-title">Evidence & methodology</h2>
            <p>
              The Graph supplies Uniswap V3 pool price, TVL, volume and
              historical prices. RPC reads current balances, verifies contracts,
              quotes routes and simulates transactions.
            </p>
            <dl>
              <dt>Coverage</dt>
              <dd>
                Base ETH, WETH and native USDC only. No debt, lending or LP
                positions.
              </dd>
              <dt>Concentration flag</dt>
              <dd>ETH + WETH exceeds 60% of supported indexed value.</dd>
              <dt>Activity flag</dt>
              <dd>
                Latest complete day volume exceeds 2× the preceding available
                seven-day average.
              </dd>
              <dt>Liquidity flag</dt>
              <dd>
                TVL falls more than 15% between the last two complete days.
                Price changes also affect TVL.
              </dd>
              <dt>Historical comparison</dt>
              <dd>
                Current units × indexed daily WETH/USDC price + USDC at $1.
                Fees, slippage, gas and changes in holdings are excluded.
              </dd>
              <dt>Execution</dt>
              <dd>
                Best output among supported direct Uniswap V3 pools successfully
                quoted, not a whole-market best-price guarantee. Slippage capped
                at 0.5%; explicit wallet approval required.
              </dd>
            </dl>
            <a
              href={`https://thegraph.com/explorer/subgraphs/${view.subgraphId}?view=Query`}
              target="_blank"
              rel="noreferrer"
            >
              Open subgraph source ↗
            </a>
            <p className="disclaimer">
              {`Indexed block ${view.block}, balance block ${view.rpcBlock}.`}{" "}
              No future return or safety guarantee.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
