import type { ConnectorId } from "@folio/connectors";
import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Drizzle } from "../connect";
import { tabPins } from "../schema";
import type { TabPin } from "../schema/types";
import { Database } from "../stores/service";
import { assertAccountOwned, assertTagOwned } from "./ownership";

// 自定义 Tab(pin,ADR 0034):把某个 tag / 账户 / connector 钉成导航上的一栏。
//
// **服务的方法签名里没有 userId**(ADR 0037):由 `tabPinStoreLayer(userId)` 在装配那一刻吃掉。

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

export interface TabPinStore {
  /** 固定一个自定义 Tab。每 user ≤3(超出抛)。tag pin 校验 Tag 归属本人。 */
  readonly create: (input: TabPinInput) => Effect.Effect<TabPin>;
  /** 全部 pin,按 sortOrder 稳定排序(id 作 tiebreaker)。 */
  readonly list: () => Effect.Effect<TabPin[]>;
  /** 改一个 pin 指向的目标(hover「改指向」用):换 connector/tag。owner 断言 + 目标校验。 */
  readonly updateTarget: (
    pinId: string,
    patch: Pick<TabPinInput, "kind" | "tagId" | "accountId" | "connectorId">,
  ) => Effect.Effect<void>;
  /** 重排 pin(按给定 id 顺序写 sortOrder)。不在列表里的 pin 不动;空列表 no-op。 */
  readonly reorder: (orderedIds: string[]) => Effect.Effect<void>;
  /** 取消固定(删 pin)。不碰任何数据(纯删指针),故调用侧无需二次确认(ADR 0034)。 */
  readonly remove: (pinId: string) => Effect.Effect<void>;
}

export const TabPinStore = Context.GenericTag<TabPinStore>("db/TabPinStore");

const make = (userId: string) =>
  Effect.gen(function* () {
    const database = yield* Database;

    const store: TabPinStore = {
      create: (input) =>
        Effect.gen(function* () {
          const existing = yield* database.query((db) =>
            db.select({ id: tabPins.id }).from(tabPins).where(eq(tabPins.userId, userId)),
          );
          if (existing.length >= MAX_TAB_PINS_PER_USER) {
            return yield* Effect.die(
              new Error(`cannot pin more than ${MAX_TAB_PINS_PER_USER} custom tabs`),
            );
          }
          const target = yield* database.query((db) => resolvePinTarget(db, userId, input));
          const row = {
            id: crypto.randomUUID(),
            userId,
            kind: input.kind,
            tagId: target.tagId,
            accountId: target.accountId,
            connectorId: target.connectorId,
            sortOrder: input.sortOrder ?? existing.length,
          };
          yield* database.query((db) => db.insert(tabPins).values(row));
          return row;
        }),

      list: () =>
        database.query((db) =>
          db
            .select()
            .from(tabPins)
            .where(eq(tabPins.userId, userId))
            .orderBy(asc(tabPins.sortOrder), asc(tabPins.id)),
        ),

      updateTarget: (pinId, patch) =>
        Effect.gen(function* () {
          yield* database.query((db) => assertTabPinOwned(db, userId, pinId));
          const target = yield* database.query((db) => resolvePinTarget(db, userId, patch));
          yield* database.query((db) =>
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

      // 空列表 → `Database.batch` 自己是 no-op(见 stores/service.ts),不必再包一层
      // ——`batchWrite` 那个包装因此在本片退场。
      reorder: (orderedIds) =>
        database.batch((db) =>
          orderedIds.map((id, i) =>
            db
              .update(tabPins)
              .set({ sortOrder: i })
              .where(and(eq(tabPins.id, id), eq(tabPins.userId, userId))),
          ),
        ),

      remove: (pinId) =>
        Effect.asVoid(
          database.query((db) =>
            db.delete(tabPins).where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId))),
          ),
        ),
    };

    return store;
  });

export const tabPinStoreLayer = (userId: string): Layer.Layer<TabPinStore, never, Database> =>
  Layer.effect(TabPinStore, make(userId));
