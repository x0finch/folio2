import { env } from "cloudflare:test";
import { Database, dbClientLayer } from "@folio/db";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { runEffect } from "@/lib/server/oracle";
import { handleCreateTabPin } from "@/lib/server/tab-pins/create";
import { handleDeleteTabPin } from "@/lib/server/tab-pins/delete";
import { handleUpdateTabPinTarget } from "@/lib/server/tab-pins/update-target";

// **接线本身的测试**:handler(只描述)+ `runEffect`(装配 + 发动)合起来对着真 D1 跑一遍。
// pin 的**行为**由 `packages/db/tests/tab-pins.test.ts` 盯(上限 / cascade / 越权);
// 这里只盯这条链没断:server fn 那一侧收到的 `{ data, context }` 真的变成了库里的一行。
//
// 全仓 51 个 handler 都会照这个形状写,所以这条接缝只需要一份 —— 不必每个域再来一遍。

const USER = "user-tabpin-fns";

async function resetUser(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(resetUser);

const ctx = { context: { userId: USER } };

// 读回来核对时**不走 handler** —— 那样等于用被测物验被测物。直接装聚合服务读一遍。
const listPins = () =>
  Effect.runPromise(
    Effect.flatMap(Database, (db) => db.tabPins.list()).pipe(
      Effect.provide(Database.layer(USER)),
      Effect.provide(dbClientLayer(env)),
    ),
  );

describe("tab-pin server fn 接线", () => {
  it("create → update → delete 走完整条链", async () => {
    const pin = await runEffect(handleCreateTabPin)({
      ...ctx,
      data: { kind: "connector", connectorId: "binance" },
    });
    expect(pin.connectorId).toBe("binance");
    expect(await listPins()).toHaveLength(1);

    await runEffect(handleUpdateTabPinTarget)({
      ...ctx,
      data: { pinId: pin.id, kind: "connector", connectorId: "okx" },
    });
    expect((await listPins())[0]?.connectorId).toBe("okx");

    await runEffect(handleDeleteTabPin)({ ...ctx, data: { pinId: pin.id } });
    expect(await listPins()).toHaveLength(0);
  });
});
