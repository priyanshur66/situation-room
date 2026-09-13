import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SwapRecovery } from "./swap-recovery";

const plan = {
  status: "executing",
  step: 1,
  issued: false,
  payload: JSON.stringify({
    asset: "WETH",
    amountIn: "0.001",
    minimumOut: "1",
    transactions: [{ label: "Approve WETH" }, { label: "Swap WETH" }],
  }),
};
function render(
  extra: Partial<typeof plan> & { pendingHash?: string; nonce?: number } = {},
  executing = false,
) {
  return renderToStaticMarkup(
    <SwapRecovery
      plan={{ ...plan, ...extra }}
      executing={executing}
      onResume={vi.fn()}
      onCancel={vi.fn()}
      onRecover={vi.fn()}
    />,
  );
}
describe("swap recovery controls", () => {
  it("offers resume and safe cancellation after a confirmed approval", () => {
    const html = render();
    expect(html).toContain("Resume swap");
    expect(html).toContain("Cancel remaining steps");
    expect(html).toContain("Step 2 of 2");
  });
  it("only offers receipt checking for a known submission", () => {
    const html = render({ issued: true, pendingHash: `0x${"a".repeat(64)}` });
    expect(html).toContain("Check receipt");
    expect(html).not.toContain("Cancel remaining steps");
    expect(html).not.toContain("Retry same nonce");
  });
  it("offers explicit same-nonce retry for an unknown issued result, never cancellation", () => {
    const html = render({ issued: true, nonce: 4 });
    expect(html).toContain("Retry same nonce");
    expect(html).not.toContain("Cancel remaining steps");
  });
  it("hides recovery actions while the execution loop is running", () => {
    const html = render({}, true);
    expect(html).toContain("Swap in progress");
    expect(html).not.toContain("Resume swap");
    expect(html).not.toContain("Cancel remaining steps");
  });
});
