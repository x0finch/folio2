import { beforeEach, describe, expect, it } from "vitest";
import { handleGetHomeTabStrip } from "@/lib/server/portfolio/tabs";
import { handleCreateTabPin } from "@/lib/server/tab-pins/create";
import { DeleteTabPinInput, handleDeleteTabPin } from "@/lib/server/tab-pins/delete";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 tab-pins/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("tab-pins/delete", () => {
  // #527 · deleteTabPin
  const USER = "h-pins-delete";

  const pins = (userId: string) => call(userId, handleGetHomeTabStrip({}));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("deleteTabPin", () => {
    it("删掉一个 → 少一个,其余两个还在", async () => {
      const a = await db(USER).tabPins.create({ kind: "connector", connectorId: "manual" });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "bitcoin" });
      await db(USER).tabPins.create({ kind: "connector", connectorId: "binance" });

      await call(USER, handleDeleteTabPin({ pinId: a.id }));

      const strip = await pins(USER);
      expect(strip.pins).toHaveLength(2);
      expect(strip.pins.map((p) => p.connectorId).sort()).toEqual(["binance", "bitcoin"]);
    });

    it("删到零个 → tab 条上一个 pin 都没有", async () => {
      const a = await db(USER).tabPins.create({ kind: "connector", connectorId: "manual" });

      await call(USER, handleDeleteTabPin({ pinId: a.id }));

      expect((await pins(USER)).pins).toEqual([]);
    });

    it("删一个已经删过的 → 静默幂等(与 deleteTag 同一规则),不是 NotFound", async () => {
      // **这条是审计改过的。** 清单初稿写的是「NotFound」,但库层两个 remove 都是裸 DELETE ——
      // 同一种形状不该有两种主张。按现状钉:静默。
      const a = await db(USER).tabPins.create({ kind: "connector", connectorId: "manual" });

      await call(USER, handleDeleteTabPin({ pinId: a.id }));
      await call(USER, handleDeleteTabPin({ pinId: a.id }));

      expect((await pins(USER)).pins).toEqual([]);
    });

    it("删完立刻再建 → 能建,上限计数跟着降了", async () => {
      const made = [];
      for (const c of ["manual", "bitcoin", "binance"]) {
        made.push(await call(USER, handleCreateTabPin({ kind: "connector", connectorId: c })));
      }

      await call(USER, handleDeleteTabPin({ pinId: made[0].id }));
      await call(USER, handleCreateTabPin({ kind: "connector", connectorId: "okx" }));

      expect((await pins(USER)).pins.map((p) => p.connectorId).sort()).toEqual([
        "binance",
        "bitcoin",
        "okx",
      ]);
    });

    it("删别人的 pinId → 对方那个 pin 一点没动", async () => {
      const theirs = await db(otherUser(USER)).tabPins.create({
        kind: "connector",
        connectorId: "manual",
      });

      await call(USER, handleDeleteTabPin({ pinId: theirs.id }));

      expect((await pins(otherUser(USER))).pins).toHaveLength(1);
    });

    it("pinId 空串 → schema 拒", () => {
      expect(DeleteTabPinInput.safeParse({ pinId: "" }).success).toBe(false);
    });
  });
});
