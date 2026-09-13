import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { mayCancelSwap, mayIssueSwap } from "../src/lib/swap-recovery";
export const rateLimit = internalMutation({
  args: { owner: v.string(), bucket: v.string() },
  handler: async (ctx, { owner, bucket }) => {
    const limit = bucket === "assistant" ? 10 : 30,
      now = Date.now();
    const row = await ctx.db
      .query("limits")
      .withIndex("by_owner_bucket", (q) =>
        q.eq("owner", owner).eq("bucket", bucket),
      )
      .unique();
    if (row && now - row.start < 60000 && row.count >= limit)
      throw new ConvexError("Too many requests. Please wait a minute.");
    if (row)
      await ctx.db.patch(row._id, {
        start: now - row.start >= 60000 ? now : row.start,
        count: now - row.start >= 60000 ? 1 : row.count + 1,
      });
    else await ctx.db.insert("limits", { owner, bucket, start: now, count: 1 });
  },
});
export const saveSnapshot = internalMutation({
  args: { owner: v.string(), wallet: v.string(), payload: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("snapshots")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", args.owner).eq("wallet", args.wallet),
      )
      .unique();
    if (row)
      if (JSON.parse(row.payload).rpcBlock > JSON.parse(args.payload).rpcBlock)
        return;
    if (row)
      return await ctx.db.patch(row._id, {
        payload: args.payload,
        updatedAt: Date.now(),
      });
    await ctx.db.insert("snapshots", { ...args, updatedAt: Date.now() });
  },
});
export const snapshot = internalQuery({
  args: { owner: v.string(), wallet: v.string() },
  handler: (ctx, a) =>
    ctx.db
      .query("snapshots")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", a.owner).eq("wallet", a.wallet),
      )
      .unique(),
});
export const latest = query({
  args: { wallet: v.string() },
  handler: async (ctx, a) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return ctx.db
      .query("snapshots")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", identity.subject).eq("wallet", a.wallet.toLowerCase()),
      )
      .unique();
  },
});
export const createPlan = internalMutation({
  args: {
    owner: v.string(),
    wallet: v.string(),
    payload: v.string(),
    expiresAt: v.number(),
  },
  handler: (ctx, a) =>
    ctx.db.insert("plans", {
      ...a,
      status: "quoted",
      step: 0,
      hashes: [],
      issued: false,
      createdAt: Date.now(),
    }),
});
export const plan = internalQuery({
  args: { id: v.id("plans"), owner: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.owner !== a.owner) throw new ConvexError("Plan not found.");
    return row;
  },
});
export const claim = mutation({
  args: { id: v.id("plans") },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity(),
      row = await ctx.db.get(a.id);
    if (!user || !row || row.owner !== user.subject)
      throw new ConvexError("Plan not found.");
    if (row.status !== "quoted")
      throw new ConvexError(
        "This plan has already started. Do not submit it again.",
      );
    if (row.expiresAt < Date.now())
      throw new ConvexError("Quote expired. Request a fresh quote.");
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", user.subject).eq("wallet", row.wallet),
      )
      .collect();
    const swaps = await ctx.db
      .query("plans")
      .withIndex("by_owner", (q) => q.eq("owner", user.subject))
      .collect();
    if (
      payments.some((p) => p.status === "active") ||
      swaps.some((p) => p.wallet === row.wallet && p.status === "executing")
    )
      throw new ConvexError(
        "Finish the active wallet transaction before starting another swap.",
      );
    await ctx.db.patch(row._id, { status: "executing" });
  },
});
export const submitted = mutation({
  args: { id: v.id("plans"), index: v.number(), hash: v.string() },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity(),
      row = await ctx.db.get(a.id);
    if (
      !user ||
      !row ||
      row.owner !== user.subject ||
      row.status !== "executing" ||
      row.step !== a.index
    )
      throw new ConvexError("Invalid transaction step.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(a.hash))
      throw new ConvexError("Invalid transaction hash.");
    if (row.pendingHash && row.pendingHash !== a.hash)
      throw new ConvexError("A transaction is already pending.");
    await ctx.db.patch(row._id, { pendingHash: a.hash });
  },
});
export const activeSwap = query({
  args: { wallet: v.string() },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return null;
    const rows = await ctx.db
      .query("plans")
      .withIndex("by_owner", (q) => q.eq("owner", user.subject))
      .order("desc")
      .collect();
    return (
      rows.find(
        (r) => r.wallet === a.wallet.toLowerCase() && r.status === "executing",
      ) ?? null
    );
  },
});
export const issueStep = internalMutation({
  args: {
    id: v.id("plans"),
    owner: v.string(),
    index: v.number(),
    nonce: v.number(),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.owner !== a.owner || !mayIssueSwap(row, a.index))
      throw new ConvexError(
        "This swap step is already issued or no longer ready.",
      );
    await ctx.db.patch(a.id, { issued: true, nonce: a.nonce });
  },
});
export const cancelSwap = mutation({
  args: { id: v.id("plans") },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity(),
      row = await ctx.db.get(a.id);
    if (!user || !row || row.owner !== user.subject || !mayCancelSwap(row))
      throw new ConvexError(
        "An issued or unknown transaction must be recovered before cancelling.",
      );
    await ctx.db.patch(a.id, { status: "cancelled" });
  },
});
export const pending = query({
  args: { wallet: v.string() },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return [];
    const rows = await ctx.db
      .query("plans")
      .withIndex("by_owner", (q) => q.eq("owner", user.subject))
      .order("desc")
      .take(50);
    return rows
      .filter(
        (r) =>
          r.wallet === a.wallet.toLowerCase() &&
          r.status === "executing" &&
          r.pendingHash,
      )
      .map((r) => ({ id: r._id, index: r.step, hash: r.pendingHash! }));
  },
});
export const recordStep = internalMutation({
  args: {
    id: v.id("plans"),
    owner: v.string(),
    index: v.number(),
    hash: v.string(),
    complete: v.boolean(),
    reverted: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.owner !== a.owner || row.status !== "executing")
      throw new ConvexError("Invalid plan state.");
    if (row.hashes.includes(a.hash)) return;
    if (row.step !== a.index)
      throw new ConvexError("Unexpected transaction step.");
    await ctx.db.patch(row._id, {
      step: row.step + 1,
      hashes: [...row.hashes, a.hash],
      pendingHash: undefined,
      issued: false,
      nonce: undefined,
      status: a.reverted ? "cancelled" : a.complete ? "confirmed" : "executing",
    });
  },
});
