import { formatTokenRef, type TokenRef } from "@folio/oracle-ref";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { manualActivity, tokenRefs, tokens } from "../schema";
import type { DbClient } from "../stores/service";
import { assertAccountOwned, assertTokenOwned } from "./ownership";

// 手记持仓 —— 「这个手记账户持有哪些币」,由账本折叠出来(ADR 0017;#203 起并入 tokens)。
//
// **这半没有自己的 Tag。** 持仓与账本是同一个领域的两面(持仓正是账本折叠出来的),按能力
// 切成两个服务会重蹈 #392 拆掉的那种分法。所以这里只出「绑好 database + userId 之后的那几个
// 方法」,由 `manual-activity.ts` 的 `ManualStore` 合成一个服务。
//
// **手记的币就是这个用户 `tokens` 里的一行**(#203):身份 / 名字 / 图 / 上游 ref 在 `tokens` +
// `token_refs`,用户声明的单价在 `tokens.self_price`,数量由 `manual_activity` 折叠。
// 原来的 `manual_token` 表整个退场 —— 那四个值全部有了真表的家。
//
// 于是「这个手记账户持有哪些币」不再单独存一份关系,而是**它账本里出现过的 token**。
// 副作用是「清空某个币」= 删掉该账户对它的全部活动(见 detachManualHolding),而 `tokens` 那行留着 ——
// 它是参考层数据,可能别的账户还在用,也可能上游认识它。

// 手记持仓的定义投影(数量不在内 —— 那是账本折叠出来的)。`id` 就是 `tokens.id`。
export interface ManualHolding {
  id: string;
  symbol: string;
  // 这个 token 在 `namer` 那里的 **ref 整条**;那位命名者还没认出它 → null。
  //
  // **给整条,不给右半边。** 原来这里回的是裸的上游 id(`usd-coin`),于是每个调用方都得把 ref
  // 拼回去才能用 —— 而拼 ref 就得知道命名者是谁,于是「当前上游是 CoinGecko」这件事一路漏进了
  // apps/web(#227 评审)。整条给出去之后调用方只搬运:编成票、或当 Balance 的 tokenRef 交出去,
  // 一个字都不用解释。文法留在 `@folio/oracle-ref` 这一侧,`namer` 也不必再往外说。
  ref: TokenRef | null;
}

// 持仓这半的方法(绑好 `database` 与 userId 之后)。
export const holdingOps = (database: DbClient, userId: string) => ({
  // `namer` 决定 `ref` 从哪个命名者那一行读 —— 由调用方传(同 userTokenStoreLayer),db 层不预设任何厂商。
  // 序:该币在本账户账本里最早一笔活动的时间 —— 即「什么时候开始持有它」,天然稳定。
  listHoldings: (accountId: string, namer: string): Effect.Effect<ManualHolding[]> =>
    Effect.gen(function* () {
      yield* database.query((db) => assertAccountOwned(db, userId, accountId));
      const rows = yield* database.query((db) =>
        db
          .select({
            id: tokens.id,
            symbol: tokens.symbol,
            localName: tokenRefs.localName,
            since: sql<number>`min(${manualActivity.occurredAt})`,
          })
          .from(manualActivity)
          .innerJoin(tokens, eq(manualActivity.tokenId, tokens.id))
          .leftJoin(
            tokenRefs,
            and(
              eq(tokenRefs.tokenId, tokens.id),
              eq(tokenRefs.userId, userId),
              eq(tokenRefs.namer, namer),
            ),
          )
          .where(and(eq(manualActivity.accountId, accountId), eq(tokens.userId, userId)))
          .groupBy(tokens.id, tokens.symbol, tokens.selfPrice, tokenRefs.localName)
          .orderBy(asc(sql`min(${manualActivity.occurredAt})`)),
      );
      return rows.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        // 两列 → 整条串,拼法归文法(`token_refs` 按两列存正是为了这个,见 ADR 0022)。
        ref: r.localName === null ? null : formatTokenRef({ namer, localName: r.localName }),
      }));
    }),

  // 用户对某个币的声明:symbol(他自己的叫法)。**只动这一列** —— 名字 / 图 / 上游 ref
  // 归参考层,手记不覆盖它们。
  // 单价不在这里 —— 「这个币值多少」只有账本一个来源(每笔活动的 price),
  // 而 `tokens.self_price` 从此没有写者(迁移 0016 把存量搬进账本并清空了它)。
  setHoldingDef: (tokenId: string, input: { symbol?: string }): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* database.query((db) => assertTokenOwned(db, userId, tokenId));
      const set: Record<string, unknown> = {};
      if (input.symbol !== undefined) set.symbol = input.symbol;
      if (Object.keys(set).length === 0) return;
      yield* database.query((db) =>
        db
          .update(tokens)
          .set(set)
          .where(and(eq(tokens.id, tokenId), eq(tokens.userId, userId))),
      );
    }),

  // 该账户不再持有这个币:删它对该币的全部活动。**`tokens` 那行不删** —— 参考层数据,
  // 别的账户可能还在用,而且它带着上游 ref / 历史日价,删了就得重新认一遍。
  detachHolding: (accountId: string, tokenId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* database.query((db) => assertAccountOwned(db, userId, accountId));
      yield* database.query((db) => assertTokenOwned(db, userId, tokenId));
      yield* database.query((db) =>
        db
          .delete(manualActivity)
          .where(and(eq(manualActivity.accountId, accountId), eq(manualActivity.tokenId, tokenId))),
      );
    }),
});
