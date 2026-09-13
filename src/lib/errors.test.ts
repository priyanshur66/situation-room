import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";

describe("user-facing errors", () => {
  it("displays safe Convex validation data even when production masks the message", () => {
    const error = new ConvexError("Refresh your analysis first.");
    error.message = "Server Error";
    expect(errorMessage(error)).toBe("Refresh your analysis first.");
  });
  it("preserves explicit transaction recovery guidance", () => {
    expect(
      errorMessage(new Error("Check confirmation; do not send again.")),
    ).toBe("Check confirmation; do not send again.");
  });
  it("provides a fallback for an unknown error", () => {
    expect(errorMessage(null)).toBe("Something went wrong. Please retry.");
  });
});
