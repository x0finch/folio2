import type { ConnectorId } from "@folio/connectors";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { DbClient } from "../client";
import type { Drizzle } from "../connect";
import { CurrentUser } from "../current-user";
import { tabPins } from "../schema";
import type { TabPin } from "../schema/types";
import { assertAccountOwned, assertTagOwned } from "./ownership";

// 自定义 Tab(pin,ADR 0034):把某个 tag / 账户 / connector 钉成导航上的一栏。
//
// **服务的方法签名里没有 userId**(ADR 0037):建服务那一刻从 `CurrentUser` 读一次(ADR 0044)。
//
// **这个领域没有自己的 Tag**(P0 打样先到达的形状):出口只有 `makeTabPinStore(userId)` 这个
// 「怎么造」的 Effect,由 `../database.ts` 的聚合 `Database` 挂到 `tabPins` 字段上。
// 以前这里还有 `TabPinStore` 这个 Tag + `tabPinStoreLayer` —— 它们存在的唯一理由是让 app 侧
// `yield* TabPinStore`;调用点改成 `(yield* Database).tabPins` 之后就没有第二个消费者了。
// 手写的 `interface TabPinStore` 也删了(#501):类型从这里的返回值推导,cmd+click 直接落实现,
// 每个方法的返回类型仍显式标注 —— 契约精度不靠推断,推断只用来省一份复述。

// 每 user 至多固定 3 个自定义 Tab(域规则,co-located 同 BALANCE_INSERT_CHUNK 的做法)。
const MAX_TAB_PINS_PER_USER = 3;

async function assertTabPinOwned(db: Drizzle, userId: string, pinId: string): Promise<void> {
  const rows = await db
    .select({ id: tabPins.id })
    .from(tabPins)
    .where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId)));
  if (!rows[0]) throw new Error(`tab pin not found: ${pinId}`);
}

export interface TabPinInput {
  kind: "connector" | "tag" | "account";
  tagId?: string | null;
  accountId?: string | null;
  connectorId?: ConnectorId | null;
  sortOrder?: number;
}

// pin 的目标校验:tag pin 带本人 tagId;account pin 带本人 accountId;connector pin 带 connectorId
//(无 FK,不校验存在)。返回规范化后的三列(按 kind 互斥非空)。
async function resolvePinTarget(
  db: Drizzle,
  userId: string,
  input: Pick<TabPinInput, "kind" | "tagId" | "accountId" | "connectorId">,
): Promise<{ tagId: string | null; accountId: string | null; connectorId: ConnectorId | null }> {
  if (input.kind === "tag") {
    if (!input.tagId) throw new Error("tag pin requires tagId");
    await assertTagOwned(db, userId, input.tagId);
    return { tagId: input.tagId, accountId: null, connectorId: null };
  }
  if (input.kind === "account") {
    if (!input.accountId) throw new Error("account pin requires accountId");
    await assertAccountOwned(db, userId, input.accountId);
    return { tagId: null, accountId: input.accountId, connectorId: null };
  }
  if (!input.connectorId) throw new Error("connector pin requires connectorId");
  return { tagId: null, accountId: null, connectorId: input.connectorId };
}

export const makeTabPinStore = Effect.gen(function* () {
  const dbClient = yield* DbClient;
  const userId = yield* CurrentUser;

  return {
    /** 固定一个自定义 Tab。每 user ≤3(超出抛)。tag pin 校验 Tag 归属本人。 */
    create: (input: TabPinInput): Effect.Effect<TabPin> =>
      Effect.gen(function* () {
        const existing = yield* dbClient.query((db) =>
          db.select({ id: tabPins.id }).from(tabPins).where(eq(tabPins.userId, userId)),
        );
        if (existing.length >= MAX_TAB_PINS_PER_USER) {
          return yield* Effect.die(
            new Error(`cannot pin more than ${MAX_TAB_PINS_PER_USER} custom tabs`),
          );
        }
        const target = yield* dbClient.query((db) => resolvePinTarget(db, userId, input));
        const row = {
          id: crypto.randomUUID(),
          userId,
          kind: input.kind,
          tagId: target.tagId,
          accountId: target.accountId,
          connectorId: target.connectorId,
          sortOrder: input.sortOrder ?? existing.length,
        };
        yield* dbClient.query((db) => db.insert(tabPins).values(row));
        return row;
      }),

    /** 全部 pin,按 sortOrder 稳定排序(id 作 tiebreaker)。 */
    list: (): Effect.Effect<TabPin[]> =>
      dbClient.query((db) =>
        db
          .select()
          .from(tabPins)
          .where(eq(tabPins.userId, userId))
          .orderBy(asc(tabPins.sortOrder), asc(tabPins.id)),
      ),

    /** 改一个 pin 指向的目标(hover「改指向」用):换 connector/tag。owner 断言 + 目标校验。 */
    updateTarget: (
      pinId: string,
      patch: Pick<TabPinInput, "kind" | "tagId" | "accountId" | "connectorId">,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* dbClient.query((db) => assertTabPinOwned(db, userId, pinId));
        const target = yield* dbClient.query((db) => resolvePinTarget(db, userId, patch));
        yield* dbClient.query((db) =>
          db
            .update(tabPins)
            .set({
              kind: patch.kind,
              tagId: target.tagId,
              accountId: target.accountId,
              connectorId: target.connectorId,
            })
            .where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId))),
        );
      }),

    // 空列表 → `DbClient.batch` 自己是 no-op(见 ../client.ts),不必再包一层
    // ——`batchWrite` 那个包装因此在本片退场。
    /** 重排 pin(按给定 id 顺序写 sortOrder)。不在列表里的 pin 不动;空列表 no-op。 */
    reorder: (orderedIds: string[]): Effect.Effect<void> =>
      dbClient.batch((db) =>
        orderedIds.map((id, i) =>
          db
            .update(tabPins)
            .set({ sortOrder: i })
            .where(and(eq(tabPins.id, id), eq(tabPins.userId, userId))),
        ),
      ),

    /** 取消固定(删 pin)。不碰任何数据(纯删指针),故调用侧无需二次确认(ADR 0034)。 */
    remove: (pinId: string): Effect.Effect<void> =>
      Effect.asVoid(
        dbClient.query((db) =>
          db.delete(tabPins).where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId))),
        ),
      ),
  };
});
