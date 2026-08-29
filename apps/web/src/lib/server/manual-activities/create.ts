import { Effect } from "effect";
import { z } from "zod";
import { addManualActivities } from "@/lib/server/manual/store";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";
import { OccurredAt } from "./occurred-at";

export const ActivityKind = z.enum(["add", "reduce", "set"]);

const BatchDraftInput = z.object({
  token: z.object({
    symbol: z.string().trim().min(1),
    unitPrice: z.number().nonnegative(),
    // 选币下拉发的那张不透明票(#202b)。这一层只校验「是个非空串」—— 解票在 ../manual/store,
    // 解不开就当没选币。
    ticket: z.string().trim().min(1).nullish(),
  }),
  kind: ActivityKind,
  amount: z.number().nonnegative(),
  occurredAt: OccurredAt,
  price: z.number().nonnegative().nullish(),
  fee: z.number().nonnegative().nullish(),
  memo: z.string().trim().nullish(),
});

export const CreateActivitiesInput = z.object({
  accountId: z.string().min(1),
  drafts: z.array(BatchDraftInput).min(1),
});

// 批量新增(原子 + 整批拒;也承载"新建 token"流 —— 首条活动落 token)。
// draft 形状直接取自 ../manual/store 的入参 —— 决策/物化都在那层,这里不复述一份会漂移的类型。
export const handleCreateManualActivities = Effect.fn("createManualActivities")(function* (data: {
  accountId: string;
  drafts: Parameters<typeof addManualActivities>[1];
}) {
  const result = yield* addManualActivities(data.accountId, data.drafts);
  // 组合的值变了 → 预计算的 24h 盈亏不再可信,就地标旧(ADR 0049;为什么标旧不是删,见那边)。
  // **整批拒的那一支一行都没落库**,不必标 —— 标了只是让下次读白补算一趟。
  if (result.ok) yield* invalidatePrecomputed();
  return result;
});
