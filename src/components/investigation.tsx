"use client";
import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { LoaderCircle, Sparkles } from "lucide-react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../../convex/_generated/api";
import { analyze, money, shortAddress, type Snapshot } from "../lib/model";
import { validateDashboard, type DashboardSpec } from "../lib/dashboard-spec";
import { errorMessage } from "../lib/errors";
import { StreamPanel } from "./stream-panel";

const titles = {
  holdings: "Your holdings",
  exposure: "Underlying exposure",
  history: "Historical value context",
  liquidity: "Pool liquidity",
  volume: "Pool trading volume",
  activity: "Recent onchain activity",
};

export function EvidencePanels({
  spec,
  snapshot,
}: {
  spec: DashboardSpec;
  snapshot: Snapshot;
}) {
  const analysis = analyze(snapshot);
  return (
    <div className="investigation-panels">
      {spec.panels.map((panel, index) => {
        if (panel.kind === "activity")
          return <StreamPanel key={index} snapshot={snapshot} />;
        const cutoff =
          Math.floor(snapshot.indexedAt / 86400) * 86400 - panel.days * 86400;
        const historical = analysis.history.filter(
          (day) => day.date >= cutoff && day.date + 86400 <= snapshot.indexedAt,
        );
        return (
          <section className="panel" key={index}>
            <h3>{titles[panel.kind]}</h3>
            {panel.kind === "holdings" && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Balance</th>
                      <th>Indexed value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.holdings
                      .filter((h) => Number(h.units) > 0)
                      .map((h) => (
                        <tr key={h.symbol}>
                          <td>{h.symbol}</td>
                          <td>{h.units}</td>
                          <td>{money(h.valueUsd)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!snapshot.holdings.some((h) => Number(h.units) > 0) && (
                  <p>No supported holdings in this wallet.</p>
                )}
              </div>
            )}
            {panel.kind === "exposure" && (
              <>
                <div
                  className="exposure-meter"
                  aria-label={`ETH exposure ${analysis.concentration.toFixed(1)} percent`}
                >
                  <span style={{ width: `${analysis.concentration}%` }} />
                </div>
                <p>
                  ETH + WETH: {money(analysis.eth)} ·{" "}
                  {analysis.concentration.toFixed(1)}%
                </p>
                <p>USDC: {money(analysis.stables)}</p>
                <p className="disclaimer">
                  Underlying price concentration, not a risk or safety score.
                </p>
              </>
            )}
            {panel.kind === "history" && (
              <>
                {historical.length > 1 ? (
                  <div className="investigation-chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={historical}>
                        <XAxis
                          dataKey="date"
                          tickFormatter={(v) =>
                            new Date(Number(v) * 1000).toLocaleDateString(
                              undefined,
                              { month: "short", day: "numeric" },
                            )
                          }
                          minTickGap={35}
                        />
                        <YAxis
                          tickFormatter={(v) => money(Number(v), 0)}
                          width={85}
                          domain={["auto", "auto"]}
                        />
                        <Tooltip
                          formatter={(v) => money(Number(v))}
                          labelFormatter={(v) =>
                            new Date(Number(v) * 1000).toLocaleDateString()
                          }
                        />
                        <Area
                          type="monotone"
                          dataKey="value"
                          name="Indexed value"
                          stroke="#b5ebc8"
                          fill="#294b3b"
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p>Insufficient completed-day evidence for this period.</p>
                )}
                <p className="disclaimer">
                  Last {panel.days} days: current holdings at historical prices.
                  Not actual PnL or executable cash-out proceeds; excludes
                  historical gas and slippage.
                </p>
              </>
            )}
            {(panel.kind === "liquidity" || panel.kind === "volume") && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>WETH / USDC pool</th>
                      <th>Days indexed</th>
                      <th>
                        {panel.kind === "volume"
                          ? "Period volume"
                          : "Latest completed TVL"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.pools.map((pool) => {
                      const days = pool.days
                        .filter(
                          (d) =>
                            d.date >= cutoff &&
                            d.date + 86400 <= snapshot.indexedAt,
                        )
                        .sort((a, b) => a.date - b.date);
                      const value =
                        panel.kind === "volume"
                          ? days.reduce((total, d) => total + d.volumeUsd, 0)
                          : days.at(-1)?.tvlUsd;
                      return (
                        <tr key={pool.address}>
                          <td>
                            <a
                              href={`https://basescan.org/address/${pool.address}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {shortAddress(pool.address)} ↗
                            </a>
                            <br />
                            {pool.fee / 10000}% fee
                          </td>
                          <td>
                            {days.length} / {panel.days}
                          </td>
                          <td>
                            {days.length && value !== undefined
                              ? money(value)
                              : "Unavailable"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="disclaimer">
                  The Graph · completed daily observations only. Missing days
                  are not treated as zero.
                </p>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function Investigation({
  wallet,
  snapshot,
}: {
  wallet: string;
  snapshot: Snapshot;
}) {
  const generate = useAction(api.dashboards.generate),
    save = useAction(api.dashboards.save);
  const saved = useQuery(api.dashboardState.list, { wallet });
  const [prompt, setPrompt] = useState(""),
    [spec, setSpec] = useState<DashboardSpec | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <section className="investigation" aria-label="Build an evidence view">
      <div className="panel investigation-builder">
        <div className="panel-heading">
          <h2>
            <Sparkles size={18} /> Ask for a view
          </h2>
          <span className="badge">THE GRAPH + AI</span>
        </div>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage("");
            try {
              setSpec(
                validateDashboard(
                  await generate({ wallet, instruction: prompt }),
                ),
              );
            } catch (error) {
              setMessage(errorMessage(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="investigation-prompt">
            What would you like to investigate?
          </label>
          <div className="investigation-input">
            <input
              id="investigation-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={2000}
              placeholder="Show my exposure and pool liquidity over 14 days"
              disabled={busy}
            />
            <button
              className="button primary"
              disabled={busy || !prompt.trim()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <Sparkles size={18} />
              )}
              {busy ? "Building view…" : "Build view"}
            </button>
          </div>
        </form>
        {!!saved?.length && (
          <label>
            Saved views
            <select
              value=""
              disabled={busy}
              onChange={(e) => {
                const row = saved.find((s) => s._id === e.target.value);
                if (!row) return;
                try {
                  setSpec(validateDashboard(JSON.parse(row.payload)));
                  setMessage(
                    "Showing saved panels with your current wallet snapshot.",
                  );
                } catch {
                  setMessage(
                    "This saved view is incompatible. Build it again.",
                  );
                }
              }}
            >
              <option value="">Choose a view</option>
              {saved.map((row) => (
                <option key={row._id} value={row._id}>
                  {row.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {message && <p role="status">{message}</p>}
        {spec && (
          <>
            <div className="panel-heading">
              <h3>{spec.title}</h3>
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setMessage("");
                  try {
                    await save({ wallet, payload: JSON.stringify(spec) });
                    setMessage("View saved for this wallet.");
                  } catch (error) {
                    setMessage(errorMessage(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Save view
              </button>
            </div>
            {!!spec.unsupported.length && (
              <div className="notice">
                <strong>Not available in this view</strong>
                <ul>
                  {spec.unsupported.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      {spec && <EvidencePanels spec={spec} snapshot={snapshot} />}
    </section>
  );
}
