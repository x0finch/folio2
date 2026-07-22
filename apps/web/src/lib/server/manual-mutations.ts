import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";
import {
  addManualActivities,
  createHolding,
  deleteHolding,
  deleteManualActivity,
  editManualActivity,
  updateHolding,
} from "./manual";

// manual 写路径的 server fn(T3,#155)—— 薄壳:auth(requireAuth 经 ALS 带 userId)+ 校验入参 + 调 ./manual 的
// 纯 async 分派(决策/物化都在那层)。红线:只记安全字段,不打 creds(manual creds 全 public,但仍不入日志)。

const ActivityKind = z.enum(["add", "reduce", "set"]);

// —— holding(token)CRUD ——
const HoldingInput = z.object({
  accountId: z.string().min(1),
  symbol: z.string().trim().min(1),
  unitPrice: z.number().nonnegative(),
  identifier: z.string().trim().min(1).nullish(),
  amount: z.number().nonnegative(),
});
export const addHolding = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(HoldingInput)
  .handler(({ data, context }) => createHolding(context.userId, data));

const HoldingEdit = z.object({
  tokenId: z.string().min(1),
  symbol: z.string().trim().min(1),
  unitPrice: z.number().nonnegative(),
  identifier: z.string().trim().min(1).nullish(),
  amount: z.number().nonnegative(),
});
export const editHolding = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(HoldingEdit)
  .handler(async ({ data, context }) => {
    await updateHolding(context.userId, data);
    return { ok: true as const };
  });

const RemoveHoldingInput = z.object({ tokenId: z.string().min(1) });
export const removeHolding = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveHoldingInput)
  .handler(async ({ data, context }) => {
    await deleteHolding(context.userId, data.tokenId);
    return { ok: true as const };
  });

// —— 活动:批量加(原子 + 整批拒)/ 删 / 改 ——
const BatchDraftInput = z.object({
  token: z.object({
    symbol: z.string().trim().min(1),
    unitPrice: z.number().nonnegative(),
    identifier: z.string().trim().min(1).nullish(),
  }),
  kind: ActivityKind,
  amount: z.number().nonnegative(),
  occurredAt: z.number().int(),
  price: z.number().nonnegative().nullish(),
  memo: z.string().trim().nullish(),
});
const AddActivitiesInput = z.object({
  accountId: z.string().min(1),
  drafts: z.array(BatchDraftInput).min(1),
});
export const addActivities = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AddActivitiesInput)
  .handler(({ data, context }) => addManualActivities(context.userId, data.accountId, data.drafts));

const DeleteActivityInput = z.object({
  accountId: z.string().min(1),
  activityId: z.string().min(1),
});
export const removeActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(DeleteActivityInput)
  .handler(async ({ data, context }) => {
    await deleteManualActivity(context.userId, data.accountId, data.activityId);
    return { ok: true as const };
  });

const EditActivityInput = z.object({
  activityId: z.string().min(1),
  patch: z.object({
    kind: ActivityKind.optional(),
    amount: z.number().nonnegative().optional(),
    price: z.number().nonnegative().nullish(),
    occurredAt: z.number().int().optional(),
    memo: z.string().trim().nullish(),
  }),
});
export const editActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(EditActivityInput)
  .handler(({ data, context }) => editManualActivity(context.userId, data.activityId, data.patch));
