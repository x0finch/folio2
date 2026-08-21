import { AccountStore, PortfolioStore, SettingsStore, SnapshotStore, TagStore } from "@folio/db";
import { Effect } from "effect";
import { accountsInView, accountsMatchingPin, toTabPin } from "../../core/accounts-in-view";
import { connectorPlatformMeta } from "../connectors/platform";
import { injectManualSnapshots, loadManualGainHistory, manualFiatRefs } from "../manual/store";
import { GAIN_BASIS_TOLERANCE_MS, GAIN_WINDOW_MS } from "./gain-24h";
import { buildOverview, type OverviewDeps } from "./overview-model";

// 选中 Portfolio 入参(客户端选择器传的临时选中 id,可空 → 用默认)与其上叠的自定义 Tab pin
// (ADR 0034,按 connector/tag/account 在选中 Portfolio 内再收窄)。zod 校验在 index 装配层,
// 这里只收窄后的普通形状 —— handler 文件不依赖 zod。
interface TabPinScopeInput {
  kind: "connector" | "tag" | "account";
  connectorId?: string;
  tagId?: string;
  accountId?: string;
}
export interface PortfolioScope {
  portfolioId?: string;
  pin?: TabPinScopeInput;
}

// 校验传入的 selectedId 属于该用户,否则退回默认(客户端传入不可信 —— 传别人的 id 只会得到空视图,
// 不泄露任何数据,但显式回退到默认更符合直觉)。返回选中 id + 默认 Portfolio。
export const resolveScope = (
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
export const buildScopedOverview = (data: PortfolioScope, withGain: boolean) =>
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
