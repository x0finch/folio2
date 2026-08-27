import type { ConnectorId } from "@folio/connectors";
import { Database, InvalidInput } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import {
  accountsInView,
  MAX_PINS_PER_PORTFOLIO,
  type PinTargetRef,
  pinsInView,
  type TabPinScope,
} from "@/lib/core/accounts-in-view";

// pin 目标形状家在 core/accounts-in-view 的 `TabPinScope`(tag 归属校验在 db 层)。
// schema 住这儿,update-target 跨借做 extend;与 TabPinScope 的一致性由 .handler() 处的赋值检查看着。
export const PinTargetInput = z.object({
  kind: z.enum(["connector", "tag", "account"]),
  connectorId: z.string().optional(),
  tagId: z.string().optional(),
  accountId: z.string().optional(),
});

/**
 * 上限检查:每组合 ≤3(ADR 0047),数的是「看得见几个」,与 tab 条摆不摆共用 `pinsInView`。
 *
 * **一个 pin 会出现在哪些组合,由它指向的东西决定,不由调用方声称** —— 第一版收一个
 * `portfolioId` 只在那一个组合里数,review 抓出可绕过:递一个空组合的 id + 别的组合的目标,
 * 名额永远数 0。现在**对这个 pin 会出现的每一个组合**都数一遍,哪个满了都拒 ——
 * connector pin 会同时出现在几个组合(它是镜头,不归属组合),把任何一个顶到 4 都不行。
 *
 * `excludePinId` 给 update-target 用:改指向时旧的那次出现不占名额。
 */
export const assertPinCap = (candidate: PinTargetRef, excludePinId?: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [pins, allAccounts, memberships, tags, portfolios, defaultPf] = yield* Effect.all(
      [
        db.tabPins.list(),
        db.accounts.list(),
        db.portfolios.listMemberships(),
        db.tags.list(),
        db.portfolios.list(),
        db.portfolios.ensureDefault(),
      ],
      { concurrency: 6 },
    );
    const existing = pins.filter((p) => p.id !== excludePinId);
    for (const pf of portfolios) {
      const view = {
        accounts: accountsInView(allAccounts, memberships, pf.id, defaultPf.id),
        tagIds: new Set(tags.filter((t) => t.portfolioId === pf.id).map((t) => t.id)),
      };
      // 新 pin 在这个组合不出现 → 不占它的名额,下一个。
      if (pinsInView([{ ...candidate, id: "candidate" }], view).length === 0) continue;
      // 类型化失败,不是 500:UI 会先挡,但一个陈旧的页面照样发得出这个请求,
      // 而「这个组合已经钉满了」是句该说给人听的话。
      if (pinsInView(existing, view).length >= MAX_PINS_PER_PORTFOLIO) {
        return yield* Effect.fail(
          new InvalidInput({
            what: "tab pin",
            why: `cannot pin more than ${MAX_PINS_PER_PORTFOLIO} custom tabs per portfolio`,
          }),
        );
      }
    }
  });

// **handler 只描述,不发动**:返回一个 Effect,「哪个用户 / 怎么装配 / 什么时候变成 Promise」
// 全在装配点的 `runEffect` 里(见 ./index.ts)。所以这里没有 `context` 参数、没有 `await`。
//
// 包一层 `Effect.fn(名字)`:这个名字是 handler 在 span 与错误堆栈里的身份。
export const handleCreateTabPin = Effect.fn("createTabPin")(function* (
  data: NonNullable<TabPinScope>,
) {
  const db = yield* Database;
  yield* assertPinCap(data);
  return yield* db.tabPins.create({
    kind: data.kind,
    connectorId: data.connectorId as ConnectorId | undefined,
    tagId: data.tagId,
    accountId: data.accountId,
  });
});
