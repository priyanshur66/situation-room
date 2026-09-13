"use node";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { owner, verifyWallet } from "./room";
import { generateDashboard } from "../src/lib/dashboard-generator";
import {
  validateDashboard,
  type DashboardSpec,
} from "../src/lib/dashboard-spec";

export const generate = action({
  args: { wallet: v.string(), instruction: v.string() },
  handler: async (ctx, a): Promise<DashboardSpec> => {
    const subject = await owner(ctx, "assistant");
    await verifyWallet(subject, a.wallet);
    try {
      return await generateDashboard(a.instruction);
    } catch {
      throw new ConvexError(
        "Could not build this view. Use a short request about supported balances, exposure, pool history or recent activity.",
      );
    }
  },
});
export const save = action({
  args: { wallet: v.string(), payload: v.string() },
  handler: async (ctx, a) => {
    const subject = await owner(ctx, "dashboard"),
      wallet = await verifyWallet(subject, a.wallet);
    if (a.payload.length > 6000)
      throw new ConvexError("Dashboard configuration is too large.");
    const spec = validateDashboard(JSON.parse(a.payload));
    await ctx.runMutation(internal.dashboardState.save, {
      owner: subject,
      wallet,
      payload: JSON.stringify(spec),
      title: spec.title,
    });
    return true;
  },
});
