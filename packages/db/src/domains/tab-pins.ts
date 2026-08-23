import type { ConnectorId } from "@folio/connectors";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { DbClient } from "../client";
import { CurrentUser } from "../current-user";
import { InvalidInput, NotFound } from "../errors";
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

const assertTabPinOwned = (
  client: DbClient,
  userId: string,
  pinId: string,
): Effect.Effect<void, NotFound> =>
  client
    .query((db) =>
      db
        .select({ id: tabPins.id })
        .from(tabPins)
        .where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId))),
    )
    .pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.void : Effect.fail(new NotFound({ entity: "tab pin", id: pinId })),
      ),
    );

export interface TabPinInput {
  kind: "connector" | "tag" | "account";
  tagId?: string | null;
  accountId?: string | null;
  connectorId?: ConnectorId | null;
  sortOrder?: number;
}

// pin 的目标校验:tag pin 带本人 tagId;account pin 带本人 accountId;connector pin 带 connectorId
//(无 FK,不校验存在)。返回规范化后的三列(按 kind 互斥非空)。
//
// 「缺字段」是 `InvalidInput`,不是 `NotFound`,也不再是 defect(#504 T6):zod 那道
// `PinTargetInput` 三个字段全是可选的(一个 schema 供三种 kind 用),所以「kind=tag 却没带
// tagId」进得来 —— 那是调用方拼错了参数,能改,该收到一句话,不该收到 500。
const resolvePinTarget = (
  client: DbClient,
  userId: string,
  input: Pick<TabPinInput, "kind" | "tagId" | "accountId" | "connectorId">,
): Effect.Effect<
  { tagId: string | null; accountId: string | null; connectorId: ConnectorId | null },
  NotFound | InvalidInput
> =>
  Effect.gen(function* () {
    if (input.kind === "tag") {
      if (!input.tagId) return yield* missingTarget("tag pin", "tagId");
      yield* assertTagOwned(client, userId, input.tagId);
      return { tagId: input.tagId, accountId: null, connectorId: null };
    }
    if (input.kind === "account") {
      if (!input.accountId) return yield* missingTarget("account pin", "accountId");
      yield* assertAccountOwned(client, userId, input.accountId);
      return { tagId: null, accountId: input.accountId, connectorId: null };
    }
    if (!input.connectorId) return yield* missingTarget("connector pin", "connectorId");
    return { tagId: null, accountId: null, connectorId: input.connectorId };
  });

const missingTarget = (what: string, field: string): Effect.Effect<never, InvalidInput> =>
  Effect.fail(new InvalidInput({ what, why: `requires ${field}` }));

export const makeTabPinStore = Effect.gen(function* () {
  const client = yield* DbClient;
  const userId = yield* CurrentUser;

  return {
    /** 固定一个自定义 Tab。每 user ≤3(超出抛)。tag pin 校验 Tag 归属本人。 */
    create: (input: TabPinInput): Effect.Effect<TabPin, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        const existing = yield* client.query((db) =>
          db.select({ id: tabPins.id }).from(tabPins).where(eq(tabPins.userId, userId)),
        );
        // 上限也是 `InvalidInput`:UI 会先挡,但一个陈旧的页面照样发得出这个请求,
        // 而「已经钉满了」是句该说给人听的话,不是 500。
        if (existing.length >= MAX_TAB_PINS_PER_USER) {
          return yield* Effect.fail(
            new InvalidInput({
              what: "tab pin",
              why: `cannot pin more than ${MAX_TAB_PINS_PER_USER} custom tabs`,
            }),
          );
        }
        const target = yield* resolvePinTarget(client, userId, input);
        const row = {
          id: crypto.randomUUID(),
          userId,
          kind: input.kind,
          tagId: target.tagId,
          accountId: target.accountId,
          connectorId: target.connectorId,
          sortOrder: input.sortOrder ?? existing.length,
        };
        yield* client.query((db) => db.insert(tabPins).values(row));
        return row;
      }),

    /** 全部 pin,按 sortOrder 稳定排序(id 作 tiebreaker)。 */
    list: (): Effect.Effect<TabPin[]> =>
      client.query((db) =>
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
    ): Effect.Effect<void, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        yield* assertTabPinOwned(client, userId, pinId);
        const target = yield* resolvePinTarget(client, userId, patch);
        yield* client.query((db) =>
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
      client.batch((db) =>
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
        client.query((db) =>
          db.delete(tabPins).where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId))),
        ),
      ),
  };
});
