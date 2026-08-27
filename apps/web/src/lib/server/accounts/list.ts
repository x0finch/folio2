import { Database } from "@folio/db";
import { Effect } from "effect";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { isComplete, readStoredCreds, safeView } from "@/lib/server/creds";
import { type PortfolioScope, scopedMembership } from "@/lib/server/portfolio/scope";

// 富化:把每账户的 raw creds 投影成 needsCredentials + credsSafe(public 原样、semi 打码、secret 丢弃);
// raw creds(含 secret 密文)绝不出网,只出投影。
//
// **只回当前组合的账户**(ADR 0047):以前整份下发、账户页自己筛 —— 于是别的组合的账户名与凭据状态
// 都在响应里。归档账户照旧在里面:这一页有归档区,用的是「归档无关」的成员判据。
//
// 行上带 `portfolioId`,「移到组合」弹窗要的那一条从这儿读 —— 客户端不必再另拉一份整表归属。
export const handleListAccounts = Effect.fn("listAccounts")(function* (data: PortfolioScope = {}) {
  const { accounts: store } = yield* Database;
  const specsByType = (yield* ConnectorRegistry).specs;
  const [scope, all, rawList] = yield* Effect.all(
    [scopedMembership(data.portfolioId), store.list(), store.listRawCreds()],
    { concurrency: 3 },
  );
  const accounts = all.filter((a) => scope.has(a.id));
  const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
  // 解不开的那些行:按「没凭据」渲染,并把 id 攒起来一次性 warn(#527 裁定 1)。以前这里是裸
  // `JSON.parse`,一行坏数据整页打不开 —— 而账户页恰恰是唯一能重填凭据、把它修好的地方。
  const unreadable: string[] = [];
  const rows = accounts.map((a) => {
    const parsed = readStoredCreds(rawById.get(a.id));
    if (parsed === null) unreadable.push(a.id);
    const stored = parsed ?? {};
    const specs = specsByType[a.connectorId] ?? [];
    return {
      ...a,
      portfolioId: scope.portfolioIdOf(a.id),
      needsCredentials: !isComplete(specs, stored),
      credsSafe: safeView(specs, stored),
    };
  });
  if (unreadable.length > 0) {
    yield* Effect.logWarning("stored creds unreadable, listed as incomplete").pipe(
      Effect.annotateLogs({ accountIds: unreadable }),
    );
  }
  return rows;
});
