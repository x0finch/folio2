import type { ConnectorId } from "@folio/connectors";
import { Database, InvalidInput } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import {
  accountsInView,
  MAX_PINS_PER_PORTFOLIO,
  pinsInView,
  type TabPinScope,
} from "@/lib/core/accounts-in-view";
import { resolveScope } from "@/lib/server/portfolio/scope";

// pin 目标形状家在 core/accounts-in-view 的 `TabPinScope`(tag 归属校验在 db 层)。
// schema 住这儿,update-target 跨借做 extend;与 TabPinScope 的一致性由 .handler() 处的赋值检查看着。
export const PinTargetInput = z.object({
  kind: z.enum(["connector", "tag", "account"]),
  connectorId: z.string().optional(),
  tagId: z.string().optional(),
  accountId: z.string().optional(),
});

// 建 pin 时还要知道**钉在哪个组合里看** —— 上限按组合算,而 pin 行上没有这个字段(ADR 0047)。
export const CreateTabPinInput = PinTargetInput.extend({ portfolioId: z.string().optional() });

// **handler 只描述,不发动**:返回一个 Effect,「哪个用户 / 怎么装配 / 什么时候变成 Promise」
// 全在装配点的 `runEffect` 里(见 ./index.ts)。所以这里没有 `context` 参数、没有 `await`。
//
// 包一层 `Effect.fn(名字)`:这个名字是 handler 在 span 与错误堆栈里的身份。
export const handleCreateTabPin = Effect.fn("createTabPin")(function* (
  data: NonNullable<TabPinScope> & { portfolioId?: string },
) {
  const db = yield* Database;
  // **上限是每组合 3 个,而且用的是「摆不摆」那同一个判据**(ADR 0047)。数的不是这个用户有几个 pin,
  // 是**这个组合里看得见几个** —— 否则在默认组合钉满之后,别的组合空着也建不了。
  //
  // 拦在这儿而不在 db 层:算「看得见几个」要 Tag 的归属、账户的归属、connector 有没有账户,
  // 那是应用层的事;db 只管一行 pin 本身合不合法(目标归不归自己)。
  const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
  const [pins, allAccounts, memberships, tags] = yield* Effect.all(
    [db.tabPins.list(), db.accounts.list(), db.portfolios.listMemberships(), db.tags.list()],
    { concurrency: 4 },
  );
  const shown = pinsInView(pins, {
    accounts: accountsInView(allAccounts, memberships, selectedId, defaultId),
    tagIds: new Set(tags.filter((t) => t.portfolioId === selectedId).map((t) => t.id)),
  });
  // 类型化失败,不是 500:UI 会先挡,但一个陈旧的页面照样发得出这个请求,而「这个组合已经钉满了」
  // 是句该说给人听的话。
  if (shown.length >= MAX_PINS_PER_PORTFOLIO) {
    return yield* Effect.fail(
      new InvalidInput({
        what: "tab pin",
        why: `cannot pin more than ${MAX_PINS_PER_PORTFOLIO} custom tabs per portfolio`,
      }),
    );
  }
  return yield* db.tabPins.create({
    kind: data.kind,
    connectorId: data.connectorId as ConnectorId | undefined,
    tagId: data.tagId,
    accountId: data.accountId,
  });
});
