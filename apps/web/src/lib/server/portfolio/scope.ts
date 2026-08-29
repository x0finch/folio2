import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import {
  accountsInView,
  accountsMatchingPin,
  inView,
  type TabPinScope,
  toTabPin,
} from "@/lib/core/accounts-in-view";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";
import { injectManualSnapshots, manualFiatRefs } from "@/lib/server/manual/store";
import { buildOverview } from "./overview-model";

// 选中 Portfolio 入参:客户端选择器传的临时选中 id(可空 → 用默认)。缺省 {} 让 loader 不带参调用时退回默认视图。
// 仅按选中 Portfolio scope(曲线 / 列表默认口径);不带 pin。
export const PortfolioSelectInput = z.object({ portfolioId: z.string().optional() }).default({});

// overview 入参:在选中 Portfolio 之上再叠一个自定义 Tab 的 pin(ADR 0034)—— 按 connector/tag/account
// 在选中 Portfolio 内再收窄;缺省 = 默认视图(不收窄)。pin 只收窄 overview 的列表,不进曲线(见 get-history)。
// pin 的 TS 形状家在 core/accounts-in-view 的 `TabPinScope`,不另造一份 —— 一致性由 .handler() 处的赋值检查看着。
export const PortfolioScopeInput = z
  .object({
    portfolioId: z.string().optional(),
    pin: z
      .object({
        kind: z.enum(["connector", "tag", "account"]),
        connectorId: z.string().optional(),
        tagId: z.string().optional(),
        accountId: z.string().optional(),
      })
      .optional(),
  })
  .default({});

export interface PortfolioScope {
  portfolioId?: string;
  pin?: NonNullable<TabPinScope>;
}

// 校验传入的 selectedId 属于该用户,否则退回默认(客户端传入不可信 —— 传别人的 id 只会得到空视图,
// 不泄露任何数据,但显式回退到默认更符合直觉)。返回选中 id + 默认 Portfolio。
export const resolveScope = (
  requested: string | undefined,
): Effect.Effect<{ selectedId: string; defaultId: string }, never, Database> =>
  Effect.gen(function* () {
    const store = (yield* Database).portfolios;
    const [portfolios, defaultPf] = yield* Effect.all([store.list(), store.ensureDefault()], {
      concurrency: 2,
    });
    const selectedId =
      requested && portfolios.some((p) => p.id === requested) ? requested : defaultPf.id;
    return { selectedId, defaultId: defaultPf.id };
  });

// 当前组合的成员判据(ADR 0047:作用域在服务端定)。账户域那几个读取口共用这一份。
//
// **与归档无关** —— 账户页有归档区。用 `accountsInView` 那个口径(它排除归档,喂总览/曲线)会让
// 归档账户从账户页凭空消失。两个口径别混,判据是「这一页要不要显示归档」。
export interface ScopedMembership {
  selectedId: string;
  defaultId: string;
  /** 这个账户在不在当前组合的视图里(归档与否不影响)。 */
  has: (accountId: string) => boolean;
  /** 这个账户归属哪个组合 —— 没有归属行的按兜底规则算进默认组合(同 `inView`)。 */
  portfolioIdOf: (accountId: string) => string;
}

export const scopedMembership = (
  requested: string | undefined,
): Effect.Effect<ScopedMembership, never, Database> =>
  Effect.gen(function* () {
    const store = (yield* Database).portfolios;
    const { selectedId, defaultId } = yield* resolveScope(requested);
    const memberships = yield* store.listMemberships();
    const portfolioOf = new Map(memberships.map((m) => [m.accountId, m.portfolioId]));
    return {
      selectedId,
      defaultId,
      has: (accountId) => inView(portfolioOf.get(accountId), selectedId, defaultId),
      portfolioIdOf: (accountId) => portfolioOf.get(accountId) ?? defaultId,
    };
  });

// 总览装配:账户集 + 当下快照 + 手记注入。24h 盈亏不在这条链上(ADR 0050:盈亏是独立读取,
// 两端相减,原料是「最新快照 + 24 小时前那张快照」,见 ./gain)。
export const buildScopedOverview = (data: PortfolioScope) =>
  Effect.gen(function* () {
    const {
      accounts: accountStore,
      portfolios: portfolioStore,
      snapshots: snapshotStore,
      settings: settingsStore,
      tags: tagStore,
    } = yield* Database;

    const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
    const [allAccounts, snapshots, settings, memberships] = yield* Effect.all(
      [
        accountStore.list(),
        snapshotStore.latest(),
        settingsStore.get(),
        portfolioStore.listMemberships(),
      ],
      { concurrency: 4 },
    );
    const pin = toTabPin(data.pin);
    const tagLinks = pin?.kind === "tag" ? yield* tagStore.listAccountLinks() : [];
    const accounts = accountsMatchingPin(
      accountsInView(allAccounts, memberships, selectedId, defaultId),
      pin,
      tagLinks,
    );
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    yield* injectManualSnapshots(accounts, byAccount);
    const fiatRefs = yield* manualFiatRefs(accounts);
    return yield* buildOverview(accounts, byAccount, {
      connectorMeta: connectorPlatformMeta,
      mode: settings.valuationMode,
      fiatRefs,
    });
  });
