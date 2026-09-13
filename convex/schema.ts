import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  snapshots: defineTable({
    owner: v.string(),
    wallet: v.string(),
    payload: v.string(),
    updatedAt: v.number(),
  }).index("by_owner_wallet", ["owner", "wallet"]),
  plans: defineTable({
    owner: v.string(),
    wallet: v.string(),
    payload: v.string(),
    status: v.union(
      v.literal("quoted"),
      v.literal("executing"),
      v.literal("confirmed"),
    ),
    step: v.number(),
    hashes: v.array(v.string()),
    pendingHash: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_owner", ["owner"]),
  limits: defineTable({
    owner: v.string(),
    bucket: v.string(),
    start: v.number(),
    count: v.number(),
  }).index("by_owner_bucket", ["owner", "bucket"]),
});
