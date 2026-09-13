"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { sendDelegated } from "./delegation";
import { confirmPayment } from "./payments";

// Only the authenticated Pay mutation can enqueue this private workflow.
// Each run does one step, persists its receipt, then schedules the next step.
export const run = internalAction({
  args: { id: v.id("payments"), generation: v.number() },
  handler: async (ctx, a): Promise<void> => {
    const row = await ctx.runMutation(internal.paymentWorkerState.begin, a);
    if (!row) return;
    let failed = false;
    try {
      const hash =
        row.pendingHash ??
        (
          await sendDelegated(
            ctx,
            row.owner,
            {
              id: row._id,
              step: row.step,
            },
            true,
          )
        ).hash;
      await confirmPayment(ctx, row.owner, {
        id: row._id,
        step: row.step,
        hash,
      });
    } catch {
      // Do not persist SDK/RPC errors containing credentials or request bodies.
      failed = true;
    }
    await ctx.runMutation(internal.paymentWorkerState.finish, { ...a, failed });
  },
});
