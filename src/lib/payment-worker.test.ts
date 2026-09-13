import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../../convex/_generated/server";
import {
  begin as registeredBegin,
  finish as registeredFinish,
  queuePayment,
  resume as registeredResume,
  watch as registeredWatch,
} from "../../convex/paymentWorkerState";
import { run as registeredRun } from "../../convex/paymentWorker";
import { sendDelegated } from "../../convex/delegation";
import { confirmPayment } from "../../convex/payments";

vi.mock("../../convex/delegation", () => ({ sendDelegated: vi.fn() }));
vi.mock("../../convex/payments", () => ({ confirmPayment: vi.fn() }));

// Convex exposes the handler at runtime for direct unit tests, but excludes it
// from its public registration types. Keep that test-only boundary here.
function handler<C, A, R>(registered: unknown) {
  return registered as { _handler: (ctx: C, args: A) => Promise<R> };
}
type JobArgs = { id: Id<"payments">; generation: number };
const begin = handler<MutationCtx, JobArgs, Doc<"payments"> | null>(
  registeredBegin,
);
const finish = handler<MutationCtx, JobArgs & { failed: boolean }, void>(
  registeredFinish,
);
const watch = handler<MutationCtx, JobArgs, void>(registeredWatch);
const resume = handler<MutationCtx, { id: Id<"payments"> }, void>(
  registeredResume,
);
const run = handler<ActionCtx, JobArgs, void>(registeredRun);

function setup(overrides: Partial<Doc<"payments">> = {}) {
  const row = {
    _id: "payment-test",
    _creationTime: 0,
    owner: "user-test",
    wallet: "0x" + "1".repeat(40),
    preferenceId: "preference-test",
    payload: "{}",
    amount: "5",
    status: "active",
    createdAt: 0,
    expiresAt: Date.now() + 60000,
    step: 0,
    hashes: [],
    issued: false,
    delegationPolicyId: "policy-test",
    background: true,
    workerGeneration: 1,
    workerState: "queued",
    workerStep: 0,
    workerAttempts: 1,
    workerJob: "job-test",
    ...overrides,
  } as Doc<"payments">;
  const patch = vi.fn(async (_id, value) => {
    Object.assign(row, value);
  });
  const systemGet = vi.fn(async () => ({ state: { kind: "failed" } }));
  const scheduled = vi.fn(
    async (_delay: number, ..._args: unknown[]) => "job-next",
  );
  const ctx = {
    db: { get: vi.fn(async () => row), patch, system: { get: systemGet } },
    scheduler: { runAfter: scheduled },
    auth: { getUserIdentity: vi.fn(async () => ({ subject: "user-test" })) },
  } as unknown as MutationCtx;
  return {
    row,
    ctx,
    patch,
    scheduled,
    systemGet,
    a: { id: row._id, generation: 1 },
  };
}

describe("durable payment checkpoints", () => {
  it("atomically schedules a step and a watchdog with a new generation", async () => {
    const s = setup();
    await queuePayment(s.ctx, s.row, 0);
    expect(s.row.workerGeneration).toBe(2);
    expect(s.row.workerState).toBe("queued");
    expect(s.scheduled.mock.calls.map((c) => c[0])).toEqual([0, 60000]);
    expect(s.row.workerJob).toBe("job-next");
  });
  it("does not claim an obsolete, duplicate, cancelled or manual job", async () => {
    for (const overrides of [
      { workerGeneration: 2 },
      { workerState: "running" },
      { status: "cancelled" },
      { background: false },
    ] as Partial<Doc<"payments">>[]) {
      const s = setup(overrides);
      expect(await begin._handler(s.ctx, s.a)).toBeNull();
      expect(s.patch).not.toHaveBeenCalled();
    }
    const s = setup();
    expect(await begin._handler(s.ctx, s.a)).not.toBeNull();
    expect(s.row.workerState).toBe("running");
    expect(await begin._handler(s.ctx, s.a)).toBeNull();
  });
  it("advances after a persisted receipt even if the action lost its response", async () => {
    const s = setup({ workerState: "running", step: 1, workerAttempts: 3 });
    await finish._handler(s.ctx, { ...s.a, failed: true });
    expect(s.row.workerStep).toBe(1);
    expect(s.row.workerAttempts).toBe(1);
    expect(s.row.workerState).toBe("queued");
  });
  it("never automatically resends an issued transaction with an unknown hash", async () => {
    const s = setup({ workerState: "running", issued: true });
    await finish._handler(s.ctx, { ...s.a, failed: true });
    expect(s.row.workerState).toBe("attention");
    expect(s.scheduled).not.toHaveBeenCalled();
    await expect(resume._handler(s.ctx, { id: s.row._id })).rejects.toThrow(
      "Recover",
    );
  });
  it("retries receipt checks with a cap and preserves the submitted hash", async () => {
    const s = setup({
      workerState: "running",
      issued: true,
      pendingHash: "0xabc",
    });
    await finish._handler(s.ctx, { ...s.a, failed: true });
    expect(s.row.pendingHash).toBe("0xabc");
    expect(s.row.workerAttempts).toBe(2);
    expect(s.scheduled.mock.calls[0][0]).toBe(10000);
    const capped = setup({
      workerState: "running",
      issued: true,
      pendingHash: "0xabc",
      workerAttempts: 3,
    });
    await finish._handler(capped.ctx, { ...capped.a, failed: true });
    expect(capped.row.workerState).toBe("attention");
    expect(capped.scheduled).not.toHaveBeenCalled();
  });
  it("stops scheduling completed or reverted payments", async () => {
    for (const status of ["confirmed", "cancelled"] as const) {
      const s = setup({ workerState: "running", status });
      await finish._handler(s.ctx, { ...s.a, failed: false });
      expect(s.row.workerState).toBe("done");
      expect(s.scheduled).not.toHaveBeenCalled();
    }
  });
  it("watches a live scheduler job without restarting it", async () => {
    const s = setup({ workerState: "running" });
    s.systemGet.mockResolvedValue({ state: { kind: "inProgress" } });
    await watch._handler(s.ctx, s.a);
    expect(s.row.workerGeneration).toBe(1);
    expect(s.scheduled).toHaveBeenCalledTimes(1);
    expect(s.scheduled.mock.calls[0][0]).toBe(60000);
  });
  it("recovers a terminal worker failure and ignores old watchdogs", async () => {
    const s = setup({ workerState: "running" });
    await watch._handler(s.ctx, s.a);
    expect(s.row.workerGeneration).toBe(2);
    s.scheduled.mockClear();
    await watch._handler(s.ctx, s.a);
    expect(s.scheduled).not.toHaveBeenCalled();
  });
  it("requires the owner and an attention state for explicit resume", async () => {
    const s = setup({ workerState: "attention", owner: "another-user" });
    await expect(resume._handler(s.ctx, { id: s.row._id })).rejects.toThrow(
      "not found",
    );
    s.row.owner = "user-test";
    await resume._handler(s.ctx, { id: s.row._id });
    expect(s.row.workerAttempts).toBe(1);
    await expect(resume._handler(s.ctx, { id: s.row._id })).rejects.toThrow(
      "not paused",
    );
  });
});

describe("server step runner", () => {
  beforeEach(() => vi.clearAllMocks());
  it("sends and verifies exactly one step before checkpointing", async () => {
    const s = setup();
    const mutation = vi
      .fn()
      .mockResolvedValueOnce(s.row)
      .mockResolvedValue(undefined);
    const ctx = { runMutation: mutation } as unknown as ActionCtx;
    vi.mocked(sendDelegated).mockResolvedValue({ hash: "0xabc" });
    vi.mocked(confirmPayment).mockResolvedValue({
      complete: false,
      reverted: false,
    });
    await run._handler(ctx, s.a);
    expect(sendDelegated).toHaveBeenCalledWith(
      ctx,
      s.row.owner,
      { id: s.row._id, step: 0 },
      true,
    );
    expect(confirmPayment).toHaveBeenCalledWith(ctx, s.row.owner, {
      id: s.row._id,
      step: 0,
      hash: "0xabc",
    });
    expect(mutation.mock.calls[1][1]).toEqual({ ...s.a, failed: false });
  });
  it("only checks the receipt when a hash has already been persisted", async () => {
    const s = setup({ issued: true, pendingHash: "0xabc" });
    const mutation = vi
      .fn()
      .mockResolvedValueOnce(s.row)
      .mockResolvedValue(undefined);
    const ctx = { runMutation: mutation } as unknown as ActionCtx;
    vi.mocked(confirmPayment).mockRejectedValue(
      new Error("request body must not be stored"),
    );
    await run._handler(ctx, s.a);
    expect(sendDelegated).not.toHaveBeenCalled();
    expect(mutation.mock.calls[1][1]).toEqual({ ...s.a, failed: true });
  });
  it("performs no network actions for an unclaimed job", async () => {
    const ctx = {
      runMutation: vi.fn().mockResolvedValue(null),
    } as unknown as ActionCtx;
    await run._handler(ctx, setup().a);
    expect(sendDelegated).not.toHaveBeenCalled();
    expect(confirmPayment).not.toHaveBeenCalled();
  });
});
