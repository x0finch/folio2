import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { addManualActivities, deleteManualActivity, editManualActivity } from "./manual/store";
import { runRequest } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";

// manual 活动账本资源(账户级)。薄壳:auth + 校验入参 + 调 ./manual 纯 async(决策/物化都在那层)。
const ActivityKind = z.enum(["add", "reduce", "set"]);

// 批量新增(原子 + 整批拒;也承载"新建 token"流 —— 首条活动落 token)。
const BatchDraftInput = z.object({
  token: z.object({
    symbol: z.string().trim().min(1),
    unitPrice: z.number().nonnegative(),
    // 选币下拉发的那张不透明票(#202b)。这一层只校验「是个非空串」—— 解票在 ./internal/manual,
    // 解不开就当没选币。
    ticket: z.string().trim().min(1).nullish(),
  }),
  kind: ActivityKind,
  amount: z.number().nonnegative(),
  occurredAt: z.number().int(),
  price: z.number().nonnegative().nullish(),
  fee: z.number().nonnegative().nullish(),
  memo: z.string().trim().nullish(),
});
const CreateActivitiesInput = z.object({
  accountId: z.string().min(1),
  drafts: z.array(BatchDraftInput).min(1),
});
export const createManualActivities = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateActivitiesInput)
  .handler(({ data, context }) =>
    runRequest(context.userId, addManualActivities(data.accountId, data.drafts)),
  );

const RemoveActivityInput = z.object({
  accountId: z.string().min(1),
  activityId: z.string().min(1),
});
export const removeManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveActivityInput)
  .handler(async ({ data, context }) => {
    await runRequest(context.userId, deleteManualActivity(data.accountId, data.activityId));
    return { ok: true as const };
  });

const UpdateActivityInput = z.object({
  activityId: z.string().min(1),
  patch: z.object({
    kind: ActivityKind.optional(),
    amount: z.number().nonnegative().optional(),
    price: z.number().nonnegative().nullish(),
    fee: z.number().nonnegative().nullish(),
    occurredAt: z.number().int().optional(),
    memo: z.string().trim().nullish(),
  }),
});
export const updateManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(UpdateActivityInput)
  .handler(({ data, context }) =>
    runRequest(context.userId, editManualActivity(data.activityId, data.patch)),
  );
