import { describe, expect, it } from "vitest";
import { mayCancelSwap, mayIssueSwap } from "./swap-recovery";

describe("swap execution guards", () => {
  it("allows cancellation or issuance only for an unissued active step", () => {
    const row = { status: "executing", step: 1, issued: false };
    expect(mayCancelSwap(row)).toBe(true);
    expect(mayIssueSwap(row, 1)).toBe(true);
    expect(mayIssueSwap(row, 0)).toBe(false);
  });
  it("never abandons an issued, submitted or legacy unknown transaction", () => {
    for (const extra of [
      { issued: true },
      { issued: false, pendingHash: "0x123" },
      {},
    ]) {
      const row = { status: "executing", step: 0, ...extra };
      expect(mayCancelSwap(row)).toBe(false);
      expect(mayIssueSwap(row, 0)).toBe(false);
    }
  });
  it("does not revive terminal plans", () => {
    for (const status of ["cancelled", "confirmed", "quoted"]) {
      const row = { status, step: 0, issued: false };
      expect(mayCancelSwap(row)).toBe(false);
      expect(mayIssueSwap(row, 0)).toBe(false);
    }
  });
});
