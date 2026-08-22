import { and, asc, eq, getTableColumns, type InferSelectModel, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Drizzle } from "../connect";
import { accounts, manualActivity, tokens } from "../schema";
import { DbClient } from "../stores/service";
import { holdingOps } from "./manual-holdings";
import { assertAccountOwned, assertTokenOwned } from "./ownership";

// 手记账本 —— 活动行(add / reduce / set)的写、读、改、删,以及「一次提交一批」。
//
// 数量不存,由账本折叠算出;折叠出来的持仓那半在 `manual-holdings.ts`。
//
// **`ManualStore` 是手记这个领域的**唯一**服务** —— 持仓与账本是同一件事的两面(持仓正是账本
// 折叠出来的),按能力切成两个服务会重蹈 #392 拆掉的那种分法。所以这里把两半合成一个。
// 方法签名里没有 userId(ADR 0037):由 `manualStoreLayer(userId)` 在装配那一刻吃掉。

export type ManualActivityKind = "add" | "reduce" | "set";
export interface ManualActivityInput {
  kind: ManualActivityKind;
  amount: number;
  price?: number | null;
  fee?: number | null; // 手续费 USD(可空;不参与折叠)
  occurredAt: number;
  memo?: string | null; // 用户手写备注(原 note;note 让给 provider 展示概念)
  // 仅导入用:保留原 created_at,好让同一 occurred_at 的活动折叠顺序(deriveAmount)不被打乱。
  // 常规写入不传 → 用当下时刻。
  createdAt?: number;
}
export type ManualActivity = InferSelectModel<typeof manualActivity>;

export interface ManualActivityPatch {
  kind?: ManualActivityKind;
  amount?: number;
  price?: number | null;
  fee?: number | null;
  occurredAt?: number;
  memo?: string | null;
}

export interface ManualBatchPlan {
  accountId: string;
  // 本批要**声明**的持仓:`id` 已经是 mint 出来的 `tokens.id`(app 层在提交前认好币),
  // 这里只落用户自己的两个字段。原来这叫 `newTokens` 并且真的插一张 `manual_token` 行 ——
  // 币的身份现在归参考层,不再由手记这条路创建。
  declare: { id: string; symbol: string }[];
  activities: {
    tokenId: string;
    kind: ManualActivityKind;
    amount: number;
    price?: number | null;
    fee?: number | null;
    occurredAt: number;
    memo?: string | null;
  }[];
}

// 活动 → {tokenId, accountId}(经 activity ⨝ account ⨝ user 归属校验;活动可能无 tokenId 的遗留行 → 抛)。
// 编辑活动前用它定位所属 token(取时间线校验)+ 账户(重跑物化)。
async function assertActivityOwned(
  db: Drizzle,
  userId: string,
  activityId: string,
): Promise<{ tokenId: string; accountId: string }> {
  const rows = await db
    .select({ tokenId: manualActivity.tokenId, accountId: manualActivity.accountId })
    .from(manualActivity)
    .innerJoin(accounts, eq(manualActivity.accountId, accounts.id))
    .where(and(eq(manualActivity.id, activityId), eq(accounts.userId, userId)));
  const row = rows[0];
  if (!row?.tokenId) throw new Error(`manual activity not found: ${activityId}`);
  return { tokenId: row.tokenId, accountId: row.accountId };
}

/** 服务的形状 —— 从 `make` 的返回值推导,不再手写一份复述(#501)。 */
export type ManualStore = Effect.Effect.Success<ReturnType<typeof make>>;

export const ManualStore = Context.GenericTag<ManualStore>("db/ManualStore");

const make = (userId: string) =>
  Effect.gen(function* () {
    const database = yield* DbClient;

    return {
      // —— 持仓(账本折叠出来的那一面,实现在 manual-holdings.ts)——
      ...holdingOps(database, userId),

      // —— 账本 ——

      /** 活动挂 (账户, token)。两道归属校验各自挡:账户属本人、token 属本人。 */
      // #203 起 **accountId 由调用方显式给** —— token 不再自带账户(`tokens` 是 per-user 的,
      // 一个币可以被多个手记账户持有),没法再从它反查。
      // 越权面靠两道归属校验各自挡。缺一道就能把活动挂到别人的东西上。
      recordActivity: (
        accountId: string,
        tokenId: string,
        input: ManualActivityInput,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* database.query((db) => assertAccountOwned(db, userId, accountId));
          yield* database.query((db) => assertTokenOwned(db, userId, tokenId));
          yield* database.query((db) =>
            db.insert(manualActivity).values({
              id: crypto.randomUUID(),
              accountId,
              tokenId,
              kind: input.kind,
              amount: input.amount,
              price: input.price ?? null,
              fee: input.fee ?? null,
              occurredAt: input.occurredAt,
              memo: input.memo ?? null,
              createdAt: input.createdAt ?? Date.now(),
            }),
          );
        }),

      /** 某账户对某个币的账本。**必须带 accountId** —— 同一 token 可被多个手记账户持有。 */
      // 按 occurred_at→created_at 升序(deriveAmount 据此定序)。只按 tokenId 取会把别的账户的
      // 活动一起折进来,数量直接算错 —— 所以 accountId 是必填。
      listActivityByToken: (accountId: string, tokenId: string): Effect.Effect<ManualActivity[]> =>
        Effect.gen(function* () {
          yield* database.query((db) => assertAccountOwned(db, userId, accountId));
          return yield* database.query((db) =>
            db
              .select(getTableColumns(manualActivity))
              .from(manualActivity)
              .where(
                and(eq(manualActivity.accountId, accountId), eq(manualActivity.tokenId, tokenId)),
              )
              .orderBy(asc(manualActivity.occurredAt), asc(manualActivity.createdAt)),
          );
        }),

      // userId-scoped(经 account ⨝ user 归属);按 occurred_at→created_at 升序。
      listActivityByAccount: (accountId: string): Effect.Effect<ManualActivity[]> =>
        database.query((db) =>
          db
            .select(getTableColumns(manualActivity))
            .from(manualActivity)
            .innerJoin(accounts, eq(manualActivity.accountId, accounts.id))
            .where(and(eq(manualActivity.accountId, accountId), eq(accounts.userId, userId)))
            .orderBy(asc(manualActivity.occurredAt), asc(manualActivity.createdAt)),
        ),

      /** 导出用:全部手记活动(跨账户,扁平)。 */
      // accountId / tokenId 都是导出侧的旧 id,导入时按各自的重映射改指。
      listAllActivity: (): Effect.Effect<ManualActivity[]> =>
        database.query((db) =>
          db
            .select(getTableColumns(manualActivity))
            .from(manualActivity)
            .innerJoin(accounts, eq(manualActivity.accountId, accounts.id))
            .where(eq(accounts.userId, userId))
            .orderBy(asc(manualActivity.occurredAt), asc(manualActivity.createdAt)),
        ),

      removeActivity: (accountId: string, id: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* database.query((db) => assertAccountOwned(db, userId, accountId));
          yield* database.query((db) =>
            db
              .delete(manualActivity)
              .where(and(eq(manualActivity.id, id), eq(manualActivity.accountId, accountId))),
          );
        }),

      /** 活动 → {tokenId, accountId}(公开读,归属校验)。编辑前用它取所属 token 校验超支。 */
      activityOwner: (activityId: string): Effect.Effect<{ tokenId: string; accountId: string }> =>
        database.query((db) => assertActivityOwned(db, userId, activityId)),

      /** 编辑一笔既有活动(保留 id/tokenId/accountId/createdAt;只覆盖给定字段)。 */
      // 归属经 assertActivityOwned;超支校验在 app 层(改前折叠受影响 token 时间线)。
      updateActivity: (
        activityId: string,
        patch: ManualActivityPatch,
      ): Effect.Effect<{ tokenId: string; accountId: string }> =>
        Effect.gen(function* () {
          const owner = yield* database.query((db) => assertActivityOwned(db, userId, activityId));
          const set: Partial<InferSelectModel<typeof manualActivity>> = {};
          if (patch.kind !== undefined) set.kind = patch.kind;
          if (patch.amount !== undefined) set.amount = patch.amount;
          if (patch.price !== undefined) set.price = patch.price;
          if (patch.fee !== undefined) set.fee = patch.fee;
          if (patch.occurredAt !== undefined) set.occurredAt = patch.occurredAt;
          if (patch.memo !== undefined) set.memo = patch.memo;
          // 空 patch → 无字段可写。drizzle 对空 set 会抛 "No values to set" → 直接短路(归属已校验)。
          if (Object.keys(set).length > 0) {
            yield* database.query((db) =>
              db.update(manualActivity).set(set).where(eq(manualActivity.id, activityId)),
            );
          }
          return owner;
        }),

      /** 批量提交写计划(app 层 planManualBatch 产出):落持仓声明 + 插入活动,**整批原子**。 */
      // 归属:assertAccountOwned + 校验每条活动的 tokenId **属于本人**。
      // 注意闸口从「∈ 该账户既有 token」改成了「∈ 本人的 token」—— 账户与币的关系现在**由活动本身承载**,
      // 拿它当前置条件会循环:一个刚声明的持仓在本批插入之前一条活动都没有。
      // 用户维度的闸仍然严格:拿别人的 tokenId 来照样抛。
      // 活动 createdAt = now + i 保提交序(同 occurredAt 处新活动恒排在既有之后,与 planManualBatch 定序一致)。
      commitBatch: (plan: ManualBatchPlan): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* database.query((db) => assertAccountOwned(db, userId, plan.accountId));
          const ids = [
            ...new Set([
              ...plan.declare.map((t) => t.id),
              ...plan.activities.map((a) => a.tokenId),
            ]),
          ];
          if (ids.length > 0) {
            const owned = yield* database.query((db) =>
              db
                .select({ id: tokens.id })
                .from(tokens)
                .where(and(eq(tokens.userId, userId), inArray(tokens.id, ids))),
            );
            const ok = new Set(owned.map((r) => r.id));
            for (const id of ids) {
              if (!ok.has(id)) return yield* Effect.die(new Error(`token not owned: ${id}`));
            }
          }
          const now = Date.now();
          yield* database.batch((db) => [
            ...plan.declare.map((t) =>
              db
                .update(tokens)
                .set({ symbol: t.symbol })
                .where(and(eq(tokens.id, t.id), eq(tokens.userId, userId))),
            ),
            ...plan.activities.map((a, i) =>
              db.insert(manualActivity).values({
                id: crypto.randomUUID(),
                accountId: plan.accountId,
                tokenId: a.tokenId,
                kind: a.kind,
                amount: a.amount,
                price: a.price ?? null,
                fee: a.fee ?? null,
                occurredAt: a.occurredAt,
                memo: a.memo ?? null,
                createdAt: now + i,
              }),
            ),
          ]);
        }),
    };
  });

export const manualStoreLayer = (userId: string): Layer.Layer<ManualStore, never, DbClient> =>
  Layer.effect(ManualStore, make(userId));
