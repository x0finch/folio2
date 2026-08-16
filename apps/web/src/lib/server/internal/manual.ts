import {
  type AccountSafe,
  AccountStore,
  type ManualActivity,
  type ManualActivityPatch,
  type ManualHolding,
  ManualStore,
  SnapshotStore,
  type SnapshotWithBalances,
} from "@folio/db";
import { FxService, TokenService } from "@folio/oracle";
import { dayBucketOf, FIAT_NAMER, fiatCodeOf, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { Effect } from "effect";
import type { SnapshotTotalRow } from "../../core/history";
import type { CredsToken } from "../../core/manual";
import {
  buildManualAccountSeries,
  deriveAmount,
  fallbackUnitPrice,
  type HistoricalPriceAt,
  type HistoryToken,
  projectToken,
  tokenPriceAt,
  tokenQuantityAt,
} from "../../core/manual";
import { isManual, MANUAL_CONNECTOR_ID } from "../../core/manual-connector";
import type { GainHistoryRow } from "./gain-24h";
import { type BatchDraft, planManualBatch, runningOk, type Token } from "./manual-batch";
import { buildManualSnapshot, manualUnitPrices } from "./manual-snapshot";
import { NAMER } from "./oracle";
import type { BalanceLike } from "./tokens";

// 折叠数量的浮点容差(与 manual-batch 一致):目标 amount 与当前 derived 差在此内视为相等。
const AMOUNT_EPS = 1e-9;

// **物化没有了**(#203)。原来每次写完都要把「各 token 定义 + 折叠出的 amount」写回
// `creds.tokens`,给 manual provider 读。四个值全部落进真表之后 provider 只是「app 写进 JSON 列 →
// 再读回来」的空转,连它一起删了 —— 于是「单写者」那条不变量、以及它带来的「忘了重跑就 stale」
// 这类 bug 面,整个消失。持仓一律 compute-on-read(deriveAmount 现算)。

// 手记持仓 → tokenRef(#203 起住在 app;原来在已删除的 manual provider 包里)。
//
// **写路径的东西,所以住在服务端这一侧。** 它一度和 `isManual` 同住 `lib/manual-connector.ts`,
// 而那个文件被组件 import(渲染哪套字段要问「是不是手记」)—— 于是每个组件都顺带把 tokenRef
// 文法包拖进了客户端的依赖图。tree-shaking 当时确实摘掉了它,但那是打包器的结果、不是不变量。
//
// 选了币 → 用户那张票解出来的 ref 就是答案。**上游命名的 ref 在 mint 里本身就是锚** ——
// 不查映射表、也不掉回 symbol 去猜。
// 没选 → `manual/custom:<名字>`。`custom:` 说的是**这个名字没有注册表背书** —— 用户在
// 「找不到?手动输入」里敲的东西,意思恰恰是「不是列表里那个」,所以 mint 不拿它去认币
// (ADR 0020 第四轮 / #223)。认不出来就自己一行,用用户填的单价估值。
// 两种都是规范 ref,没有「空着」这一档。
const manualTokenRef = (picked: { symbol: string; ref?: string | null }): string =>
  picked.ref || tokenRef.custom(MANUAL_CONNECTOR_ID, picked.symbol);

// 一条手记持仓要用的 token id:先定 ref,再经 mint 换出 id(纯本地)。
//
// **解票就在这一处**(#202b)。表单交上来的 `ticket` 是一串 base64url,里头是选币那一刻
// 上游对这个币的命名。解不开 / 不合文法 / **命名者不是当前那位** → 当作「没选币」,
// 退回 `manual/custom:<名字>`(而那一支不会被拿去认币,#223)。
//
// 命名者那一句必须有:票没有签名,谁都能自己编一张。手编 `<随便什么>/issued:<随便什么>`
// 塞进来的话,mint 会掉到 symbol 那一档,用户手敲的 symbol 就又成了可信线索。
// 所以 `decode` 收 NAMER —— 「这是我们发出去的那张」只能靠内容自证(见 tokenTicket)。
const mintHolding = (picked: {
  symbol: string;
  ticket?: string | null;
}): Effect.Effect<string, never, TokenService> =>
  Effect.gen(function* () {
    const ref = manualTokenRef({
      symbol: picked.symbol,
      // 票的命名者可以是当前上游(加密币)或 `fiat`(法币,ADR 0025 / #272)—— 两者都是我们发的,
      // 都放行;别家命名者仍被挡(#223)。解出的 fiat ref 交给 mint 建 canonical 法币行(#270)。
      ref: picked.ticket ? tokenTicket.decode(picked.ticket, [NAMER, FIAT_NAMER]) : undefined,
    });
    const symbol = picked.symbol.trim().toUpperCase();
    const ids = yield* Effect.flatMap(TokenService, (t) => t.mint([{ ref, seed: { symbol } }]));
    const id = ids.get(ref);
    if (!id) throw new Error(`mint produced no token for ${ref}`);
    return id;
  });

// manual 加账户(ADR 0017 特例):前端已把首 token 提交为 `creds.tokens`(单元素 JSON),且已由
// createAccount 的通用 validateAccountCreds(provider 的 manualToken schema)校验过。这里取首 token →
// 建账户 + 首 token 行 + 一条开仓 set 活动 → materialize 把账本折叠回 creds.tokens(单写者)。
// 多 token 录入 UI 见 T4。
export const createManualAccount = (
  label: string,
  tokens: string,
): Effect.Effect<AccountSafe, never, AccountStore | ManualStore | TokenService> =>
  Effect.gen(function* () {
    const [first] = JSON.parse(tokens) as Array<{
      symbol: string;
      unitPrice: number | string;
      ticket?: string;
      amount: number | string;
    }>;
    // validateAccountCreds 用的 z.array 允许空数组 → 显式挡掉(表单恒发 1 条,防御式)。
    if (!first) throw new Error("manual account requires at least one token");
    const manualStore = yield* ManualStore;
    const account = yield* Effect.flatMap(AccountStore, (s) =>
      s.create({
        connectorId: MANUAL_CONNECTOR_ID,
        label,
        creds: JSON.stringify({ tokens: "[]" }),
      }),
    );
    const tokenId = yield* mintHolding(first);
    yield* manualStore.setHoldingDef(tokenId, { symbol: first.symbol.trim().toUpperCase() });
    // **开仓价进账本,不进 tokens 那一列。** 表单里那个「单价」就是开仓那一刻的价 —— 它是账本里
    // 的第一笔事实,不是一条压过后续所有成交的声明。原来它写进 `tokens.self_price`,于是同一个
    // 「这个币值多少」有两个存处,而其中一个可以存歪(实测:SSGS 卡在 0 上治不好)。
    // 现在价只有账本一个来源(见 manual-activity 的 fallbackUnitPrice)。
    yield* manualStore.recordActivity(account.id, tokenId, {
      kind: "set",
      amount: Number(first.amount),
      price: Number(first.unitPrice) > 0 ? Number(first.unitPrice) : null,
      occurredAt: Date.now(),
    });
    return account;
  });

// 该用户**活跃** manual 账户的 (accountId → tokens)。injector 与预热共用。
// **compute-on-read**(ADR 0018/0019):amount 由账本 deriveAmount 现算,不读物化的 creds.tokens ——
// 否则「当下」净值(主页/账户/抽屉头 + 抽屉曲线末点实时覆写)会卡在上次物化的 stale 值(如删掉更早活动后
// creds 未及重物化,或折叠语义修正前写入的旧值)。定义(symbol/unitPrice/ref)取自 `tokens` 那一行。
// 排除归档:归档 manual 不进 enrich 门(injector 的调用点已按 active 过滤)→ 预热/刷价也不该碰它,三门同源。
// **只剩 Effect 一条路**(#394 T6):T4 那阵这里是「Promise 版 + `*E` 版」并存的过渡形状,
// 现在全部调用方都在 effect 里了,重复的那半删掉。
const manualTokensByAccount = (
  accounts: AccountSafe[],
): Effect.Effect<{ id: string; tokens: CredsToken[] }[], never, ManualStore> => {
  const manual = accounts.filter((a) => isManual(a.connectorId) && a.archivedAt == null);
  if (manual.length === 0) return Effect.succeed([]);
  return Effect.forEach(
    manual,
    (a) =>
      Effect.map(loadTokensWithActivities(a.id), (rows) => ({
        id: a.id,
        tokens: rows.map(({ token, activities }) => projectToken(token, activities)),
      })),
    { concurrency: "unbounded" },
  );
};

// 法币身份的 ref 供给(#271):tokenId → 该 token 在 fiat 命名者(`fiat/issued:<CODE>`)下的 ref。
// 法币目前只来自 manual(链上/CEX 报法币余额不在范围),故只扫活跃 manual 账户;`TokenRecord.ref` 走的是
// 上游(CGK)那一档、法币恒 null(且 ADR 0021 把它定义成「上游认没认出」),所以身份单独按 FIAT_NAMER 取。
export const manualFiatRefs = (
  accounts: AccountSafe[],
): Effect.Effect<Map<string, string>, never, ManualStore> =>
  Effect.gen(function* () {
    const store = yield* ManualStore;
    const manual = accounts.filter((a) => isManual(a.connectorId) && a.archivedAt == null);
    const out = new Map<string, string>();
    const perAccount = yield* Effect.forEach(manual, (a) => store.listHoldings(a.id, FIAT_NAMER), {
      concurrency: "unbounded",
    });
    for (const holdings of perAccount) {
      for (const h of holdings) if (h.ref) out.set(h.id, h.ref);
    }
    return out;
  });

// manual 退出 snapshot 后(ADR 0018 做法 1),其「当下」合成余额注入 `byAccount` —— overview/history 三处消费点
// 拼好 byAccount 后各调一次。value = amount × 现价(cache-only enrich 取,与 deriveLiveAccountTotals 同门盯市;
// 取不到回退 unitPrice,见 buildManualSnapshot)。归档 manual 不在传入的 accounts 里 → 不注入。takenAt 仅占位
// (UI 对 manual 显「实时」)。
//
// **缓存冷 → 回退用户自填价**:enrich 是 cache-only,新 mint 的行「有身份、无价」→ prices 为
// undefined → buildManualSnapshot 回退 `unitPrice`;价在同步的 warmHeldPrices / 前端 refreshStalePrices
// 里补上,补上后展示即市价。**用户自填价不被市价盖**(#223 / #227):没选币的币其 token 行 `ref`
// 为空、从不链 CGK,永远回不出市价,自填价恒赢。
// 法币持仓的展示价走 FX(ADR 0025 / #270 / #272):现算不冻价,取不到汇率照旧回退自填价。
// **法币身份按 tokenId 从 `fiatRefs` 判**,不靠 `CredsToken.ref`(那是 CGK 档、法币恒 null,#272)。
export const injectManualSnapshots = (
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  takenAt: number = Date.now(),
): Effect.Effect<void, never, ManualStore | TokenService | FxService> =>
  Effect.gen(function* () {
    const list = yield* manualTokensByAccount(accounts);
    if (list.length === 0) return;
    const fiatRefs = yield* manualFiatRefs(accounts);
    const enriched = yield* Effect.flatMap(TokenService, (t) =>
      t.enrich(list.flatMap(({ tokens }) => tokens.map((tk) => tk.id))),
    );
    yield* Effect.forEach(list, ({ id, tokens }) =>
      Effect.map(manualUnitPrices(tokens, enriched, fiatRefs), (prices) => {
        byAccount.set(id, buildManualSnapshot(id, tokens, prices, takenAt));
      }),
    );
  });

// 归档 = 封存(ADR 0039):**manual 账户从不写快照**(ADR 0018),持仓是每次读的时候从账本现算的,
// 所以库里根本不存在一张可以拿来展示的照片 —— 归档之后它就是一具空壳。这里在归档那一刻按账本算一次、
// 落一张**真的**快照下来,之后它和链上账户走同一条读路径。
//
// **复用注入那条路**,不另写一套:它已经把「账本 → 合成余额 → 现价 / 取不到回退自填价」整条做完了,
// 再抄一遍就等于给「manual 此刻值多少」开第二个答案。
//
// 传进来的账户必须**还没被打上归档标记** —— 注入那条路按 `archivedAt == null` 过滤(见
// `manualTokensByAccount`),打完标记再来这里会一无所获。调用点的顺序因此不是风格问题,见 accounts.ts。
//
// 返回是否真的落了一张:非 manual 账户不落(它们本来就有快照,再补一张没有新信息)。
export const sealManualAccount = (
  account: AccountSafe,
  takenAt: number = Date.now(),
): Effect.Effect<boolean, never, ManualStore | SnapshotStore | TokenService | FxService> =>
  Effect.gen(function* () {
    if (!isManual(account.connectorId)) return false;
    const byAccount = new Map<string, SnapshotWithBalances>();
    yield* injectManualSnapshots([account], byAccount, takenAt);
    const built = byAccount.get(account.id);
    // 一个持仓都没有的 manual 账户:注入那条路会跳过它(空 tokens)。此时不落空快照 ——
    // 空快照与「从没同步过」在读端长得一样,却多一行没有内容的历史。
    if (!built) return false;
    yield* Effect.flatMap(SnapshotStore, (s) =>
      s.write(account.id, {
        takenAt,
        totalUsd: built.snapshot.totalUsd,
        balances: built.balances.map((b) => ({
          amount: b.amount,
          usdValue: b.usdValue,
          kind: b.kind,
          platform: b.platform ?? undefined,
          tokenId: b.tokenId ?? undefined,
        })),
      }),
    );
    return true;
  });

// 预热用:该用户全部 manual 账户的合成余额(供 warmTokens 把其代币现价取进缓存)。manual 已退出 snapshot,
// 故预热不能只从快照收集币 —— 否则纯 manual 用户的币永远暖不到、拿不到实时价(ADR 0018 T2 实施细化)。
export const manualBalancesForWarm = (
  accounts: AccountSafe[],
): Effect.Effect<BalanceLike[], never, ManualStore> =>
  Effect.map(manualTokensByAccount(accounts), (list) =>
    list.flatMap(({ id, tokens }) => buildManualSnapshot(id, tokens, [], 0).balances),
  );

// —— T3 写路径(#155):token CRUD + 批量活动(原子)+ 删/改活动 ——
// server fn(manual-mutations.ts)只做 auth 薄壳后调这些纯 async(可在 workers-pool 集成测,不引 createServerFn)。
// **不再有物化那一步**(#203):持仓一律 compute-on-read,写路径只落事实(声明 + 活动)。
// 决策逻辑(解析/收养/超支校验)下沉纯模块 manual-batch;这里只做加载 + 调用 + 物化(ADR 0017)。

export interface CreateTokenInput {
  accountId: string;
  symbol: string;
  unitPrice: number;
  ticket?: string | null;
  amount: number;
}
export interface UpdateTokenInput {
  accountId: string; // #203:token 不再自带账户(一个币可被多个手记账户持有)→ 调用方必须带
  tokenId: string;
  symbol: string;
  unitPrice: number;
  amount: number;
}
export type ManualWriteResult = { ok: true } | { ok: false; reason: "overdraw"; symbol?: string };

// 某账户的各 token 定义 + 各自活动(按 tokenId 归并)。**唯一加载器**:一次账户级活动读 + 分组,消 N+1;
// 写校验(loadTokens)、抽屉明细(loadManualAccountDetail)、价值历史(loadHistoryTokens)三处读路径共用,
// 各自再投影成所需形状。DB 层 token_id 可空(迁移遗留)→ 防御式跳过。
const loadTokensWithActivities = (
  accountId: string,
): Effect.Effect<{ token: ManualHolding; activities: ManualActivity[] }[], never, ManualStore> =>
  Effect.gen(function* () {
    const store = yield* ManualStore;
    const [tokens, activities] = yield* Effect.all(
      [store.listHoldings(accountId, NAMER), store.listActivityByAccount(accountId)],
      { concurrency: 2 },
    );
    return foldActivitiesByToken(tokens, activities);
  });

// 两条路共用的纯折叠:活动按 tokenId 归到各自的持仓下。
function foldActivitiesByToken(
  tokens: ManualHolding[],
  activities: ManualActivity[],
): { token: ManualHolding; activities: ManualActivity[] }[] {
  const byToken = new Map<string, ManualActivity[]>();
  for (const a of activities) {
    if (a.tokenId == null) continue;
    const arr = byToken.get(a.tokenId) ?? [];
    arr.push(a);
    byToken.set(a.tokenId, arr);
  }
  return tokens.map((token) => ({ token, activities: byToken.get(token.id) ?? [] }));
}

// manual-batch 的 Token[](写路径超支校验用)。ManualActivity 结构含 DerivableActivity。
const loadTokens = (accountId: string): Effect.Effect<Token[], never, ManualStore> =>
  Effect.map(loadTokensWithActivities(accountId), (rows) =>
    rows.map(({ token, activities }) => ({
      id: token.id,
      symbol: token.symbol,
      activities,
    })),
  );

// —— 读:抽屉账户明细(T4,#156)——
// creds.tokens(= balances 投影)不含 token 的 DB id、也不含活动账本 → 抽屉的编辑/删除与 Activity tab 需专门读。
// 返回 tokens(带 DB id + 折叠出的 amount)+ 全部活动(各自带 tokenId,供 Activity tab 按 token 归并展示)。
// UI 的 logo/name/实时市值仍从 balances(overview)取,按 symbol 匹配 —— 本读只出账本事实。
//
// `ticket` 与选币下拉发的是同一种串(#202b):抽屉要能把「这个持仓当初选的是哪个币」放回
// combobox 里显示,所以读路径也得给一张票。库里存的是当前命名者下的叫法,编票在这里做 ——
// **前端两个方向都只见到票**。没认出来的币没有票(null),UI 那边就是「手动输入的 symbol」。
interface ManualAccountDetailToken {
  id: string;
  symbol: string;
  unitPrice: number | null; // 声明价;空 = 从没声明过(编辑表单据此显示空而不是 0)
  ticket: string | null;
  amount: number;
}
export interface ManualAccountDetail {
  tokens: ManualAccountDetailToken[];
  activities: ManualActivity[];
}
export const loadManualAccountDetail = (
  accountId: string,
): Effect.Effect<ManualAccountDetail, never, ManualStore> =>
  Effect.gen(function* () {
    const [perToken, fiatRefById] = yield* Effect.all(
      [loadTokensWithActivities(accountId), accountFiatRefs(accountId)],
      { concurrency: 2 },
    );
    return {
      tokens: perToken.map(({ token, activities }) => {
        // 法币在 coingecko 那档无 ref(`token.ref` 恒 null),身份在 fiat 命名者下 → 用那条 ref 编票。
        // 不然抽屉/侧边栏拿到的法币持仓没有票:再选它会掉进「手动输入 symbol」→ 提交时 mint 成一条
        // **自定义币**(`manual/custom:EUR`)而非原来的法币,还被 ownedOptions 的「有票才收」滤掉。
        // 有了 fiat 票,前端把它当选中的法币放回下拉、再选也 mint 回同一条(#272),owned 组也收得进。
        const ref = token.ref ?? fiatRefById.get(token.id) ?? null;
        return {
          id: token.id,
          symbol: token.symbol,
          // 抽屉要的是「这个币现在按多少算」—— 给**解好的**那个价(账本最近一笔),
          // 而不是某一列的原始值。市场认识它时展示侧仍会用市价覆盖。
          unitPrice: fallbackUnitPrice(activities),
          // 票就是那条 ref 原样编一层 —— app 不拼、不拆、不知道命名者是谁(见 ManualHolding.ref)。
          ticket: ref ? tokenTicket.encode(ref) : null,
          amount: deriveAmount(activities),
        };
      }),
      activities: perToken.flatMap(({ activities }) => activities),
    };
  });

// —— 读:价值历史 compute-on-read(T5,#157,ADR 0018)——
// manual 账户不写 snapshot → 其历史由账本现算。共用 loadTokensWithActivities(消 N+1),投影成 HistoryToken[]
// 喂 buildManualAccountSeries 折出 (takenAt, totalUsd) 阶梯序列。ManualActivity 结构含 HistoryActivity
// (price 参与 price@T 降级链②,见 manual-history)。
const loadHistoryTokens = (accountId: string): Effect.Effect<HistoryToken[], never, ManualStore> =>
  Effect.gen(function* () {
    const [perToken, fiatRefById] = yield* Effect.all(
      [loadTokensWithActivities(accountId), accountFiatRefs(accountId)],
      { concurrency: 2 },
    );
    return perToken.map(({ token, activities }) => {
      const fiatRef = fiatRefById.get(token.id);
      const fiatCode = fiatRef ? fiatCodeOf(fiatRef) : undefined;
      return {
        id: token.id,
        // 曲线那条链的第 ③ 档(平线兜底)。账本成了唯一来源之后 ② 已经覆盖了它能覆盖的一切,
        // 这一档只剩「连一笔带价的活动都没有」那种情况 → 没有别的可退,0。
        unitPrice: 0,
        // 法币恒 recognized(历史价 = 当天汇率,由 buildHistoricalPriceAt 灌进 priceAt);
        // 非法币仍按「coingecko 那档认没认出」判(ADR 0021 全局约定不动)。
        recognized: fiatCode != null || token.ref != null,
        fiatCode,
        activities,
      };
    });
  });

// 某账户内 tokenId → 该 token 在 fiat 命名者下的整条 ref(`fiat/issued:<CODE>`,白名单命中的才收)。
// 法币在 coingecko 那档无 ref(`token.ref` 恒 null),身份只在 FIAT_NAMER 下 —— 换命名者查
// listManualHoldingsByAccount 拿到它(#271)。历史曲线要它派生 CODE、明细要它编票(见 loadManualAccountDetail)。
const accountFiatRefs = (
  accountId: string,
): Effect.Effect<Map<string, string>, never, ManualStore> =>
  Effect.gen(function* () {
    const store = yield* ManualStore;
    const out = new Map<string, string>();
    for (const h of yield* store.listHoldings(accountId, FIAT_NAMER)) {
      if (h.ref && fiatCodeOf(h.ref)) out.set(h.id, h.ref);
    }
    return out;
  });

// 异步 oracle 历史价 → 同步注入闭包(ADR 0019)。按 token 区间一次预取 priceSeries(内部缓存过去日),
// 建 Map<tokenId, Map<dayBucket, unitPrice>>,再包成 buildManualAccountSeries 要的同步 (tokenId, t) 查询。
// 每个币一次网络(之后全缓存命中);取不到的日 → 闭包返 undefined → 纯层降级链落 ②③。
const buildHistoricalPriceAt = (
  tokens: HistoryToken[],
  now: number,
): Effect.Effect<HistoricalPriceAt, never, TokenService | FxService> =>
  Effect.gen(function* () {
    const byIdentifier = new Map<string, Map<number, number>>();
    yield* Effect.forEach(
      tokens,
      (tk) =>
        Effect.gen(function* () {
          // 上游没认出来的币不问历史价(问了也没有)。
          if (!tk.recognized || tk.activities.length === 0 || byIdentifier.has(tk.id)) return;
          const from = Math.min(...tk.activities.map((a) => a.occurredAt));
          const daily = new Map<number, number>();
          // 法币:历史价 = **当天汇率**(ADR 0026),从 fx-history 取而不是币价历史(法币无币价)。
          // 其余:按 token_id 取币价历史(#203,priceSeries 收内部 id)。两条都灌进同一个 priceAt 闭包,
          // 纯层 tokenPriceAt 的第 ① 档对法币照常生效(它只看 recognized,不认识 fiat)。
          const series = tk.fiatCode
            ? yield* Effect.flatMap(FxService, (fx) =>
                fx.rateSeries(tk.fiatCode as string, from, now),
              )
            : yield* Effect.flatMap(TokenService, (t) => t.priceSeries(tk.id, from, now));
          for (const pt of series) daily.set(dayBucketOf(pt.atMs), pt.unitPrice);
          byIdentifier.set(tk.id, daily);
        }),
      // 每个币一次取数,**顺序跑**(迁移前是 `Promise.all` 的隐式全并发)—— 一个 manual 账户
      // 的币数是个位数,而它们共用同一把限频额度,并发只会把突发额度更快抽干。
      { concurrency: 1, discard: true },
    );
    return (tokenId: string, t: number) => byIdentifier.get(tokenId)?.get(dayBucketOf(t));
  });

// 单 manual 账户的账本价值序列(抽屉头部 chart 用;getAccountValueHistory 对 manual 走此)。
// ADR 0019:日网格采样 + 注入 oracle 历史价(priceAt);取不到者降级链落账本价②/unitPrice③。
// now 由调用方传入(与 live 末点同源 → 端点对齐);缺省 Date.now()。
export const loadManualAccountSeries = (
  accountId: string,
  now: number = Date.now(),
): Effect.Effect<SnapshotTotalRow[], never, ManualStore | TokenService | FxService> =>
  Effect.gen(function* () {
    const tokens = yield* loadHistoryTokens(accountId);
    const priceAt = yield* buildHistoricalPriceAt(tokens, now);
    return buildManualAccountSeries(accountId, tokens, now, priceAt);
  });

// 单 manual 账户「当下」实时盯市总额(抽屉曲线末点接它 → 端点与抽屉头 account.totalUsd 同源盯市,不因
// 账本价/unitPrice 而与头部数值打架)。复用 injectManualSnapshots 的合成余额 + cache-only 现价(取不到回退
// unitPrice)。账户不存在/非本人 → null(getAccountById 已 userId-scoped)。
export const loadManualAccountLiveTotal = (
  accountId: string,
): Effect.Effect<number | null, never, AccountStore | ManualStore | TokenService | FxService> =>
  Effect.gen(function* () {
    const account = yield* Effect.flatMap(AccountStore, (s) => s.getById(accountId));
    if (!account) return null;
    const byAccount = new Map<string, SnapshotWithBalances>();
    yield* injectManualSnapshots([account], byAccount);
    return byAccount.get(accountId)?.snapshot.totalUsd ?? null;
  });

// 该用户 manual 账户账本序列的合并行(组合净值历史用)。各账户产各自 (accountId, takenAt, totalUsd) 行,
// 与别账户的 snapshot 行拼在一起喂 buildPortfolioHistory —— manual 不在 snapshot 表 → 不双算(ADR 0018)。
// **含归档**:历史保留归档账户的过去贡献(与 synced 账户「归档后旧快照仍在」一致);当下点由调用方的 live
// 覆写(仅活跃账户)自然把归档剔出末点。故此处不按 archived 过滤(区别于 injector/预热的「当下」三门)。
export const loadManualHistoryRows = (
  accounts: AccountSafe[],
  now: number = Date.now(),
): Effect.Effect<SnapshotTotalRow[], never, ManualStore | TokenService | FxService> =>
  Effect.map(
    Effect.forEach(
      accounts.filter((a) => isManual(a.connectorId)),
      // **归档账户的网格只画到封存那一刻**(ADR 0039)。它归档前的历史照常保留 —— 所以是截断 τ,
      // 不是把这个账户整个剔掉(剔掉会把它归档前的贡献一起抹了,与「归档看的是过去」相反)。
      // 不截断的话:一年前归档的手记账户,每次开首页都要为它从账本重建 365 个日格点(还带历史价查询),
      // 而这些点在求和时全被排除 —— 白算一遍,还往曲线里插一批「什么都没发生」的时间点。
      // `Math.min`:只**截短**,不延长 —— 调用方给的 `now` 是这条曲线的右端,
      // 归档时刻晚于它(比如刚归档、而调用方在算一段历史)时不该把网格往后拉。
      (a) =>
        loadManualAccountSeries(a.id, a.archivedAt == null ? now : Math.min(a.archivedAt, now)),
      { concurrency: "unbounded" },
    ),
    (perAccount) => perAccount.flat(),
  );

// 加一个持仓:认币(mint)→ 落用户自己的两个字段 → 一条 occurredAt=now 的开仓 set 活动
//(使 derived amount === 初始 amount)。这个币已经有持仓时不会重复 —— mint 恒返回同一个 id,
// set 语义又重置基线,所以「再加一次」等于「把数量改成这个」。
export const createToken = (
  input: CreateTokenInput,
): Effect.Effect<{ id: string }, never, ManualStore | TokenService> =>
  Effect.gen(function* () {
    const store = yield* ManualStore;
    const tokenId = yield* mintHolding(input);
    yield* store.setHoldingDef(tokenId, { symbol: input.symbol.trim().toUpperCase() });
    // 开仓价进账本(与 createManualAccount 同口径)—— 价只有账本一个来源。
    yield* store.recordActivity(input.accountId, tokenId, {
      kind: "set",
      amount: input.amount,
      price: input.unitPrice > 0 ? input.unitPrice : null,
      occurredAt: Date.now(),
    });
    return { id: tokenId };
  });

// 改 token 定义;若目标 amount 与当前 derived 不同 → 追加一条 set 活动对齐(播 set 语义,grill Q13)→ 物化。
// **accountId 由调用方带** —— token 不再自带账户(一个币可以被多个手记账户持有)。
// 改「这其实是哪个币」(那条上游 ref)不在这里:那是改绑,与自动补链的合并同一条路径,另开一票。
export const updateToken = (input: UpdateTokenInput): Effect.Effect<void, never, ManualStore> =>
  Effect.gen(function* () {
    const store = yield* ManualStore;
    yield* store.setHoldingDef(input.tokenId, { symbol: input.symbol.trim().toUpperCase() });
    const current = deriveAmount(yield* store.listActivityByToken(input.accountId, input.tokenId));
    // 数量变了才补一笔对齐的 set;**它带上传进来的价** —— 不然改价这件事没有落点
    // (价只有账本一个来源,而这个函数是抽屉里改 token 的那条路)。
    if (Math.abs(current - input.amount) > AMOUNT_EPS) {
      yield* store.recordActivity(input.accountId, input.tokenId, {
        kind: "set",
        amount: input.amount,
        price: input.unitPrice > 0 ? input.unitPrice : null,
        occurredAt: Date.now(),
      });
    }
  });

// 该账户不再持有这个币:删它对该币的全部活动。**`tokens` 那行留着** —— 它是参考层数据
//(带着上游 ref、名字、图、历史日价),别的账户可能还在用,删了下次还得重新认一遍。
export const deleteToken = (
  accountId: string,
  tokenId: string,
): Effect.Effect<void, never, ManualStore> =>
  Effect.flatMap(ManualStore, (s) => s.detachHolding(accountId, tokenId));

// 批量加活动:载既有 token → 纯逻辑解析+校验(整批拒因超支)→ 原子提交(新建 token + 插活动)→ 物化。
export const addManualActivities = (
  accountId: string,
  drafts: BatchDraft[],
): Effect.Effect<ManualWriteResult, never, ManualStore | TokenService> =>
  Effect.gen(function* () {
    const store = yield* ManualStore;
    const existing = yield* loadTokens(accountId);
    // **先认币**:每条草稿的选中币换出 token id,规划时只比 id(见 planManualBatch)。
    // 一批里指向同一个币的多条草稿会拿到同一个 id → 天然落到同一条持仓上。
    const withIds = yield* Effect.forEach(
      drafts,
      (d) =>
        Effect.map(mintHolding(d.token), (tokenId) => ({
          ...d,
          token: { ...d.token, tokenId },
        })),
      { concurrency: "unbounded" },
    );
    const plan = planManualBatch(existing, withIds);
    if (!plan.ok) return { ok: false, reason: "overdraw", symbol: plan.symbol };
    yield* store.commitBatch({ accountId, declare: plan.declare, activities: plan.activities });
    return { ok: true };
  });

// 删一笔活动(不校验:删除只减活动,derived 末值仍夹 0,与前端一致)→ 物化。
export const deleteManualActivity = (
  accountId: string,
  activityId: string,
): Effect.Effect<void, never, ManualStore> =>
  Effect.flatMap(ManualStore, (s) => s.removeActivity(accountId, activityId));

// 编辑一笔既有活动:取所属 token 时间线、套 patch 折叠校验(改 amount/kind/日期可能致超支)→ 合法才写 → 物化。
export const editManualActivity = (
  activityId: string,
  patch: ManualActivityPatch,
): Effect.Effect<ManualWriteResult, never, ManualStore> =>
  Effect.gen(function* () {
    const store = yield* ManualStore;
    const { tokenId, accountId } = yield* store.activityOwner(activityId);
    const activities = yield* store.listActivityByToken(accountId, tokenId);
    // 只 kind/amount/occurredAt 影响运行持有;price/memo 不参与折叠。
    const patched = activities.map((a) =>
      a.id === activityId
        ? {
            kind: patch.kind ?? a.kind,
            amount: patch.amount ?? a.amount,
            occurredAt: patch.occurredAt ?? a.occurredAt,
            createdAt: a.createdAt,
          }
        : a,
    );
    if (!runningOk(patched)) {
      const holdings = yield* store.listHoldings(accountId, NAMER);
      return {
        ok: false,
        reason: "overdraw",
        symbol: holdings.find((t) => t.id === tokenId)?.symbol,
      };
    }
    yield* store.updateActivity(activityId, patch);
    return { ok: true };
  });

// manual 账户的 24h 盈亏原料(ADR 0040 / #447 第 3 片)。
//
// **manual 从不写快照(ADR 0018)**,所以上一片里它的线只有一个当下点 → 一律「算不出」。但它手上
// 的东西比快照更好:账本记着每笔什么时候买的、多少钱买的。所以不迁就快照网格,**按活动时刻切段**。
//
// 由此 manual 账户比同步账户准。那本来就合理 —— 你实实在在多告诉了系统一些东西;这不是两套方法,
// 是同一个方法喂了更好的数据,与「同步越勤越准」是同一个道理。
//
// 两处必须这样做的地方:
//
// ① **窗口起点那一刻直接产点**,时刻就是 `since` 本身。账本能算任意时刻的值,没有「快照落在哪儿」
//    这回事 —— 于是容差判定必然通过,manual 账户只要有账本就永远算得出。
//
// ② **每个币在账户的每个观测时刻都产一行,哪怕它那一刻没有活动。** 装配层(`buildGainLines`)对
//    「某时刻缺这个币的行」的解读是「数量归零」—— 那条规则是为快照写的(快照是全量的),对账本
//    这种稀疏点恰好反过来:没有活动只表示没动过。少产一行,持仓就会在别的币交易的那一刻被清零。
export const loadManualGainHistory = (
  accounts: AccountSafe[],
  now: number,
  since: number,
): Effect.Effect<GainHistoryRow[], never, ManualStore | TokenService | FxService> =>
  Effect.gen(function* () {
    // 归档账户不参与(ADR 0039:封存之后不再产生 24h 盈亏)。
    const manual = accounts.filter((a) => isManual(a.connectorId) && a.archivedAt == null);
    const out: GainHistoryRow[] = [];
    yield* Effect.forEach(
      manual,
      (account) =>
        Effect.gen(function* () {
          const tokens = yield* loadHistoryTokens(account.id);
          if (tokens.length === 0) return;
          const priceAt = yield* buildHistoricalPriceAt(tokens, now);
          // 观测时刻取**账户级**并集(见上面 ②):窗口起点 + 窗口内每一笔活动的时刻。
          const times = new Set<number>([since]);
          for (const tk of tokens) {
            for (const a of tk.activities) {
              if (a.occurredAt > since && a.occurredAt < now) times.add(a.occurredAt);
            }
          }
          const sorted = [...times].sort((a, b) => a - b);
          for (const tk of tokens) {
            for (const t of sorted) {
              const amount = tokenQuantityAt(tk, t);
              out.push({
                accountId: account.id,
                takenAt: t,
                tokenId: tk.id,
                amount,
                // 价走 ADR 0019 的降级链:oracle 历史价 → 账本里最近一条记了价的活动 → unitPrice。
                usdValue: amount * tokenPriceAt(tk, t, priceAt),
              });
            }
          }
        }),
      // 每账户一次取数,顺序跑 —— 与 loadManualHistoryRows 同一个理由(共用限频额度)。
      { concurrency: 1, discard: true },
    );
    return out;
  });
