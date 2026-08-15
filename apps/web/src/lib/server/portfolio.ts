import {
  AccountStore,
  PortfolioStore,
  SettingsStore,
  SnapshotStore,
  TabPinStore,
  TagStore,
} from "@folio/db";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { z } from "zod";
import { toAccountSections } from "../account-view";
import {
  accountIdsInView,
  accountsInView,
  accountsMatchingPin,
  toTabPin,
} from "../accounts-in-view";
import { connectorLabelFallback } from "../connector-label";
import { defiGainKey, GAIN_BASIS_TOLERANCE_MS, GAIN_WINDOW_MS } from "../gain-24h";
import { buildPortfolioHistory } from "../history";
import { platformLogoUrl } from "../logo";
import { isManual } from "../manual-connector";
import { loadAccountHoldings } from "./internal/account-holdings";
import { connectorPlatformMeta } from "./internal/connector-platform";
import { deriveLiveAccountTotals } from "./internal/live-value";
import {
  injectManualSnapshots,
  loadManualGainHistory,
  loadManualHistoryRows,
  manualFiatRefs,
} from "./internal/manual";
import { runAtEdge, runRequest, runStore, withRequest } from "./internal/oracle";
import { buildOverview, type OverviewDeps } from "./internal/overview-model";
import { requireAuth } from "./internal/require-auth";
import { kindPresence, resolvePinLabel } from "./internal/tab-strip";

// 选中 Portfolio 入参:客户端选择器传的临时选中 id(可空 → 用默认)。缺省 {} 让 loader 不带参调用时退回默认视图。
// 仅按选中 Portfolio scope(曲线 / 列表默认口径);不带 pin。
const PortfolioSelectInput = z.object({ portfolioId: z.string().optional() }).default({});

// overview 入参:在选中 Portfolio 之上再叠一个自定义 Tab 的 pin(ADR 0034)—— 按 connector/tag/account
// 在选中 Portfolio 内再收窄;缺省 = 默认视图(不收窄)。pin 只收窄 overview 的列表,不进曲线(见 getPortfolioHistory)。
const TabPinScope = z
  .object({
    kind: z.enum(["connector", "tag", "account"]),
    connectorId: z.string().optional(),
    tagId: z.string().optional(),
    accountId: z.string().optional(),
  })
  .optional();
const PortfolioScopeInput = z
  .object({ portfolioId: z.string().optional(), pin: TabPinScope })
  .default({});

// 校验传入的 selectedId 属于该用户,否则退回默认(客户端传入不可信 —— 传别人的 id 只会得到空视图,
// 不泄露任何数据,但显式回退到默认更符合直觉)。返回选中 id + 默认 Portfolio。
const resolveScope = (
  requested: string | undefined,
): Effect.Effect<{ selectedId: string; defaultId: string }, never, PortfolioStore> =>
  Effect.gen(function* () {
    const store = yield* PortfolioStore;
    const [portfolios, defaultPf] = yield* Effect.all([store.list(), store.ensureDefault()], {
      concurrency: 2,
    });
    const selectedId =
      requested && portfolios.some((p) => p.id === requested) ? requested : defaultPf.id;
    return { selectedId, defaultId: defaultPf.id };
  });

// 总览装配:账户集 + 当下快照 + 手记注入 + 可选的 24h 盈亏原料。
// `withGain` 是票 5 的切法 —— 总览不再读窗口历史;盈亏读取走同一条装配、把历史带上,
// 于是「各行相加 = hero 那个数」仍是同一个 `computeGain24h` 喂出来的,不是两处各算。
const buildScopedOverview = (data: z.infer<typeof PortfolioScopeInput>, withGain: boolean) =>
  Effect.gen(function* () {
    const accountStore = yield* AccountStore;
    const portfolioStore = yield* PortfolioStore;
    const snapshotStore = yield* SnapshotStore;
    const settingsStore = yield* SettingsStore;
    const tagStore = yield* TagStore;

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
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    yield* injectManualSnapshots(accounts, byAccount);
    const fiatRefs = yield* manualFiatRefs(accounts);
    let gainHistory: OverviewDeps["gainHistory"];
    if (withGain) {
      const inView = new Set(accounts.map((a) => a.id));
      const [snapGain, manualGain] = yield* Effect.all(
        [
          snapshotStore.listBalanceHistory(now - GAIN_WINDOW_MS - GAIN_BASIS_TOLERANCE_MS),
          loadManualGainHistory(accounts, now, now - GAIN_WINDOW_MS),
        ],
        { concurrency: 2 },
      );
      gainHistory = [...snapGain.filter((r) => inView.has(r.accountId)), ...manualGain];
    }
    return yield* buildOverview(accounts, byAccount, {
      connectorMeta: connectorPlatformMeta,
      mode: settings.valuationMode,
      fiatRefs,
      gainHistory,
      now,
    });
  });

export const getPortfolioOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(({ data, context }) =>
    runAtEdge(withRequest(context.userId, buildScopedOverview(data, false))),
  );

// #488 票 5:24h 盈亏独立读取。同一条 `buildScopedOverview(..., true)`,只把盈亏字段带出来。
export const getPortfolioGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(({ data, context }) =>
    runAtEdge(
      withRequest(
        context.userId,
        Effect.gen(function* () {
          const view = yield* buildScopedOverview(data, true);
          const holdings: Record<string, (typeof view.holdings)[number]["gain24h"]> = {};
          for (const h of view.holdings) holdings[h.key] = h.gain24h ?? null;
          const defi: Record<
            string,
            NonNullable<(typeof view.sections)[number]["defi"][number]["gain24h"]> | null
          > = {};
          for (const s of view.sections) {
            for (const g of s.defi) {
              defi[defiGainKey(s.account.id, g.protocol)] = g.gain24h ?? null;
            }
          }
          return { portfolio: view.gain24h ?? null, holdings, defi };
        }),
      ),
    ),
  );

// #488 票 4:首页 tab 条的轻请求。只回答「这个组合里有没有永续 / DeFi、自定义 Tab 叫什么」。
// 不富化价格、不算盈亏、不接手记现造 —— 手记只注入现货,不影响这两个 tab 的有无。
// 标签在服务端解析好(连接器走 registry 的类型名 + 已代理 logo),客户端不再为渲染 tab 名拉目录。
export const getHomeTabStrip = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(({ data, context }) =>
    runRequest(
      context.userId,
      Effect.gen(function* () {
        const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
        const [allAccounts, snapshots, memberships, pins, tags] = yield* Effect.all(
          [
            Effect.flatMap(AccountStore, (s) => s.list()),
            Effect.flatMap(SnapshotStore, (s) => s.latest()),
            Effect.flatMap(PortfolioStore, (s) => s.listMemberships()),
            Effect.flatMap(TabPinStore, (s) => s.list()),
            Effect.flatMap(TagStore, (s) => s.list()),
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
      }),
    ),
  );

// 按账户视图(账户页浏览器 + 详情侧栏用):每个账户 + 其最新快照的富化持仓,**含已归档账户**(ADR 0039)。
// 取数整条抽去了 `internal/account-holdings.ts` —— 这里只留 auth 薄壳,那边才测得到(workers 池要驱动真 D1)。
export const listAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => runRequest(context.userId, loadAccountHoldings()));

// #493 票 3:账户页 24h 盈亏独立读取。同一条 `loadAccountHoldings(true)`,只把盈亏字段带出来。
export const getAccountGain24h = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) =>
    runRequest(
      context.userId,
      Effect.gen(function* () {
        const view = yield* loadAccountHoldings(true);
        const accounts: Record<string, NonNullable<(typeof view.rows)[number]["gain24h"]> | null> =
          {};
        const balances: Record<
          string,
          NonNullable<(typeof view.rows)[number]["balances"][number]["gain24h"]> | null
        > = {};
        for (const r of view.rows) {
          if (r.archivedAt == null) accounts[r.account.id] = r.gain24h ?? null;
          for (const b of r.balances) {
            if (r.archivedAt != null || b.tokenId == null) continue;
            balances[b.id] = b.gain24h ?? null;
          }
        }
        return { accounts, balances };
      }),
    ),
  );

// 组合净值历史:全部快照总额 → 阶梯式重建为时间序列(纯函数,可序列化输出)。
// 「当下点」(最新点)不用快照冻结总额,而是与主页同款**现推实时总价**(deriveLiveAccountTotals,
// self-first 下盯市行取实时源价)→ 主页总价 ≡ 曲线当下点(#81);更早点仍用冻结 usd_value。
export const getPortfolioHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  // **整条链一个 effect,一次装配**(#394 T6):以前这里是 1 次 resolveScope + 5 次门面读 +
  // 1 次 manual 历史(内部逐账户又各装一次)+ 1 次注入 + 1 次实时总价 —— 一个请求切了近十次边界。
  .handler(async ({ data, context }) =>
    runRequest(
      context.userId,
      Effect.gen(function* () {
        const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
        const [rows, allAccounts, snapshots, settings, memberships] = yield* Effect.all(
          [
            Effect.flatMap(SnapshotStore, (s) => s.listTotals()),
            Effect.flatMap(AccountStore, (s) => s.list()),
            Effect.flatMap(SnapshotStore, (s) => s.latest()),
            Effect.flatMap(SettingsStore, (s) => s.get()),
            Effect.flatMap(PortfolioStore, (s) => s.listMemberships()),
          ],
          { concurrency: 5 },
        );
        // 曲线追溯性地只算选中 Portfolio 的当前成员(ADR 0033):
        //  · memberSet = 归属选中的账户(**含已归档**)→ 过去点按它 scope,保留归档成员的历史贡献;
        //  · accounts  = 其中未归档的 → 曲线当下点(live 覆写)只算活跃成员。
        // 把账户移进/移出 Portfolio,这条曲线整条重算(直觉:这钱在这个视图里从来算/不算)。
        // 自定义 Tab(ADR 0034 UI 微调):曲线**不按 pin 收窄** —— pin 只过滤该 Tab 的列表内容,
        // hero 总额/曲线保持选中 Portfolio 口径(用户明确:自定义 Tab 不改 hero)。故历史入参不带 pin(PortfolioSelectInput)。
        const memberSet = accountIdsInView(
          allAccounts.map((a) => a.id),
          memberships,
          selectedId,
          defaultId,
        );
        const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));
        const accounts = accountsInView(allAccounts, memberships, selectedId, defaultId);

        // manual 历史改由账本 compute-on-read 供货(ADR 0018):防御式排除任何遗留 manual snapshot 行(正常为空),
        // 再拼上账本现算的 manual (takenAt, totalUsd) 行 → 同喂 buildPortfolioHistory,不双算、无需特殊合并。
        const now = Date.now();
        const manualIds = new Set(
          memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id),
        );
        const snapRows = rows.filter(
          (r) => !manualIds.has(r.accountId) && memberSet.has(r.accountId),
        );
        // manual 走日网格 compute-on-read(ADR 0019),末点 τ=now → 与下方 live 覆写同刻对齐。
        const manualRows = yield* loadManualHistoryRows(memberAccounts, now);
        // 归档成员的历史贡献保留到归档那一刻为止(ADR 0039)—— 不传这张表的话,它冻住的值会
        // 一路保持到今天,而下面的当下点只算活跃账户,曲线就会「一路平着、到头凭空掉一截」。
        const archivedAt = new Map(
          memberAccounts.flatMap((a) =>
            a.archivedAt == null ? [] : [[a.id, a.archivedAt] as const],
          ),
        );
        const series = buildPortfolioHistory([...snapRows, ...manualRows], archivedAt);
        if (series.length === 0) return { series };

        // 当下点 = 与主页同源同算的实时总价(活跃账户,与 getPortfolioOverview 一致的账户集 + 同一 mode)。
        const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
        // manual 不写快照(ADR 0018):当下点的 manual 净值由 creds 现造注入(过去点仍来自真实快照 totals)。
        yield* injectManualSnapshots(accounts, byAccount);
        const liveTotals = yield* deriveLiveAccountTotals(
          accounts,
          byAccount,
          settings.valuationMode,
        );
        let grand = 0;
        for (const v of liveTotals.values()) grand += v;
        series[series.length - 1] = { ...series[series.length - 1], total: grand };
        return { series };
      }),
    ),
  );

// —— Portfolio 管理(选择器 + 抽屉「移到 Portfolio」用,ADR 0033)——

// 该用户的全部 Portfolio(选择器数据源)+ 默认 id。ensureDefaultPortfolio 保证至少有默认那行。
export const listPortfolios = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [portfolios, defaultPf] = await runStore(context.userId, PortfolioStore, (s) =>
      Effect.all([s.list(), s.ensureDefault()], { concurrency: 2 }),
    );
    return {
      portfolios: portfolios.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
      defaultId: defaultPf.id,
    };
  });

// 把账户移到某 Portfolio:传 portfolioId 移到既有,或传 newName 一步「新建命名 Portfolio + 归属」
// (抽屉「移到 → 新建…」)。至少给其一。返回归属到的 portfolioId(客户端据此可切换选中)。
const MoveAccountInput = z
  .object({
    accountId: z.string().min(1),
    portfolioId: z.string().min(1).optional(),
    newName: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.portfolioId != null || v.newName != null, {
    message: "portfolioId or newName required",
  });
export const moveAccountToPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(MoveAccountInput)
  .handler(async ({ data, context }) => {
    // 建 Portfolio + 归属**一次装配**:它们本来就是一步操作的两半。
    const targetId = await runStore(context.userId, PortfolioStore, (s) =>
      Effect.gen(function* () {
        const id = data.newName
          ? (yield* s.create({ name: data.newName })).id
          : // biome-ignore lint/style/noNonNullAssertion: refine 保证 portfolioId 或 newName 至少其一
            data.portfolioId!;
        yield* s.assignAccount(data.accountId, id);
        return id;
      }),
    );
    return { portfolioId: targetId };
  });

// 新建命名 Portfolio(选择器/移到弹窗的「新建」页;只建、不归属 —— 建完回列表由用户再选,ADR 0033)。
export const createPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ name: z.string().trim().min(1) }))
  .handler(async ({ data, context }) => {
    const pf = await runStore(context.userId, PortfolioStore, (s) => s.create({ name: data.name }));
    return { id: pf.id };
  });

// 该用户全部 账户→Portfolio 归属(账户页按选中 Portfolio 客户端过滤用 —— 账户页已加载全部账户,
// 拿归属表在客户端过滤即可、无需按选中重拉)。
export const listPortfolioMemberships = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => runStore(context.userId, PortfolioStore, (s) => s.listMemberships()));

const PortfolioIdInput = z.object({ portfolioId: z.string().min(1) });

// 改名(含默认)。
export const renamePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput.extend({ name: z.string().trim().min(1) }))
  .handler(async ({ data, context }) => {
    await runStore(context.userId, PortfolioStore, (s) => s.rename(data.portfolioId, data.name));
    return { ok: true as const };
  });

// 设为默认(顶层净值 / 硬刷新的落点随之改)。
export const setDefaultPortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput)
  .handler(async ({ data, context }) => {
    await runStore(context.userId, PortfolioStore, (s) => s.setDefault(data.portfolioId));
    return { ok: true as const };
  });

// 删除(默认不可删):成员退回默认后删该行。
export const deletePortfolio = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PortfolioIdInput)
  .handler(async ({ data, context }) => {
    await runStore(context.userId, PortfolioStore, (s) => s.remove(data.portfolioId));
    return { ok: true as const };
  });
