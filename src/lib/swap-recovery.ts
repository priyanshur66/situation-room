export function mayCancelSwap(row: {
  status: string;
  issued?: boolean;
  pendingHash?: string;
}) {
  // Older plans without issuance metadata are unknown, not safe to abandon.
  return row.status === "executing" && row.issued === false && !row.pendingHash;
}

export function mayIssueSwap(
  row: { status: string; step: number; issued?: boolean; pendingHash?: string },
  index: number,
) {
  return (
    row.status === "executing" &&
    row.step === index &&
    row.issued === false &&
    !row.pendingHash
  );
}
