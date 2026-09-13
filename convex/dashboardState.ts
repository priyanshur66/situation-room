import { internalMutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";

export const list = query({
  args: { wallet: v.string() },
  handler: async (ctx, a) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return ctx.db
      .query("dashboards")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", identity.subject).eq("wallet", a.wallet.toLowerCase()),
      )
      .order("desc")
      .take(12);
  },
});
export const save = internalMutation({
  args: {
    owner: v.string(),
    wallet: v.string(),
    title: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query("dashboards")
      .withIndex("by_owner_wallet", (q) =>
        q.eq("owner", a.owner).eq("wallet", a.wallet),
      )
      .take(12);
    const same = existing.find((x) => x.title === a.title);
    if (same)
      return await ctx.db.patch(same._id, {
        payload: a.payload,
        updatedAt: Date.now(),
      });
    if (existing.length >= 12)
      throw new ConvexError(
        "Twelve views are saved. Use an existing view's title to replace it.",
      );
    return await ctx.db.insert("dashboards", { ...a, updatedAt: Date.now() });
  },
});
