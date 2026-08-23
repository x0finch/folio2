import { Database } from "@folio/db";
import { Effect } from "effect";
import { toAccountSections } from "@/lib/core/account-view";
import { accountsInView } from "@/lib/core/accounts-in-view";
import { connectorLabelFallback, platformLogoUrl } from "@/lib/core/logo";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";
import { resolveScope } from "./scope";
import { kindPresence, resolvePinLabel } from "./tab-strip";

// #488 票 4:首页 tab 条的轻请求。只回答「这个组合里有没有永续 / DeFi、自定义 Tab 叫什么」。
// 不富化价格、不算盈亏、不接手记现造 —— 手记只注入现货,不影响这两个 tab 的有无。
// 标签在服务端解析好(连接器走 registry 的类型名 + 已代理 logo),客户端不再为渲染 tab 名拉目录。
export const handleGetHomeTabStrip = Effect.fn("getHomeTabStrip")(function* (data: {
  portfolioId?: string;
}) {
  const db = yield* Database;
  const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
  const [allAccounts, snapshots, memberships, pins, tags] = yield* Effect.all(
    [
      db.accounts.list(),
      db.snapshots.latest(),
      db.portfolios.listMemberships(),
      db.tabPins.list(),
      db.tags.list(),
    ],
    { concurrency: 5 },
  );
  const accounts = accountsInView(allAccounts, memberships, selectedId, defaultId);
  const inView = new Set(accounts.map((a) => a.id));
  const sections = snapshots
    .filter((s) => inView.has(s.snapshot.accountId))
    .map((s) =>
      toAccountSections(
        s.balances.map((b) => ({
          id: b.id,
          amount: b.amount,
          usdValue: b.usdValue,
          kind: b.kind,
          metaJson: b.metaJson,
        })),
      ),
    );
  const { hasPerps, hasDefi } = kindPresence(sections);
  const tagName = (id: string) => tags.find((t) => t.id === id)?.name;
  const accountName = (id: string) => allAccounts.find((a) => a.id === id)?.label;
  const connector = (id: string) => {
    const meta = connectorPlatformMeta(id);
    return {
      name: meta?.name ?? connectorLabelFallback(id),
      logo: platformLogoUrl(id, meta?.logo),
    };
  };
  return {
    hasAccounts: accounts.length > 0,
    hasPerps,
    hasDefi,
    pins: pins.map((p) => {
      const label = resolvePinLabel(p, { tagName, accountName, connector });
      return {
        id: p.id,
        kind: p.kind,
        connectorId: p.connectorId ?? undefined,
        tagId: p.tagId ?? undefined,
        accountId: p.accountId ?? undefined,
        name: label.name,
        logo: label.logo,
      };
    }),
  };
});
