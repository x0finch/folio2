import {
  AccountStore,
  PortfolioStore,
  SettingsStore,
  SnapshotStore,
  TabPinStore,
  TagStore,
} from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { z } from "zod";
import {
  accountIdsInView,
  accountsInView,
  accountsMatchingPin,
  toTabPin,
} from "../accounts-in-view";
import { GAIN_BASIS_TOLERANCE_MS, GAIN_WINDOW_MS } from "../gain-24h";
import { defiGainKey } from "../gain-merge";
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
import { buildOverview } from "./internal/overview-model";
import { requireAuth } from "./internal/require-auth";

// 读路径耗时打点(#488)。**一次请求一行**,字段固定 → Workers Logs 里能直接按字段聚合。
// 存在的理由不是「日志越多越好」:首页要按数据成本分拍渐进渲染,而「哪一段贵」不能靠读代码猜。
const readLog = getLogger(["folio", "web", "read-path"]);

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
type TabPinScopeInput = z.infer<typeof TabPinScope>;

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

// 一次总览装配 —— **两个 server fn 共用这一步**,只差「读不读 24h 盈亏的原料」。
//
// 拆成两条读之后(#488),它们的取数、注入手记、问价、聚合全都一样;抄一份出来只会让两边慢慢
// 长歪(其中一边改了口径、另一边没改,而屏幕上是同一屏)。差异因此收成一个布尔:
// `withGains` 决定要不要读账本 / 快照历史那两条 —— 那正是两条读的成本差别所在。
//
// **整条链一个 effect,一次装配**(#394 T4)。以前这里切两次 Effect 边界、建两套 store:
// `injectManualSnapshots` 内部 `runRequest` 一次,末尾 `buildOverview` 又一次。现在读账户、
// 读快照、读设置、读归属、注入手记、问价走的是同一份 context —— Effect 官方那句
// 「`run*` 尽量放在程序的边缘」,在 server fn 这条路上边缘就是 handler 本身。
const loadOverviewView = (
  data: { portfolioId?: string; pin?: TabPinScopeInput },
  withGains: boolean,
) =>
  Effect.gen(function* () {
    const accountStore = yield* AccountStore;
    const portfolioStore = yield* PortfolioStore;
    const snapshotStore = yield* SnapshotStore;
    const settingsStore = yield* SettingsStore;
    const tagStore = yield* TagStore;

    const tTotal = performance.now();
    const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
    const scopeMs = performance.now() - tTotal;
    // 「当下」取一次,整条链共用 —— 分段的末点、容差判定、取历史的下界都按同一刻算,
    // 各自现取 `Date.now()` 会在毫秒级上错开(测试里更是直接不可复现)。
    const now = Date.now();
    const tReads = performance.now();
    const [allAccounts, snapshots, settings, memberships, gainHistory] = yield* Effect.all(
      [
        accountStore.list(),
        snapshotStore.latest(),
        settingsStore.get(),
        portfolioStore.listMemberships(),
        // 24h 盈亏的原料(ADR 0040):窗口起点还要往前留一个容差,否则基准快照恰好落在
        // 窗口外时整条线判「算不出」—— 而它明明就在那儿。
        // **不算盈亏就不读**:这是拆开两条读之后总览省下的那一笔。
        withGains
          ? snapshotStore.listBalanceHistory(now - GAIN_WINDOW_MS - GAIN_BASIS_TOLERANCE_MS)
          : Effect.succeed([]),
      ],
      { concurrency: 5 },
    );
    const readsMs = performance.now() - tReads;
    // 聚合边界(ADR 0033):活跃 && 归属选中 Portfolio(未归属账户兜底进默认视图)。
    // 自定义 Tab(ADR 0034):再按 pin(connector/tag)在选中 Portfolio 内收窄;pin=null → 不收窄。
    const pin = toTabPin(data.pin);
    const tagLinks = pin?.kind === "tag" ? yield* tagStore.listAccountLinks() : [];
    const accounts = accountsMatchingPin(
      accountsInView(allAccounts, memberships, selectedId, defaultId),
      pin,
      tagLinks,
    );
    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    const tInject = performance.now();
    // manual 不写快照(ADR 0018):为 manual 账户注入从 creds.tokens 现造的合成当下项。
    yield* injectManualSnapshots(accounts, byAccount);
    const injectMs = performance.now() - tInject;
    const tFiat = performance.now();
    // 法币身份(#271):按 token_id 取各法币持仓的 fiat 命名者 ref → overview 经 fiatCodeOf 算 isFiat
    //(计入净值本就由 spot 聚合负责,这里只补「哪些行是法币」用于稳定占比)。
    const fiatRefs = yield* manualFiatRefs(accounts);
    const fiatMs = performance.now() - tFiat;
    // 盈亏只按视图内的账户算 —— 历史是全量读的(一次查询比按账户分批便宜),这里收窄到
    // 当前 Portfolio / Tab 的账户,否则一个不在视图里的账户会把它的涨跌算进这一屏。
    const inView = new Set(accounts.map((a) => a.id));
    // manual 从不写快照(ADR 0018)→ 它的原料不在上面那次查询里,按账本另算(#447 第 3 片)。
    // 窗口起点直接产点(账本能算任意时刻),所以这里传的是 `now - GAIN_WINDOW_MS` 本身,
    // 而不是上面那个带容差的下界 —— 容差是给稀疏快照留的,账本不需要。
    const tManualGain = performance.now();
    const manualGain = withGains
      ? yield* loadManualGainHistory(accounts, now, now - GAIN_WINDOW_MS)
      : [];
    const manualGainMs = performance.now() - tManualGain;
    return yield* buildOverview(accounts, byAccount, {
      connectorMeta: connectorPlatformMeta,
      mode: settings.valuationMode,
      fiatRefs,
      // 不算盈亏时**一行都不喂**:各行 gain24h 恒 null,由 `getPortfolioGains` 那条读负责。
      gainHistory: withGains
        ? [...gainHistory.filter((r) => inView.has(r.accountId)), ...manualGain]
        : undefined,
      now,
      // `totalMs` 少算了收尾那几步(装饰 + 汇总),但那几步是纯内存的,少算的量正是噪声本身。
      onTimings: ({ enrichMs, gainMs, aggMs, platformMs, sectionsMs, holdings }) =>
        readLog.info(withGains ? "gains timings" : "overview timings", {
          totalMs: Math.round(performance.now() - tTotal),
          scopeMs: Math.round(scopeMs),
          readsMs: Math.round(readsMs),
          injectMs: Math.round(injectMs),
          fiatMs: Math.round(fiatMs),
          manualGainMs: Math.round(manualGainMs),
          enrichMs: Math.round(enrichMs),
          aggMs: Math.round(aggMs),
          gainMs: Math.round(gainMs),
          platformMs: Math.round(platformMs),
          sectionsMs: Math.round(sectionsMs),
          accounts: accounts.length,
          holdings,
          gainRows: gainHistory.length,
        }),
    });
  });

// 总览(P2:按代币聚合)。**不含 24h 盈亏** —— 那部分另走 `getPortfolioGains`(#488),
// 于是这条读不必碰账本与快照历史,列表与总净值不等它。
// scope 到「选中 Portfolio」(ADR 0033):活跃 && 归属选中的账户;缺省选中 = 默认。
export const getPortfolioOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(({ data, context }) =>
    runAtEdge(
      withRequest(
        context.userId,
        Effect.map(loadOverviewView(data, false), (view) => {
          // 盈亏字段**从线上摘掉**,不是留着一片 null。留着的话读到这份数据的人会以为
          // 「算不出」,而真相是「这条读压根不负责它」—— 两件事在界面上长得完全不一样。
          const { gain24h: _portfolioGain, ...rest } = view;
          return {
            ...rest,
            holdings: view.holdings.map(({ gain24h: _g, ...h }) => h),
            sections: view.sections.map((s) => ({
              ...s,
              defi: s.defi.map(({ gain24h: _d, ...g }) => g),
            })),
          };
        }),
      ),
    ),
  );

// 24h 盈亏(ADR 0040),**单独一条读**。慢的是它:窗口内的快照历史 + 手记账本的现算。
// 列表与总净值因此不必等它 —— 它回来之前,那些位置显示的是骨架而不是破折号(见 delta-display 的三态)。
//
// 口径与总览严格同源:同一个装配、同一批持仓线、同一个 `computeGain24h`,所以
// **「各行相加 = hero 那个数」仍然是结构上成立的**,不是两边各算一遍碰对。
export const getPortfolioGains = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioScopeInput)
  .handler(({ data, context }) =>
    runAtEdge(
      withRequest(
        context.userId,
        Effect.map(loadOverviewView(data, true), (view) => ({
          portfolio: view.gain24h,
          // 按持仓键索引 —— 与 `aggregate.groupKey` 同一把键,客户端按 `holding.key` 直接查得到。
          byKey: Object.fromEntries(view.holdings.map((h) => [h.key, h.gain24h ?? null])),
          // DeFi 协议行按 (账户 × 协议) 索引。它带着自己的分母(grossBasis)——跨账户合并协议组时
          // 要用 Σ金额 ÷ Σ总敞口 重算百分比,从 pct 反推分母在 pct 为 0 时推不出来。
          defiByKey: Object.fromEntries(
            view.sections.flatMap((s) =>
              s.defi.map((g) => [defiGainKey(s.account.id, g.protocol), g.gain24h ?? null]),
            ),
          ),
        })),
      ),
    ),
  );

// 首页 tab 条要的**全部**东西,一个轻请求答完:有没有永续 tab、有没有 DeFi tab、自定义 tab 各显示成什么。
//
// **为什么值得单开一条**:tab 条本该比列表先出现,但「有哪些 tab」以前只有总览那个大包裹知道
// (视角 tab 从 sections 推、pin 标签要靠 connector 目录 + 账户清单 + 标签清单在客户端拼)。于是
// 一条 tab 名要等四份数据。这里一条 SQL 问出 kind、顺手把 pin 标签在服务端解析好,tab 条就只等它自己。
//
// **标签在服务端解析**还解决了 #467 那个形状:客户端拼标签时,目录没到就只能先显兜底名,
// 到了再跳一下。服务端解析完再下发,不存在「先错后对」的中间态。
export const getHomeTabMeta = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(PortfolioSelectInput)
  .handler(({ data, context }) =>
    runRequest(
      context.userId,
      Effect.gen(function* () {
        const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
        const [allAccounts, memberships, kinds, pins, tags] = yield* Effect.all(
          [
            Effect.flatMap(AccountStore, (s) => s.list()),
            Effect.flatMap(PortfolioStore, (s) => s.listMemberships()),
            Effect.flatMap(SnapshotStore, (s) => s.latestKinds()),
            Effect.flatMap(TabPinStore, (s) => s.list()),
            Effect.flatMap(TagStore, (s) => s.list()),
          ],
          { concurrency: 5 },
        );
        // 视角 tab 的存在性按**选中 Portfolio** 的账户判(与列表同口径,ADR 0033)。
        const inView = accountIdsInView(
          allAccounts.map((a) => a.id),
          memberships,
          selectedId,
          defaultId,
        );
        const kindsInView = kinds.filter((k) => inView.has(k.accountId));
        // pin 标签**跨 Portfolio 显示**(pin 是 per-user 的),所以按全量账户/标签解析,不收窄到视图内。
        const accountName = new Map(allAccounts.map((a) => [a.id, a.label]));
        const tagName = new Map(tags.map((t) => [t.id, t.name]));
        return {
          // pin 选择器的备选。**一并放在这里**,是为了让 tab 条真的只等这一个请求 ——
          // 备选留在客户端就还得拉连接器目录 + 账户清单 + 标签清单,tab 条又变回等四份数据。
          // 三个口径与拆分前逐字对齐:connector 取全量账户去重(pin 跨 Portfolio),
          // tag 按**选中** Portfolio 过滤(账户只匹配同 Portfolio 的标签),account 取视图内。
          pickerOptions: {
            connectors: [...new Set(allAccounts.map((a) => a.connectorId))].map((id) => ({
              id,
              label: connectorPlatformMeta(id)?.name ?? id,
            })),
            tags: tags
              .filter((tg) => tg.portfolioId === selectedId)
              .map((tg) => ({ id: tg.id, name: tg.name })),
            accounts: allAccounts
              .filter((a) => inView.has(a.id))
              .map((a) => ({ id: a.id, label: a.label })),
          },
          hasPerps: kindsInView.some((k) => k.kind === "perp_position" || k.kind === "perp_equity"),
          hasDefi: kindsInView.some((k) => k.kind === "defi"),
          pins: pins.map((p) => ({
            id: p.id,
            kind: p.kind,
            connectorId: p.connectorId ?? undefined,
            tagId: p.tagId ?? undefined,
            accountId: p.accountId ?? undefined,
            // connector 的显示名走连接器 manifest(类型名,不是账户自定义名);认不出就留空,
            // 由客户端那层照旧回退 —— 这里不编一个名字出来。
            text:
              p.kind === "tag"
                ? (tagName.get(p.tagId ?? "") ?? "")
                : p.kind === "account"
                  ? (accountName.get(p.accountId ?? "") ?? "")
                  : (connectorPlatformMeta(p.connectorId ?? "")?.name ?? ""),
            logo:
              p.kind === "connector"
                ? platformLogoUrl(
                    p.connectorId ?? "",
                    connectorPlatformMeta(p.connectorId ?? "")?.logo,
                  )
                : undefined,
          })),
        };
      }),
    ),
  );

// 按账户视图(账户页浏览器 + 详情侧栏用):每个账户 + 其最新快照的富化持仓,**含已归档账户**(ADR 0039)。
// 取数整条抽去了 `internal/account-holdings.ts` —— 这里只留 auth 薄壳,那边才测得到(workers 池要驱动真 D1)。
export const listAccountHoldings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => runRequest(context.userId, loadAccountHoldings()));

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
        const tTotal = performance.now();
        const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
        const tReads = performance.now();
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
        const readsMs = performance.now() - tReads;
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
        // 空序列直接返回 —— 打一行再走,免得「没数据」这条最快的路在日志里缺席、拉偏分布。
        const logHistory = () =>
          readLog.info("history timings", {
            totalMs: Math.round(performance.now() - tTotal),
            readsMs: Math.round(readsMs),
            snapRows: snapRows.length,
            manualRows: manualRows.length,
            points: series.length,
          });
        if (series.length === 0) {
          logHistory();
          return { series };
        }

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
        logHistory();
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
