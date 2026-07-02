import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { deriveAmount } from "../manual-activity";
import { requireAuth } from "../require-auth";
import { db } from "./db";

const log = getLogger(["folio", "web", "manual-activity"]);

// 账户须存在、属本人、type=manual(否则抛)。
async function assertManual(userId: string, accountId: string): Promise<void> {
  const account = await db.getAccountById(userId, accountId);
  if (account?.type !== "manual") throw new Error("manual account not found");
}

// 重算账本 → 把当前数量物化进 creds.amount(保留 symbol/unitPrice)。manual creds 全 public、明文 JSON。
// 维护不变量 creds.amount === deriveAmount(activities)(单写者)。
async function materializeAmount(userId: string, accountId: string): Promise<number> {
  const amount = deriveAmount(await db.listManualActivityByAccount(userId, accountId));
  const raw = await db.getRawCreds(userId, accountId);
  const creds: Record<string, string> = raw ? JSON.parse(raw) : {};
  creds.amount = String(amount);
  await db.setAccountCredentials(userId, accountId, JSON.stringify(creds));
  return amount;
}

const AddInput = z.object({
  accountId: z.string().min(1),
  kind: z.enum(["add", "reduce", "set"]),
  amount: z.coerce.number(),
  price: z.coerce.number().nonnegative().optional(),
  occurredAt: z.coerce.number().optional(),
  note: z.string().trim().max(200).optional(),
});

export const addManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AddInput)
  .handler(async ({ data, context }) => {
    await assertManual(context.userId, data.accountId);
    // 数量校验:add/reduce > 0、set ≥ 0;reduce 不得超过当前持有。
    if (data.kind === "set" ? data.amount < 0 : data.amount <= 0) {
      throw new Error("amount must be positive");
    }
    if (data.kind === "reduce") {
      const current = deriveAmount(
        await db.listManualActivityByAccount(context.userId, data.accountId),
      );
      if (data.amount > current) throw new Error("cannot reduce more than held");
    }
    await db.recordManualActivity(context.userId, data.accountId, {
      kind: data.kind,
      amount: data.amount,
      price: data.price ?? null,
      occurredAt: data.occurredAt ?? Date.now(),
      note: data.note ?? null,
    });
    const amount = await materializeAmount(context.userId, data.accountId);
    log.info("manual activity added", { accountId: data.accountId, kind: data.kind });
    return { amount };
  });

export const deleteManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ accountId: z.string().min(1), id: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    await assertManual(context.userId, data.accountId);
    await db.removeManualActivity(context.userId, data.accountId, data.id);
    const amount = await materializeAmount(context.userId, data.accountId);
    return { amount };
  });

export const listManualActivity = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ accountId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    await assertManual(context.userId, data.accountId);
    return db.listManualActivityByAccount(context.userId, data.accountId);
  });
