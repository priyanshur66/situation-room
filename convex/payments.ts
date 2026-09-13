"use node";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { erc20Abi, getAddress, parseEventLogs, type Hex } from "viem";
import { owner, verifyWallet, snapshotFor } from "./room";
import { rpc, contracts } from "../src/lib/chain";
import { parseAmount } from "../src/lib/model";
import {
  defaultPolicy,
  policySchema,
  policyMessage,
  validatePolicy,
  type LiquidationPolicy,
  type PaymentPreview,
  type PaymentTransaction,
} from "../src/lib/policy";
import { previewPayment } from "../src/lib/payments";
import { verifyLiquidationReceipt } from "../src/lib/payment-receipt";

export const interpret = action({
  args: { wallet: v.string(), instruction: v.string() },
  handler: async (ctx, a): Promise<LiquidationPolicy> => {
    const subject = await owner(ctx, "assistant"),
      wallet = await verifyWallet(subject, a.wallet);
    if (!a.instruction.trim() || a.instruction.length > 2000)
      throw new ConvexError(
        "Enter preferences using at most 2,000 characters.",
      );
    const current = await ctx.runQuery(internal.paymentState.approved, {
      owner: subject,
      wallet,
    });
    const response = await new OpenAI({
      timeout: 30000,
      maxRetries: 1,
    }).responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      store: false,
      max_output_tokens: 1000,
      instructions: `Translate user liquidation preferences into the schema. You do not authorize transactions. Preserve existing settings unless explicitly changed. Asset symbols uppercase; protected assets may also be exact contract addresses. Never silently drop an instruction you cannot enforce: put it in unresolved. Supported: protected assets, positive-profit-only, maximum loss percentage, highest-profit / smallest-loss / lowest-cost ordering, per-payment and daily USDC limits. Do not promise profit. Unknown cost basis blocks PnL rules. Risk appetite such as 'medium risk' is ambiguous: put it in unresolved and ask for an explicit loss limit. Defaults/current policy: ${current?.payload ?? JSON.stringify(defaultPolicy)}. No asset selection, wallet permission or signing is performed here.`,
      input: a.instruction,
      text: {
        format: {
          type: "json_schema",
          name: "liquidation_preferences",
          strict: true,
          schema: policySchema,
        },
      },
    });
    if (response.status !== "completed" || !response.output_text)
      throw new ConvexError(
        "Could not interpret all preferences. Please try again.",
      );
    return validatePolicy(JSON.parse(response.output_text));
  },
});
export const challenge = action({
  args: { wallet: v.string(), payload: v.string() },
  handler: async (
    ctx,
    a,
  ): Promise<{ id: Id<"preferences">; message: string }> => {
    const subject = await owner(ctx, "preferences"),
      wallet = await verifyWallet(subject, a.wallet);
    const policy = validatePolicy(JSON.parse(a.payload));
    if (policy.unresolved.length)
      throw new ConvexError("Resolve unsupported instructions before saving.");
    const expiresAt = Date.now() + 600000,
      message = policyMessage(wallet, randomUUID(), expiresAt, policy);
    const id = await ctx.runMutation(internal.paymentState.draft, {
      owner: subject,
      wallet,
      payload: JSON.stringify(policy),
      message,
      expiresAt,
    });
    return { id, message };
  },
});
export const save = action({
  args: { id: v.id("preferences"), signature: v.string() },
  handler: async (ctx, a) => {
    const subject = await owner(ctx, "preferences"),
      row = await ctx.runQuery(internal.paymentState.preference, {
        id: a.id,
        owner: subject,
      });
    await verifyWallet(subject, row.wallet);
    if (
      !(await rpc().verifyMessage({
        address: getAddress(row.wallet),
        message: row.message,
        signature: a.signature as Hex,
      }))
    )
      throw new ConvexError(
        "Wallet signature did not match this preference challenge.",
      );
    await ctx.runMutation(internal.paymentState.approve, {
      ...a,
      owner: subject,
    });
  },
});
export const preview = action({
  args: {
    wallet: v.string(),
    recipient: v.string(),
    amount: v.string(),
    delegated: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<PaymentPreview & { id: Id<"payments"> }> => {
    const subject = await owner(ctx, "payment"),
      wallet = await verifyWallet(subject, a.wallet);
    const pref = await ctx.runQuery(internal.paymentState.approved, {
      owner: subject,
      wallet,
    });
    if (!pref)
      throw new ConvexError("Review and sign liquidation preferences first.");
    const snapshot = await snapshotFor(ctx, subject, wallet);
    try {
      const plan = await previewPayment(
        snapshot,
        a.recipient,
        a.amount,
        validatePolicy(JSON.parse(pref.payload)),
        a.delegated,
      );
      const id = await ctx.runMutation(internal.paymentState.create, {
        owner: subject,
        wallet,
        preferenceId: pref._id,
        payload: JSON.stringify(plan),
        amount: a.amount,
        expiresAt: plan.expiresAt,
      });
      return { ...plan, id };
    } catch (error) {
      throw new ConvexError(
        error instanceof Error ? error.message : "Payment preview failed.",
      );
    }
  },
});
export const prepare = action({
  args: {
    id: v.id("payments"),
    step: v.number(),
    retry: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<PaymentTransaction & { nonce: number }> => {
    return preparePayment(ctx, await owner(ctx, "payment"), a);
  },
});

export async function preparePayment(
  ctx: ActionCtx,
  subject: string,
  a: { id: Id<"payments">; step: number; retry?: boolean },
  background = false,
): Promise<PaymentTransaction & { nonce: number }> {
  const row = await ctx.runQuery(internal.paymentState.payment, {
    id: a.id,
    owner: subject,
  });
  await verifyWallet(subject, row.wallet);
  if (row.background && !background)
    throw new ConvexError("This payment is managed by the background worker.");
  const plan = JSON.parse(row.payload) as PaymentPreview,
    tx = plan.transactions[a.step];
  if (
    !tx ||
    row.status !== "active" ||
    row.step !== a.step ||
    (row.issued && (!a.retry || row.pendingHash)) ||
    tx.expiresAt < Date.now()
  )
    throw new ConvexError(
      "Payment step is expired, already issued, or not ready.",
    );
  const latest = await ctx.runQuery(internal.paymentState.approved, {
    owner: subject,
    wallet: row.wallet,
  });
  if (latest?._id !== row.preferenceId)
    throw new ConvexError(
      "Preferences changed. Stop and preview a new payment.",
    );
  try {
    await rpc().call({
      account: getAddress(row.wallet),
      to: tx.to as Hex,
      data: tx.data as Hex,
      value: BigInt(tx.value),
    });
  } catch {
    throw new ConvexError(
      "This payment step no longer simulates successfully. No transaction was issued.",
    );
  }
  const nonce = row.issued
    ? row.nonce!
    : await rpc().getTransactionCount({
        address: getAddress(row.wallet),
        blockTag: "pending",
      });
  if (
    row.issued &&
    (await rpc().getTransactionCount({
      address: getAddress(row.wallet),
      blockTag: "latest",
    })) > nonce
  )
    throw new ConvexError(
      "The reserved nonce was mined. Recover its transaction hash instead of retrying.",
    );
  if (!row.issued)
    await ctx.runMutation(internal.paymentState.issue, {
      id: a.id,
      step: a.step,
      owner: subject,
      nonce,
    });
  return { ...tx, nonce };
}
export const confirm = action({
  args: { id: v.id("payments"), step: v.number(), hash: v.string() },
  handler: async (
    ctx,
    a,
  ): Promise<{ complete: boolean; reverted: boolean }> => {
    return confirmPayment(ctx, await owner(ctx, "payment"), a);
  },
});

export async function confirmPayment(
  ctx: ActionCtx,
  subject: string,
  a: { id: Id<"payments">; step: number; hash: string },
): Promise<{ complete: boolean; reverted: boolean }> {
  const row = await ctx.runQuery(internal.paymentState.payment, {
    id: a.id,
    owner: subject,
  });
  if (row.hashes[a.step] === a.hash)
    return {
      complete: row.status === "confirmed",
      reverted: row.status === "cancelled",
    };
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.hash) || row.step !== a.step || !row.issued)
    throw new ConvexError("Unexpected payment confirmation.");
  const plan = JSON.parse(row.payload) as PaymentPreview,
    expected = plan.transactions[a.step],
    client = rpc();
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: a.hash as Hex }),
    client.waitForTransactionReceipt({
      hash: a.hash as Hex,
      confirmations: 2,
      timeout: 55000,
    }),
  ]);
  if (
    tx.nonce !== row.nonce ||
    tx.from.toLowerCase() !== row.wallet ||
    tx.to?.toLowerCase() !== expected.to.toLowerCase() ||
    tx.input.toLowerCase() !== expected.data.toLowerCase() ||
    tx.value !== BigInt(expected.value)
  )
    throw new ConvexError("Transaction does not match this payment step.");
  const reverted = receipt.status !== "success";
  if (!reverted && expected.kind === "swap") {
    try {
      verifyLiquidationReceipt(row.wallet, expected, receipt.logs);
    } catch {
      throw new ConvexError(
        "Liquidation receipt does not prove the approved minimum USDC output. Payment has not advanced.",
      );
    }
  }
  if (!reverted && expected.kind === "payment") {
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs.filter(
        (l) => l.address.toLowerCase() === contracts.usdc.toLowerCase(),
      ),
    });
    if (
      !transfers.some(
        (t) =>
          t.args.from.toLowerCase() === row.wallet &&
          t.args.to.toLowerCase() === plan.recipient.toLowerCase() &&
          t.args.value === parseAmount(plan.amount, 6),
      )
    )
      throw new ConvexError(
        "Recipient USDC payment was not found in the receipt.",
      );
  }
  await ctx.runMutation(internal.paymentState.record, {
    ...a,
    owner: subject,
    reverted,
  });
  return {
    complete: !reverted && a.step + 1 === plan.transactions.length,
    reverted,
  };
}
