import { money, shortAddress, type Snapshot } from "../lib/model";
import { sectorExposure, type DiscoveredHolding } from "../lib/portfolio";

function HoldingsTable({ holdings }: { holdings: DiscoveredHolding[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Asset</th>
            <th>Sector</th>
            <th>Verified units</th>
            <th>Reference value</th>
            <th>Pool liquidity</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.contract}>
              <td>
                <strong>{h.symbol}</strong>
                <br />
                <a
                  href={`https://basescan.org/address/${h.contract}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddress(h.contract)} ↗
                </a>
              </td>
              <td>{h.sector}</td>
              <td>{h.units ?? "Unavailable"}</td>
              <td>
                {h.market &&
                h.units !== null &&
                Number.isFinite(Number(h.units) * h.market.priceUsd) ? (
                  <>
                    {money(Number(h.units) * h.market.priceUsd)}
                    <br />
                    <small>Read-only · indexed price</small>
                  </>
                ) : (
                  "Unpriced · read-only"
                )}
              </td>
              <td>
                {h.market ? (
                  <a
                    href={`https://basescan.org/address/${h.market.pool}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {money(h.market.liquidityUsd)} ↗
                  </a>
                ) : (
                  "Unavailable"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PortfolioDiscoveryPanel({ snapshot }: { snapshot: Snapshot }) {
  const discovery = snapshot.discovery;
  const rows = sectorExposure(snapshot);
  const recognized = discovery?.holdings.filter((h) => h.recognized) ?? [];
  const other = discovery?.holdings.filter((h) => !h.recognized) ?? [];
  return (
    <section
      className="panel portfolio-discovery"
      aria-label="Wallet sectors and discovered holdings"
    >
      <div className="panel-heading">
        <h2>Wallet sectors</h2>
        <span className="badge">
          {discovery?.status === "complete"
            ? "INDEXED SCAN"
            : discovery?.status === "partial"
              ? "PARTIAL SCAN"
              : "CORE ASSETS ONLY"}
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Sector</th>
              <th>Assets</th>
              <th>Priced portion</th>
              <th>Unpriced holdings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.sector}>
                <td>{row.sector}</td>
                <td>{row.assets.join(", ")}</td>
                <td>
                  {row.valuedUsd === 0 && row.unpriced > 0
                    ? "Unpriced"
                    : money(row.valuedUsd)}
                </td>
                <td>{row.unpriced || "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p>No positive balances verified in the covered assets.</p>
      )}
      <h3>Additional holdings</h3>
      {recognized.length > 0 ? (
        <HoldingsTable holdings={recognized} />
      ) : (
        <p>No additional recognized holdings verified in this scan.</p>
      )}
      {other.length > 0 && (
        <details>
          <summary>Unrecognized tokens ({other.length})</summary>
          <p className="disclaimer">
            Contract balances are not an endorsement. Names may be spoofed and
            tokens may be spam or unsellable. These assets are excluded from
            spending.
          </p>
          <HoldingsTable holdings={other} />
        </details>
      )}
      {recognized.some((h) => h.sector === "Tokenized equities") && (
        <p className="disclaimer">
          Stock balances are token units, not a fixed number of shares. Issuer
          eligibility, transfer restrictions and corporate-action multipliers
          apply.
        </p>
      )}
      {recognized.some((h) => h.market) && (
        <details>
          <summary>Price and liquidity evidence</summary>
          {recognized
            .filter((h) => h.market)
            .map((h) => (
              <p key={h.contract}>
                <strong>{h.symbol}</strong> ·{" "}
                {h.market!.priceUsd.toLocaleString(undefined, {
                  maximumSignificantDigits: 6,
                })}{" "}
                USD/token · {h.market!.history.length} indexed daily
                observations · latest indexed day volume{" "}
                {h.market!.latestDayVolumeUsd === null
                  ? "unavailable"
                  : money(h.market!.latestDayVolumeUsd)}{" "}
                · indexed {new Date(h.market!.indexedAt * 1000).toISOString()}
                <br />
                <span className="muted">
                  {h.market!.source} · {h.market!.quoteToken} reference · block{" "}
                  {h.market!.indexedBlock}
                </span>
              </p>
            ))}
        </details>
      )}
      <p className="disclaimer">
        {discovery?.note ??
          "Refresh analysis to discover additional Base tokens."}{" "}
        Sector values cover priced assets only, not your whole wallet.
      </p>
      {discovery?.marketNote && (
        <p className="disclaimer">{discovery.marketNote}</p>
      )}
      {discovery && (
        <p className="source-line">
          {discovery.source} · Base balance block {discovery.rpcBlock} ·{" "}
          {discovery.pages} indexed pages
        </p>
      )}
    </section>
  );
}
