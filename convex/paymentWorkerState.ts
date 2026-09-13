import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server";

const args = { id: v.id("payments"), generation: v.number() };

// Scheduling and checkpoint updates commit together. Old generations cannot
// advance a newer run; provider idempotency and reserved nonces guard sends.
export async function queuePayment(
  ctx: MutationCtx,
  row: Doc<"payments">,
  delay: number,
) {
  const generation = (row.workerGeneration ?? 0) + 1;
  const job = await ctx.scheduler.runAfter(delay, internal.paymentWorker.run, {
    id: row._id,
    generation,
  });
  await ctx.db.patch(row._id, {
    workerGeneration: generation,
    workerState: "queued",
    workerAttempts:
      (row.workerStep === row.step ? (row.workerAttempts ?? 0) : 0) + 1,
    workerStep: row.step,
    workerJob: job,
    workerMessage: undefined,
  });
  await ctx.scheduler.runAfter(
    delay + 60000,
    internal.paymentWorkerState.watch,
    {
      id: row._id,
      generation,
    },
  );
}

export const begin = internalMutation({
  args,
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (
      !row ||
      !row.background ||
      row.status !== "active" ||
      row.workerGeneration !== a.generation ||
      row.workerState !== "queued"
    )
      return null;
    await ctx.db.patch(row._id, { workerState: "running" });
    return row;
  },
});

async function checkpoint(
  ctx: MutationCtx,
  row: Doc<"payments">,
  failed: boolean,
) {
  if (row.status !== "active") {
    await ctx.db.patch(row._id, {
      workerState: "done",
      workerMessage: undefined,
    });
    return;
  }
  // A checkpointed receipt is authoritative even if the action lost its reply.
  if (row.step !== row.workerStep || !failed) {
    await queuePayment(ctx, row, 0);
    return;
  }
  // Receipt polling is read-only. Never automatically repeat an ambiguous
  // issued send with no hash; expose recovery instead.
  if ((!row.issued || row.pendingHash) && (row.workerAttempts ?? 0) < 3) {
    await queuePayment(ctx, row, 10000);
    return;
  }
  await ctx.db.patch(row._id, {
    workerState: "attention",
    workerMessage: row.pendingHash
      ? "Waiting for a verified receipt. Check confirmation or resume receipt checks. No duplicate transfer will be sent."
      : row.issued
        ? "The submission result is uncertain. Recover its transaction hash from wallet activity before continuing."
        : "Payment paused before the next step. Check that the quote, preferences, gas balance and restricted permission are still valid.",
  });
}

export const finish = internalMutation({
  args: { ...args, failed: v.boolean() },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (
      !row ||
      row.workerGeneration !== a.generation ||
      row.workerState !== "running"
    )
      return;
    await checkpoint(ctx, row, a.failed);
  },
});

export const watch = internalMutation({
  args,
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (
      !row ||
      row.workerGeneration !== a.generation ||
      !["queued", "running"].includes(row.workerState ?? "")
    )
      return;
    const job = row.workerJob ? await ctx.db.system.get(row.workerJob) : null;
    if (job && ["pending", "inProgress"].includes(job.state.kind)) {
      await ctx.scheduler.runAfter(60000, internal.paymentWorkerState.watch, a);
      return;
    }
    await checkpoint(ctx, row, true);
  },
});

export const resume = mutation({
  args: { id: v.id("payments") },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity(),
      row = await ctx.db.get(a.id);
    if (!user || !row || row.owner !== user.subject)
      throw new ConvexError("Payment not found.");
    if (
      !row.background ||
      row.status !== "active" ||
      row.workerState !== "attention"
    )
      throw new ConvexError("This payment is not paused.");
    if (row.issued && !row.pendingHash)
      throw new ConvexError(
        "Recover the issued transaction hash before resuming. Do not resend an uncertain transaction.",
      );
    await queuePayment(ctx, { ...row, workerAttempts: 0 }, 0);
  },
});
