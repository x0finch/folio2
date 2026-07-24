import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";
import {
  addManualActivities,
  deleteManualActivity,
  deleteToken,
  editManualActivity,
  loadManualAccountDetail,
} from "./manual";

// —— 读:抽屉账户明细(token 定义 + 折叠 amount + 全部活动)。抽屉 useQuery,写后失效刷新。
const AccountIdInput = z.object({ accountId: z.string().min(1) });
export const getManualAccountDetail = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(AccountIdInput)
  .handler(({ data, context }) => loadManualAccountDetail(context.userId, data.accountId));

// manual 写路径的 server fn(T3,#155)—— 薄壳:auth(requireAuth 经 ALS 带 userId)+ 校验入参 + 调 ./manual 的
// 纯 async 分派(决策/物化都在那层)。红线:只记安全字段,不打 creds(manual creds 全 public,但仍不入日志)。

const ActivityKind = z.enum(["add", "reduce", "set"]);

// —— token CRUD ——
const RemoveTokenInput = z.object({ tokenId: z.string().min(1) });
export const removeToken = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(RemoveTokenInput)
  .handler(async ({ data, context }) => {
    await deleteToken(context.userId, data.tokenId);
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
  fee: z.number().nonnegative().nullish(),
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
    fee: z.number().nonnegative().nullish(),
    occurredAt: z.number().int().optional(),
    memo: z.string().trim().nullish(),
  }),
});
export const editActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(EditActivityInput)
  .handler(({ data, context }) => editManualActivity(context.userId, data.activityId, data.patch));
