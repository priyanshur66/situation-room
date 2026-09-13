import { Activity } from "lucide-react";
import { money, shortAddress, type Snapshot } from "../lib/model";
import { composeActivity } from "../lib/stream-evidence";

export function StreamPanel({ snapshot }: { snapshot: Snapshot }) {
  const stream = snapshot.stream;
  const activity = composeActivity(stream, snapshot.pools, snapshot.indexedAt);
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>
          <Activity size={18} /> Recent onchain activity
        </h2>
        <span className="badge">
          {stream?.status === "complete"
            ? "VERIFIED WINDOW"
            : stream?.status === "partial"
              ? "PARTIAL COVERAGE"
              : "UNAVAILABLE"}
        </span>
      </div>
      <p className="muted">Substreams events × Subgraph pool history</p>
      {stream && stream.blocksRead > 0 ? (
        <>
          <p>
            {stream.blocksRead} blocks read · {stream.fromBlock}–
            {stream.toBlock}
          </p>
          {activity.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Pool</th>
                    <th>Recent swaps</th>
                    <th>USDC exchanged</th>
                    <th>Avg. full-day volume</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((p) => (
                    <tr key={p.address}>
                      <td>
                        <a
                          href={`https://basescan.org/address/${p.address}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortAddress(p.address)} ↗
                        </a>
                      </td>
                      <td>{p.swaps}</td>
                      <td>{money(p.usdcVolume)}</td>
                      <td>
                        {p.averageDailyVolume === null
                          ? "Unavailable"
                          : money(p.averageDailyVolume)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p>
            {stream.transfers.length} wallet ERC-20 transfers observed in these
            blocks.
          </p>
          {stream.transfers.slice(-5).map((t, i) => (
            <p key={`${t.hash}:${i}`}>
              <a
                href={`https://basescan.org/tx/${t.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(t.hash)} ↗
              </a>{" "}
              {t.from.toLowerCase() === snapshot.wallet.toLowerCase()
                ? "Sent"
                : "Received"}{" "}
              · token {shortAddress(t.token)}
            </p>
          ))}
        </>
      ) : (
        <p>
          Recent streaming observations are unavailable. Balance and historical
          evidence remain separate.
        </p>
      )}
      <p className="disclaimer">
        {stream?.note ?? "Refresh analysis to request recent-block evidence."}{" "}
        Recent volume and daily averages cover different time windows, not an
        anomaly score.
      </p>
    </section>
  );
}
