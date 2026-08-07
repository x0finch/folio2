import type { ConnectorId } from "@folio/connectors";
import { and, asc, eq } from "drizzle-orm";
import { type DbEnv, type Drizzle, getDb } from "../connect";
import { tabPins } from "../schema";
import type { TabPin } from "../schema/types";
import { batchWrite } from "./batch";
import { assertAccountOwned, assertTagOwned } from "./ownership";

// 自定义 Tab(pin,ADR 0034):把某个 tag / 账户 / connector 钉成导航上的一栏。

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

// 固定一个自定义 Tab。每 user ≤3(超出抛)。tag pin 校验 Tag 归属本人。
export async function createTabPin(
  env: DbEnv,
  userId: string,
  input: TabPinInput,
): Promise<TabPin> {
  const db = getDb(env);
  const existing = await db
    .select({ id: tabPins.id })
    .from(tabPins)
    .where(eq(tabPins.userId, userId));
  if (existing.length >= MAX_TAB_PINS_PER_USER) {
    throw new Error(`cannot pin more than ${MAX_TAB_PINS_PER_USER} custom tabs`);
  }
  const target = await resolvePinTarget(db, userId, input);
  const row = {
    id: crypto.randomUUID(),
    userId,
    kind: input.kind,
    tagId: target.tagId,
    accountId: target.accountId,
    connectorId: target.connectorId,
    sortOrder: input.sortOrder ?? existing.length,
  };
  await db.insert(tabPins).values(row);
  return row;
}

// 该用户全部 pin,按 sortOrder 稳定排序(id 作 tiebreaker)。
export function listTabPinsByUser(env: DbEnv, userId: string): Promise<TabPin[]> {
  return getDb(env)
    .select()
    .from(tabPins)
    .where(eq(tabPins.userId, userId))
    .orderBy(asc(tabPins.sortOrder), asc(tabPins.id));
}

// 改一个 pin 指向的目标(hover「改指向」用):换 connector/tag。owner 断言 + 目标校验。
export async function updateTabPinTarget(
  env: DbEnv,
  userId: string,
  pinId: string,
  patch: Pick<TabPinInput, "kind" | "tagId" | "accountId" | "connectorId">,
): Promise<void> {
  const db = getDb(env);
  await assertTabPinOwned(db, userId, pinId);
  const target = await resolvePinTarget(db, userId, patch);
  await db
    .update(tabPins)
    .set({
      kind: patch.kind,
      tagId: target.tagId,
      accountId: target.accountId,
      connectorId: target.connectorId,
    })
    .where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId)));
}

// 重排 pin(按给定 id 顺序写 sortOrder)。不在列表里的 pin 不动;空列表 no-op。
export async function reorderTabPins(
  env: DbEnv,
  userId: string,
  orderedIds: string[],
): Promise<void> {
  const db = getDb(env);
  await batchWrite(
    db,
    orderedIds.map((id, i) =>
      db
        .update(tabPins)
        .set({ sortOrder: i })
        .where(and(eq(tabPins.id, id), eq(tabPins.userId, userId))),
    ),
  );
}

// 取消固定(删 pin)。不碰任何数据(纯删指针),故调用侧无需二次确认(ADR 0034)。
export async function deleteTabPin(env: DbEnv, userId: string, pinId: string): Promise<void> {
  await getDb(env)
    .delete(tabPins)
    .where(and(eq(tabPins.id, pinId), eq(tabPins.userId, userId)));
}
