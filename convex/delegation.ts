"use node";
import { PrivyClient } from "@privy-io/node";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { owner, verifyWallet } from "./room";
import { paymentRules } from "../src/lib/delegation";
import type { PaymentPreview } from "../src/lib/policy";

function client() {
  if (!process.env.PRIVY_SIGNER_ID || !process.env.PRIVY_SIGNER_PRIVATE_KEY)
    throw new ConvexError(
      "Payment signer is not configured. Use wallet-confirmed payment.",
    );
  return new PrivyClient({
    appId: process.env.PRIVY_APP_ID!,
    appSecret: process.env.PRIVY_APP_SECRET!,
    timeout: 20000,
    maxRetries: 1,
  });
}
export const permission = action({
  args: { id: v.id("payments") },
  handler: async (
    ctx,
    a,
  ): Promise<{ signerId: string; policyId: string; expiresAt: number }> => {
    const subject = await owner(ctx, "delegation"),
      row = await ctx.runQuery(internal.paymentState.payment, {
        ...a,
        owner: subject,
      });
    await verifyWallet(subject, row.wallet);
    if (row.status !== "quoted" || row.expiresAt < Date.now())
      throw new ConvexError("Preview again before authorizing.");
    const privy = client();
    const embedded = await privy
      .wallets()
      .getWalletByAddress({ address: row.wallet });
    if (!embedded || embedded.address.toLowerCase() !== row.wallet)
      throw new ConvexError("Delegation requires a Privy embedded wallet.");
    const plan = JSON.parse(row.payload) as PaymentPreview;
    const policy = row.delegationPolicyId
      ? { id: row.delegationPolicyId }
      : await privy.policies().create({
          version: "1.0",
          chain_type: "ethereum",
          name: "Reviewed portfolio payment",
          owner: { user_id: subject },
          rules: paymentRules(plan),
          idempotency_key: `payment-policy-${row._id}`,
        });
    await ctx.runMutation(internal.paymentState.attachPolicy, {
      ...a,
      owner: subject,
      policyId: policy.id,
    });
    return {
      signerId: process.env.PRIVY_SIGNER_ID!,
      policyId: policy.id,
      expiresAt: row.expiresAt,
    };
  },
});
export const status = action({
  args: { id: v.id("payments") },
  handler: async (
    ctx,
    a,
  ): Promise<{ authorized: boolean; expiresAt: number; amount: string }> => {
    const subject = await owner(ctx, "delegation"),
      row = await ctx.runQuery(internal.paymentState.payment, {
        ...a,
        owner: subject,
      });
    await verifyWallet(subject, row.wallet);
    const embedded = await client()
      .wallets()
      .getWalletByAddress({ address: row.wallet });
    return {
      authorized:
        !!row.delegationPolicyId &&
        embedded.additional_signers.some(
          (s) =>
            s.signer_id === process.env.PRIVY_SIGNER_ID &&
            s.override_policy_ids?.length === 1 &&
            s.override_policy_ids[0] === row.delegationPolicyId,
        ) &&
        row.expiresAt > Date.now(),
      expiresAt: row.expiresAt,
      amount: row.amount,
    };
  },
});
export const sendStep = action({
  args: { id: v.id("payments"), step: v.number() },
  handler: async (ctx, a): Promise<{ hash: string }> => {
    const subject = await owner(ctx, "delegation"),
      row = await ctx.runQuery(internal.paymentState.payment, {
        id: a.id,
        owner: subject,
      });
    await verifyWallet(subject, row.wallet);
    if (
      row.status !== "active" ||
      row.step !== a.step ||
      !row.delegationPolicyId
    )
      throw new ConvexError("No active authorized payment step.");
    if (row.pendingHash) return { hash: row.pendingHash };
    const privy = client(),
      embedded = await privy
        .wallets()
        .getWalletByAddress({ address: row.wallet });
    if (
      !embedded.additional_signers.some(
        (s) =>
          s.signer_id === process.env.PRIVY_SIGNER_ID &&
          s.override_policy_ids?.length === 1 &&
          s.override_policy_ids[0] === row.delegationPolicyId,
      )
    )
      throw new ConvexError(
        "Approve this payment's restricted signer permission in your wallet first.",
      );
    const tx = await ctx.runAction(api.payments.prepare, {
      ...a,
      retry: row.issued,
    });
    const sent = await privy
      .wallets()
      .ethereum()
      .sendTransaction(embedded.id, {
        caip2: "eip155:8453",
        params: {
          transaction: {
            to: tx.to,
            data: tx.data,
            value: tx.value,
            chain_id: 8453,
            nonce: tx.nonce,
          },
        },
        authorization_context: {
          authorization_private_keys: [process.env.PRIVY_SIGNER_PRIVATE_KEY!],
        },
        idempotency_key: `payment-${row._id}-${a.step}`,
      });
    await ctx.runMutation(internal.paymentState.sentByServer, {
      ...a,
      owner: subject,
      hash: sent.hash,
    });
    return { hash: sent.hash };
  },
});
