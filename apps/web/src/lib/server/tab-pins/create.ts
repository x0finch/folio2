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
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";
import { scopedMembership } from "@/lib/server/portfolio/scope";

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

/**
 * 钉 / 取消 / 改指向之后,**抬哪一条失效水位线**。
 *
 * 抬整个用户那条是能用的,但代价不小:这个用户**每个组合**的四族预计算全部作废,而
 * `refresh.ts` 那句话说得很清楚 —— 钉一个 Tab 一分钱余额都没改,把昂贵的总览拖着一起重算是浪费。
 * tag pin 与 account pin 都只属于一个组合,按那一个抬就够。
 *
 * **connector pin 只能抬用户级**:它是个镜头、不归属组合,有这家账户的每个组合的条子上都摆着它。
 *
 * **不知道它指着谁就退回用户级**(行已经不在了、标签刚被删):宁可多算一趟,也不能漏掉一个组合
 * —— 漏掉的症状是屏幕上挂着一个已经不存在的 Tab,而没有任何东西会自己纠正。
 */
export const invalidateForPin = (
  target: Pick<PinTargetRef, "kind" | "connectorId" | "tagId" | "accountId"> | undefined,
): Effect.Effect<void, never, Database> =>
  Effect.gen(function* () {
    if (!target || target.kind === "connector") return yield* invalidatePrecomputed();
    if (target.kind === "tag") {
      const tag = (yield* (yield* Database).tags.list()).find((t) => t.id === target.tagId);
      return yield* invalidatePrecomputed(tag?.portfolioId);
    }
    // 没有归属行的账户按兜底规则算进默认组合(与 `pinsInView` 摆它的那个组合同一个判据)。
    const member = yield* scopedMembership(undefined);
    return yield* invalidatePrecomputed(
      target.accountId ? member.portfolioIdOf(target.accountId) : undefined,
    );
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
  const pin = yield* db.tabPins.create({
    kind: data.kind,
    connectorId: data.connectorId as ConnectorId | undefined,
    tagId: data.tagId,
    accountId: data.accountId,
  });
  // tab 条是预计算出来的,而这一步正是它的内容 —— 不抬水位线,新钉的 Tab 最长 90 分钟不出现。
  yield* invalidateForPin(data);
  return pin;
});
