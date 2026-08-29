import { type AccountSafe, Database, type SnapshotWithBalances } from "@folio/db";
import { Oracle } from "@folio/oracle";
import type { PlatformMeta, ValuationMode } from "@folio/oracle-basic";
import { Effect } from "effect";
import { z } from "zod";
import {
  accountsInView,
  accountsMatchingPin,
  inView,
  type TabPinScope,
  toTabPin,
} from "@/lib/core/accounts-in-view";
import {
  buildOverview,
  deriveLiveAccountTotals,
  GAIN_BASIS_TOLERANCE_MS,
  GAIN_WINDOW_MS,
  type GainHistoryRow,
  overviewChainIds,
  overviewEligibleBalances,
  overviewEnrichIds,
  type TokenView,
  toTokenView,
} from "@/lib/core/portfolio";
import { refreshableTokenIds } from "@/lib/core/token-model";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";
import {
  injectManualSnapshots,
  loadManualGainHistory,
  manualFiatRefs,
} from "@/lib/server/manual/store";

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

// 一份「当前快照原料」—— 账户集 + 当下快照(含手记注入)+ buildOverview 要的三份字典 + 口径。
// **只取行 + 按 scope 筛 + 备料,不聚合**。总览计算(`buildScopedOverview`)与快照原料读接口
// (`snapshot-data.ts` 的 `handleGetPortfolioSnapshotData`)共用这一份 —— 于是「服务端算」与
// 「浏览器算」喂进 `buildOverview` 的是同一批原料,两条路逐值一致是结构上成立的。
export interface ScopedMaterials {
  accounts: AccountSafe[];
  byAccount: Map<string, SnapshotWithBalances>;
  enriched: ReadonlyMap<string, TokenView>;
  platformMeta: ReadonlyMap<string, PlatformMeta>;
  fiatRefs: Map<string, string>;
  mode: ValuationMode;
  // 「当下」那一刻。手记注入 / 盈亏窗口都用它,一份装配里恒是同一个值。
  now: number;
  // 解析后的当前组合 id(补算 / 预计算写键要它)。
  selectedId: string;
}

export const scopedSnapshotMaterials = (data: PortfolioScope) =>
  Effect.gen(function* () {
    const {
      accounts: accountStore,
      portfolios: portfolioStore,
      snapshots: snapshotStore,
      settings: settingsStore,
      tags: tagStore,
    } = yield* Database;

    const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
    const now = Date.now();
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
    // **只留在 scope 内的账户的快照**(ADR 0047:作用域在服务端定)。`buildOverview` 本就只按
    // `accounts` 取,不筛也算得对;但快照原料要发给浏览器,别把别的组合 / 被 pin 排除的账户的
    // 明细一起下发。
    const inScope = new Set(accounts.map((a) => a.id));
    const byAccount = new Map(
      snapshots
        .filter((s) => inScope.has(s.snapshot.accountId))
        .map((s) => [s.snapshot.accountId, s]),
    );
    // 手记退出快照(ADR 0018)→ 其合成余额按 `now` 注入(显式传,让本次装配的时刻一致 / 可对拍)。
    yield* injectManualSnapshots(accounts, byAccount, now);
    const fiatRefs = yield* manualFiatRefs(accounts);
    // 薄适配层(FOL-45):在 Effect 里备好 buildOverview 要的两份字典。富化一次覆盖聚合行 ∪ defi 行
    // (`overviewEnrichIds`);链键去掉连接器自带展示的场馆键(`overviewChainIds`)。
    const { tokens, platforms } = yield* Oracle;
    const [enrichedRecords, platformMeta] = yield* Effect.all(
      [
        tokens.enrich(overviewEnrichIds(accounts, byAccount)),
        platforms.resolve(overviewChainIds(accounts, byAccount, connectorPlatformMeta)),
      ],
      { concurrency: 2 },
    );
    // 上游 URL 挡在这里:参考层读出的完整行 → 瘦身 `TokenView`(logo 只留「有没有图」布尔)。
    // 现算路径与下发浏览器的原料共用它,两条路喂 buildOverview 的富化逐值一致。
    const enriched = new Map([...enrichedRecords].map(([id, r]) => [id, toTokenView(r)] as const));
    return {
      accounts,
      byAccount,
      enriched,
      platformMeta,
      fiatRefs,
      mode: settings.valuationMode,
      now,
      selectedId,
    } satisfies ScopedMaterials;
  });

// 总览装配:共用原料 + 手记注入 + 可选的 24h 盈亏原料 → `buildOverview`。
// `withGain` 是票 5 的切法 —— 总览不再读窗口历史;盈亏读取走同一条装配、把历史带上,
// 于是「各行相加 = hero 那个数」仍是同一个 `computeGain24h` 喂出来的,不是两处各算。
export const buildScopedOverview = (data: PortfolioScope, withGain: boolean) =>
  Effect.gen(function* () {
    const { accounts, byAccount, enriched, platformMeta, fiatRefs, mode, now } =
      yield* scopedSnapshotMaterials(data);

    let gainHistory: readonly GainHistoryRow[] | undefined;
    if (withGain) {
      const snapshotStore = (yield* Database).snapshots;
      const inScope = new Set(accounts.map((a) => a.id));
      const [snapGain, manualGain] = yield* Effect.all(
        [
          snapshotStore.listBalanceHistory(now - GAIN_WINDOW_MS - GAIN_BASIS_TOLERANCE_MS),
          loadManualGainHistory(accounts, now, now - GAIN_WINDOW_MS),
        ],
        { concurrency: 2 },
      );
      gainHistory = [...snapGain.filter((r) => inScope.has(r.accountId)), ...manualGain];
    }
    // 每账户现推净值复用同一份富化字典;刷价集合喂 pricesStale 判脏。
    const liveTotals = deriveLiveAccountTotals(accounts, byAccount, enriched, mode);
    const refreshableIds = new Set(
      refreshableTokenIds(overviewEligibleBalances(accounts, byAccount)),
    );
    return buildOverview(accounts, byAccount, {
      enriched,
      liveTotals,
      platformMeta,
      refreshableIds,
      connectorMeta: connectorPlatformMeta,
      mode,
      fiatRefs,
      gainHistory,
      now,
    });
  });
