import { and, asc, eq, isNull, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  accounts,
  manualActivity,
  portfolioAccounts,
  snapshots,
  tokenRefs,
  tokens,
} from "../schema";
import { DbClient } from "../stores/service";
import type { CreateAccountInput } from "./accounts";
import { type ManualActivityInput, ManualStore } from "./manual-activity";
import { assertAccountOwned, assertTokenOwned } from "./ownership";
import { ensureDefault } from "./portfolios";
import { SnapshotStore, type WriteSnapshotInput } from "./snapshots";

// 导出 / 导入 v3(#204):Token 行 + 它的 ref 随文件走。
//
// **服务的方法签名里没有 userId**(ADR 0037):由 `transferStoreLayer(userId)` 在装配那一刻吃掉。
//
// **它依赖 `SnapshotStore` 与 `ManualStore`** —— 导快照/导活动本来就是「查重之后调那一个写」,
// 而两个写口连同它们的归属校验都已经在那两个服务里。layer 因此声明这两个依赖(不是方法的 `R`:
// 服务对外的 `R` 仍是 `never`,两个依赖在建服务那一刻就解析好进了闭包)。
// T2 留在本模块的那个 `runFor` 过渡桥随之删掉。

// 导出一个用户的 Token(ref 嵌在里头)。**价 facet 与 TTL 不导** —— 市场数据可重取;
// `self_price` 也不导 —— 迁移 0016 后它已无写者(手记声明价在账本的 `price` 列,随活动导)。
export interface ExportToken {
  id: string;
  symbol: string;
  name: string;
  logo: string | null;
  providerLogo: string | null;
  marketCapRank: number | null;
  refs: { namer: string; localName: string }[];
}

export interface ImportTokenInput {
  symbol: string;
  name: string;
  logo?: string | null;
  providerLogo?: string | null;
  marketCapRank?: number | null;
}

/** 服务的形状 —— 从 `make` 的返回值推导,不再手写一份复述(#501)。 */
export type TransferStore = Effect.Effect.Success<ReturnType<typeof make>>;

export const TransferStore = Context.GenericTag<TransferStore>("db/TransferStore");

// —— 合并式导入(#204,A 方案):按内容自然键 find-or-create,让「反复导入 / 合并不同文件」幂等。 ——
// 全程用**新 id**(不碰全局 id 主键,多用户安全);去重靠 per-user 自然键。原样再导一遍 = 命中既有、不新建。
const make = (userId: string) =>
  Effect.gen(function* () {
    const database = yield* DbClient;
    const snapshotStore = yield* SnapshotStore;
    const manualStore = yield* ManualStore;

    return {
      listTokensForExport: (): Effect.Effect<ExportToken[]> =>
        Effect.gen(function* () {
          const rows = yield* database.query((db) =>
            db
              .select({
                id: tokens.id,
                symbol: tokens.symbol,
                name: tokens.name,
                logo: tokens.logo,
                providerLogo: tokens.providerLogo,
                marketCapRank: tokens.marketCapRank,
              })
              .from(tokens)
              .where(eq(tokens.userId, userId))
              .orderBy(asc(tokens.id)),
          );
          if (rows.length === 0) return [];
          const refRows = yield* database.query((db) =>
            db
              .select({
                tokenId: tokenRefs.tokenId,
                namer: tokenRefs.namer,
                localName: tokenRefs.localName,
              })
              .from(tokenRefs)
              .where(eq(tokenRefs.userId, userId)),
          );
          const byToken = new Map<string, { namer: string; localName: string }[]>();
          for (const r of refRows) {
            const ref = { namer: r.namer, localName: r.localName };
            const arr = byToken.get(r.tokenId);
            if (arr) arr.push(ref);
            else byToken.set(r.tokenId, [ref]);
          }
          return rows.map((t) => ({ ...t, refs: byToken.get(t.id) ?? [] }));
        }),

      /**
       * 导入一个 Token:**find-or-create**。它的任一 ref 已在本地映射到某 Token → 复用那行(把缺的 ref
       * 补挂过去);否则新建一行(新 id,不跟本地已有撞)+ 挂上全部 ref。返回最终 token_id,供调用方建
       * old→new 映射。空库导入是最常见路径:恒无命中 → 每个 Token 各建新行。
       *
       * **已知限制(仅非空库的分叉场景)**:若这批 ref 分别命中本地**不同**的 Token(源库把多链归并成一行、
       * 目标库却各自建了行),这里按第一条命中复用、其余 ref 撞约束被静默跳过 → 文件里那个 Token 的身份被
       * 部分并到一行上。**这条经导入路径根本走不到** —— 导入有空库闸(见 apps/web import.ts),只往空库导,
       * 恒无命中、每个 Token 各建新行。留这条注释是因为本 op 也被别处直接调用;跨实例分叉合并归「改绑」那张票。
       */
      // ref 插入用无目标 onConflict:PK(user_id,namer,local_name)与唯一索引(user_id,token_id,namer)任一撞了都静默。
      importToken: (
        t: ImportTokenInput,
        refs: readonly { namer: string; localName: string }[],
        now: () => number = Date.now,
      ): Effect.Effect<string> =>
        Effect.gen(function* () {
          if (refs.length > 0) {
            const hit = yield* database.query((db) =>
              db
                .select({ tokenId: tokenRefs.tokenId })
                .from(tokenRefs)
                .where(
                  and(
                    eq(tokenRefs.userId, userId),
                    or(
                      ...refs.map((r) =>
                        and(eq(tokenRefs.namer, r.namer), eq(tokenRefs.localName, r.localName)),
                      ),
                    ),
                  ),
                )
                .limit(1),
            );
            const target = hit[0]?.tokenId;
            if (target) {
              // 复用已有 Token:把它还没有的 ref 补挂过去(撞约束的静默跳过)。
              yield* database.batch((db) =>
                refs.map((r) =>
                  db
                    .insert(tokenRefs)
                    .values({ userId, namer: r.namer, localName: r.localName, tokenId: target })
                    .onConflictDoNothing(),
                ),
              );
              return target;
            }
          }

          const id = crypto.randomUUID();
          yield* database.batch((db) => [
            db.insert(tokens).values({
              id,
              userId,
              symbol: t.symbol,
              name: t.name,
              logo: t.logo ?? null,
              providerLogo: t.providerLogo ?? null,
              marketCapRank: t.marketCapRank ?? null,
              infoExpiresAt: now(), // 建行即 stale → 下次刷价/刷图补齐 name/logo/价
            }),
            ...refs.map((r) =>
              db
                .insert(tokenRefs)
                .values({ userId, namer: r.namer, localName: r.localName, tokenId: id })
                .onConflictDoNothing(),
            ),
          ]);
          return id;
        }),

      /** 账户自然键 = (connectorId, platform, label, creds) 全同即同一个。归档态是可变属性、不进键。 */
      // 命中时若文件说归档而现有未归档,则对齐成归档。
      importAccount: (
        input: CreateAccountInput & { archivedAt?: number | null },
      ): Effect.Effect<{ id: string; created: boolean }> =>
        Effect.gen(function* () {
          const platform = input.platform ?? null;
          const creds = input.creds ?? null;
          const existing = yield* database.query((db) =>
            db
              .select({ id: accounts.id, archivedAt: accounts.archivedAt })
              .from(accounts)
              .where(
                and(
                  eq(accounts.userId, userId),
                  eq(accounts.connectorId, input.connectorId),
                  platform === null ? isNull(accounts.platform) : eq(accounts.platform, platform),
                  eq(accounts.label, input.label),
                  creds === null ? isNull(accounts.creds) : eq(accounts.creds, creds),
                ),
              )
              .limit(1),
          );
          const hit = existing[0];
          if (hit) {
            if (input.archivedAt != null && hit.archivedAt == null) {
              yield* database.query((db) =>
                db
                  .update(accounts)
                  .set({ archivedAt: input.archivedAt })
                  .where(and(eq(accounts.id, hit.id), eq(accounts.userId, userId))),
              );
            }
            return { id: hit.id, created: false };
          }
          // 新账户:同 AccountStore.create,建账户 + 归属默认 Portfolio 原子写
          //(维持「每账户恰一行归属」不变量)。
          const pf = yield* ensureDefault(database, userId);
          const id = crypto.randomUUID();
          yield* database.batch((db) => [
            db.insert(accounts).values({
              id,
              userId,
              connectorId: input.connectorId,
              platform,
              label: input.label,
              creds,
              createdAt: Date.now(),
              archivedAt: input.archivedAt ?? null,
            }),
            db.insert(portfolioAccounts).values({ portfolioId: pf.id, accountId: id }),
          ]);
          return { id, created: true };
        }),

      /** 快照自然键 = (accountId, takenAt) —— 一个账户一个时刻一份。已存在则整份跳过。 */
      importSnapshot: (
        accountId: string,
        input: WriteSnapshotInput,
      ): Effect.Effect<{ created: boolean }> =>
        Effect.gen(function* () {
          yield* database.query((db) => assertAccountOwned(db, userId, accountId));
          const existing = yield* database.query((db) =>
            db
              .select({ id: snapshots.id })
              .from(snapshots)
              .where(and(eq(snapshots.accountId, accountId), eq(snapshots.takenAt, input.takenAt)))
              .limit(1),
          );
          if (existing[0]) return { created: false };
          yield* snapshotStore.write(accountId, input);
          return { created: true };
        }),

      /** 手记活动自然键 = 整条内容。**createdAt 必须进键**,理由见下。 */
      // **createdAt 必须进键**:系统允许同一 occurredAt 有多笔、靠 createdAt 排序折叠(deriveAmount);
      // 两笔除 createdAt 外全同是合法的不同事件,漏掉它会把它们折成一笔、丢数量(连首次恢复都出错)。
      // v3 导出恒带 createdAt,故加进键后再导仍命中(幂等)。createdAt 缺席(非导入路径)才退回内容键。
      importManualActivity: (
        accountId: string,
        tokenId: string,
        input: ManualActivityInput,
      ): Effect.Effect<{ created: boolean }> =>
        Effect.gen(function* () {
          yield* database.query((db) => assertAccountOwned(db, userId, accountId));
          yield* database.query((db) => assertTokenOwned(db, userId, tokenId));
          const price = input.price ?? null;
          const fee = input.fee ?? null;
          const memo = input.memo ?? null;
          const existing = yield* database.query((db) =>
            db
              .select({ id: manualActivity.id })
              .from(manualActivity)
              .where(
                and(
                  eq(manualActivity.accountId, accountId),
                  eq(manualActivity.tokenId, tokenId),
                  eq(manualActivity.kind, input.kind),
                  eq(manualActivity.amount, input.amount),
                  price === null ? isNull(manualActivity.price) : eq(manualActivity.price, price),
                  fee === null ? isNull(manualActivity.fee) : eq(manualActivity.fee, fee),
                  eq(manualActivity.occurredAt, input.occurredAt),
                  memo === null ? isNull(manualActivity.memo) : eq(manualActivity.memo, memo),
                  input.createdAt != null
                    ? eq(manualActivity.createdAt, input.createdAt)
                    : undefined,
                ),
              )
              .limit(1),
          );
          if (existing[0]) return { created: false };
          yield* manualStore.recordActivity(accountId, tokenId, input);
          return { created: true };
        }),
    };
  });

// **layer 依赖另外两个 store**(不是方法的 `R`):导快照/导活动就是「查重之后调那一个写」。
export const transferStoreLayer = (
  userId: string,
): Layer.Layer<TransferStore, never, DbClient | SnapshotStore | ManualStore> =>
  Layer.effect(TransferStore, make(userId));
