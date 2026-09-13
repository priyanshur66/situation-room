import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { parseAmount } from "../src/lib/model";
import { validatePolicy, type PaymentPreview } from "../src/lib/policy";

export const preferences = query({
  args: { wallet: v.string() },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return null;
    const rows = await ctx.db
      .query("preferences")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", user.subject).eq("wallet", a.wallet.toLowerCase()),
      )
      .order("desc")
      .take(100);
    return rows.find((r) => r.approvedAt) ?? null;
  },
});
export const approved = internalQuery({
  args: { owner: v.string(), wallet: v.string() },
  handler: async (ctx, a) => {
    const rows = await ctx.db
      .query("preferences")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", a.owner).eq("wallet", a.wallet),
      )
      .order("desc")
      .take(100);
    return rows.find((r) => r.approvedAt) ?? null;
  },
});
export const draft = internalMutation({
  args: {
    owner: v.string(),
    wallet: v.string(),
    payload: v.string(),
    message: v.string(),
    expiresAt: v.number(),
  },
  handler: (ctx, a) =>
    ctx.db.insert("preferences", { ...a, createdAt: Date.now() }),
});
export const preference = internalQuery({
  args: { id: v.id("preferences"), owner: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.owner !== a.owner)
      throw new ConvexError("Preference not found.");
    return row;
  },
});
export const approve = internalMutation({
  args: { id: v.id("preferences"), owner: v.string(), signature: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (
      !row ||
      row.owner !== a.owner ||
      row.expiresAt < Date.now() ||
      row.approvedAt
    )
      throw new ConvexError("Preference challenge expired or already used.");
    const p = validatePolicy(JSON.parse(row.payload));
    if (p.unresolved.length)
      throw new ConvexError(
        "Resolve every unsupported instruction before saving.",
      );
    await ctx.db.patch(a.id, {
      signature: a.signature,
      approvedAt: Date.now(),
    });
  },
});
export const create = internalMutation({
  args: {
    owner: v.string(),
    wallet: v.string(),
    preferenceId: v.id("preferences"),
    payload: v.string(),
    amount: v.string(),
    expiresAt: v.number(),
  },
  handler: (ctx, a) =>
    ctx.db.insert("payments", {
      ...a,
      createdAt: Date.now(),
      status: "quoted",
      step: 0,
      hashes: [],
      issued: false,
    }),
});
export const attachPolicy = internalMutation({
  args: { id: v.id("payments"), owner: v.string(), policyId: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (
      !row ||
      row.owner !== a.owner ||
      row.status !== "quoted" ||
      row.expiresAt < Date.now()
    )
      throw new ConvexError("Preview expired or already started.");
    if (row.delegationPolicyId && row.delegationPolicyId !== a.policyId)
      throw new ConvexError("Permission already configured.");
    await ctx.db.patch(a.id, { delegationPolicyId: a.policyId });
  },
});
export const sentByServer = internalMutation({
  args: {
    id: v.id("payments"),
    owner: v.string(),
    step: v.number(),
    hash: v.string(),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (
      !row ||
      row.owner !== a.owner ||
      row.status !== "active" ||
      row.step !== a.step ||
      !row.issued
    )
      throw new ConvexError("Unexpected server transaction.");
    if (row.pendingHash && row.pendingHash !== a.hash)
      throw new ConvexError("Transaction already recorded.");
    await ctx.db.patch(a.id, { pendingHash: a.hash });
  },
});
export const payment = internalQuery({
  args: { id: v.id("payments"), owner: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.owner !== a.owner)
      throw new ConvexError("Payment not found.");
    return row;
  },
});
export const history = query({
  args: { wallet: v.string() },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return [];
    return ctx.db
      .query("payments")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", user.subject).eq("wallet", a.wallet.toLowerCase()),
      )
      .order("desc")
      .take(100);
  },
});
export const claim = mutation({
  args: { id: v.id("payments") },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity(),
      row = await ctx.db.get(a.id);
    if (!user || !row || row.owner !== user.subject)
      throw new ConvexError("Payment not found.");
    if (row.status !== "quoted" || row.expiresAt < Date.now())
      throw new ConvexError("Payment already started or quote expired.");
    const pref = await ctx.db.get(row.preferenceId);
    if (!pref?.approvedAt)
      throw new ConvexError("Approve your preferences first.");
    const allPrefs = await ctx.db
      .query("preferences")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", user.subject).eq("wallet", row.wallet),
      )
      .order("desc")
      .take(100);
    if (allPrefs.find((r) => r.approvedAt)?._id !== row.preferenceId)
      throw new ConvexError("Preferences changed. Preview again.");
    const p = validatePolicy(JSON.parse(pref.payload));
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", user.subject).eq("wallet", row.wallet),
      )
      .collect();
    if (payments.some((r) => r.status === "active"))
      throw new ConvexError(
        "Complete or cancel the active payment before starting another.",
      );
    const swaps = await ctx.db
      .query("plans")
      .withIndex("by_owner", (q) => q.eq("owner", user.subject))
      .collect();
    if (swaps.some((p) => p.wallet === row.wallet && p.status === "executing"))
      throw new ConvexError(
        "Finish the active swap before starting a payment.",
      );
    const since = Math.floor(Date.now() / 86400000) * 86400000;
    const spent = payments
      .filter(
        (r) =>
          (r.startedAt ?? 0) >= since &&
          ["active", "confirmed"].includes(r.status),
      )
      .reduce((sum, r) => sum + parseAmount(r.amount, 6), 0n);
    const amount = parseAmount(row.amount, 6);
    if (
      amount > parseAmount(p.perPaymentUsdc, 6) ||
      spent + amount > parseAmount(p.dailyUsdc, 6)
    )
      throw new ConvexError(
        "Your approved payment or daily limit would be exceeded.",
      );
    await ctx.db.patch(a.id, { status: "active", startedAt: Date.now() });
  },
});
export const issue = internalMutation({
  args: {
    id: v.id("payments"),
    owner: v.string(),
    step: v.number(),
    nonce: v.number(),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (
      !row ||
      row.owner !== a.owner ||
      row.status !== "active" ||
      row.step !== a.step ||
      row.issued ||
      row.pendingHash
    )
      throw new ConvexError(
        "Step already issued. Verify its transaction; never resend blindly.",
      );
    await ctx.db.patch(a.id, { issued: true, nonce: a.nonce });
  },
});
export const submitted = mutation({
  args: { id: v.id("payments"), step: v.number(), hash: v.string() },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity(),
      row = await ctx.db.get(a.id);
    if (
      !user ||
      !row ||
      row.owner !== user.subject ||
      row.status !== "active" ||
      row.step !== a.step ||
      !row.issued ||
      !/^0x[0-9a-fA-F]{64}$/.test(a.hash)
    )
      throw new ConvexError("Invalid payment transaction.");
    if (row.pendingHash && row.pendingHash !== a.hash)
      throw new ConvexError("A different transaction is pending.");
    await ctx.db.patch(a.id, { pendingHash: a.hash });
  },
});
export const record = internalMutation({
  args: {
    id: v.id("payments"),
    owner: v.string(),
    step: v.number(),
    hash: v.string(),
    reverted: v.boolean(),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.owner !== a.owner)
      throw new ConvexError("Payment not found.");
    if (row.hashes.includes(a.hash)) return;
    if (row.status !== "active" || row.step !== a.step || !row.issued)
      throw new ConvexError("Unexpected confirmation.");
    const plan = JSON.parse(row.payload) as PaymentPreview;
    await ctx.db.patch(a.id, {
      hashes: [...row.hashes, a.hash],
      pendingHash: undefined,
      issued: false,
      step: a.reverted ? row.step : row.step + 1,
      status: a.reverted
        ? "cancelled"
        : row.step + 1 === plan.transactions.length
          ? "confirmed"
          : "active",
    });
  },
});
export const cancel = mutation({
  args: { id: v.id("payments") },
  handler: async (ctx, a) => {
    const user = await ctx.auth.getUserIdentity(),
      row = await ctx.db.get(a.id);
    if (
      !user ||
      !row ||
      row.owner !== user.subject ||
      row.issued ||
      row.pendingHash ||
      row.status === "confirmed"
    )
      throw new ConvexError(
        "An issued transaction must be verified before cancellation.",
      );
    await ctx.db.patch(a.id, { status: "cancelled" });
  },
});
