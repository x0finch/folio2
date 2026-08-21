import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../session/require-auth";
import { handleCreateManualActivities } from "./create";
import { handleRemoveManualActivity } from "./remove";
import { handleUpdateManualActivity } from "./update";

// manual 活动账本资源面(账户级):只做装配(auth + 校验入参),决策/物化在 ../manual/store。
const ActivityKind = z.enum(["add", "reduce", "set"]);

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
  occurredAt: z.number().int(),
  price: z.number().nonnegative().nullish(),
  fee: z.number().nonnegative().nullish(),
  memo: z.string().trim().nullish(),
});

export const createManualActivities = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z.object({
      accountId: z.string().min(1),
      drafts: z.array(BatchDraftInput).min(1),
    }),
  )
  .handler(handleCreateManualActivities);

export const removeManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z.object({
      accountId: z.string().min(1),
      activityId: z.string().min(1),
    }),
  )
  .handler(handleRemoveManualActivity);

export const updateManualActivity = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z.object({
      activityId: z.string().min(1),
      patch: z.object({
        kind: ActivityKind.optional(),
        amount: z.number().nonnegative().optional(),
        price: z.number().nonnegative().nullish(),
        fee: z.number().nonnegative().nullish(),
        occurredAt: z.number().int().optional(),
        memo: z.string().trim().nullish(),
      }),
    }),
  )
  .handler(handleUpdateManualActivity);
