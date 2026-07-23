import type {
  AccountSafe,
  ManualActivity,
  ManualActivityPatch,
  ManualToken,
  SnapshotWithBalances,
} from "@folio/db";
import type { SnapshotTotalRow } from "../history";
import type { CredsToken } from "../manual-activity";
import { deriveAmount, projectToken } from "../manual-activity";
import { type BatchDraft, planManualBatch, runningOk, type Token } from "../manual-batch";
import { isManual, MANUAL_CONNECTOR_ID } from "../manual-connector";
import { buildManualAccountSeries, type HistoryToken } from "../manual-history";
import { buildManualSnapshot } from "../manual-snapshot";
import { type BalanceLike, balanceToAssetRef } from "../tokens";
import { db } from "./db";
import { oracle } from "./oracle";

// 折叠数量的浮点容差(与 manual-batch 一致):目标 amount 与当前 derived 差在此内视为相等。
const AMOUNT_EPS = 1e-9;

// 把某 manual 账户的各 token 定义 + 各自活动账本折叠出的 amount,物化进 public `creds.tokens`
// (provider 读取的投影,ADR 0017)。**单写者**:任何 token / 活动写路径改动后都须重跑,维护不变量
// creds.tokens[i].amount === deriveAmount(token i 的 activities)。manual creds 全 public、明文 JSON;
// tokens 存为 JSON 字符串(creds map 值恒字符串),provider 侧经 validateCredentials 解析回 typed 数组。
// identifier 为空时**省略该键**(而非置 null)—— provider 的 tokens validator 视 identifier 为可选 string。
export async function materializeManualCreds(userId: string, accountId: string): Promise<void> {
  const rows = await db.listManualTokensByAccount(userId, accountId);
  const tokens = await Promise.all(
    rows.map(async (r) => projectToken(r, await db.listManualActivityByToken(userId, r.id))),
  );
  const raw = await db.getRawCreds(userId, accountId);
  const creds: Record<string, string> = raw ? JSON.parse(raw) : {};
  creds.tokens = JSON.stringify(tokens);
  await db.setAccountCredentials(userId, accountId, JSON.stringify(creds));
}

// manual 加账户(ADR 0017 特例):前端已把首 token 提交为 `creds.tokens`(单元素 JSON),且已由
// createAccount 的通用 validateAccountCreds(provider 的 manualToken schema)校验过。这里取首 token →
// 建账户 + 首 token 行 + 一条开仓 set 活动 → materialize 把账本折叠回 creds.tokens(单写者)。
// 多 token 录入 UI 见 T4。
export async function createManualAccount(userId: string, label: string, tokens: string) {
  const [first] = JSON.parse(tokens) as Array<{
    symbol: string;
    unitPrice: number | string;
    identifier?: string;
    amount: number | string;
  }>;
  // validateAccountCreds 用的 z.array 允许空数组 → 显式挡掉(表单恒发 1 条,防御式)。
  if (!first) throw new Error("manual account requires at least one token");
  const account = await db.createAccount(userId, {
    connectorId: MANUAL_CONNECTOR_ID,
    label,
    creds: JSON.stringify({ tokens: "[]" }),
  });
  const token = await db.createManualToken(userId, account.id, {
    symbol: first.symbol,
    unitPrice: Number(first.unitPrice),
    identifier: first.identifier,
  });
  await db.recordManualActivity(userId, token.id, {
    kind: "set",
    amount: Number(first.amount),
    occurredAt: Date.now(),
  });
  await materializeManualCreds(userId, account.id);
  return account;
}

// 某 manual 账户存库的 creds.tokens(JSON 字符串)→ typed CredsToken[]。畸形/缺失 → 空数组(防御式)。
function parseCredsTokens(raw: string | null): CredsToken[] {
  if (!raw) return [];
  try {
    const creds = JSON.parse(raw) as { tokens?: string };
    const tokens = creds.tokens ? JSON.parse(creds.tokens) : [];
    return Array.isArray(tokens) ? (tokens as CredsToken[]) : [];
  } catch {
    return [];
  }
}

// 该用户**活跃** manual 账户的 (accountId → 已物化 tokens)。injector 与预热共用(一次批量 raw creds 读,消 N+1)。
// 排除归档:归档 manual 不进 enrich 门(injector 的调用点已按 active 过滤)→ 预热/刷价也不该碰它,三门同源。
async function manualTokensByAccount(
  userId: string,
  accounts: AccountSafe[],
): Promise<{ id: string; tokens: CredsToken[] }[]> {
  const manual = accounts.filter((a) => isManual(a.connectorId) && a.archivedAt == null);
  if (manual.length === 0) return [];
  const rawById = new Map((await db.listRawCredsByUser(userId)).map((r) => [r.id, r.creds]));
  return manual.map((a) => ({ id: a.id, tokens: parseCredsTokens(rawById.get(a.id) ?? null) }));
}

// manual 退出 snapshot 后(ADR 0018 做法 1),其「当下」合成余额注入 `byAccount` —— overview/history 三处消费点
// 拼好 byAccount 后各调一次。value = amount × 现价(cache-only enrich 取,与 deriveLiveAccountTotals 同门盯市;
// 取不到回退 unitPrice,见 buildManualSnapshot)。归档 manual 不在传入的 accounts 里 → 不注入。takenAt 仅占位
// (UI 对 manual 显「实时」)。
export async function injectManualSnapshots(
  userId: string,
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  takenAt: number = Date.now(),
): Promise<void> {
  const list = await manualTokensByAccount(userId, accounts);
  if (list.length === 0) return;
  // 先各建一份(prices 全缺)拿 assetRef,全部账户**一次批量** enrich(cache-only,与 deriveLiveAccountTotals
  // 同门,避免逐账户串行 D1 往返),再按账户切回各自现价重建终版。
  const drafts = list.map(({ id, tokens }) => buildManualSnapshot(id, tokens, [], takenAt));
  const enriched = await oracle.tokens.enrich(
    drafts.flatMap((d) => d.balances).map(balanceToAssetRef),
  );
  let i = 0;
  list.forEach(({ id, tokens }, k) => {
    const prices = drafts[k].balances.map(() => enriched[i++]?.unitPrice);
    byAccount.set(id, buildManualSnapshot(id, tokens, prices, takenAt));
  });
}

// 预热用:该用户全部 manual 账户的合成余额(供 warmTokens 把其代币现价取进缓存)。manual 已退出 snapshot,
// 故预热不能只从快照收集币 —— 否则纯 manual 用户的币永远暖不到、拿不到实时价(ADR 0018 T2 实施细化)。
export async function manualBalancesForWarm(
  userId: string,
  accounts: AccountSafe[],
): Promise<BalanceLike[]> {
  const list = await manualTokensByAccount(userId, accounts);
  return list.flatMap(({ id, tokens }) => buildManualSnapshot(id, tokens, [], 0).balances);
}

// —— T3 写路径(#155):token CRUD + 批量活动(原子)+ 删/改活动 ——
// server fn(manual-mutations.ts)只做 auth 薄壳后调这些纯 async(可在 workers-pool 集成测,不引 createServerFn)。
// **单写者**:每次写后重跑受影响账户物化(materializeManualCreds),维护 creds.tokens[i].amount === 折叠账本 不变量。
// 决策逻辑(解析/收养/超支校验)下沉纯模块 manual-batch;这里只做加载 + 调用 + 物化(ADR 0017)。

export interface CreateTokenInput {
  accountId: string;
  symbol: string;
  unitPrice: number;
  identifier?: string | null;
  amount: number;
}
export interface UpdateTokenInput {
  tokenId: string;
  symbol: string;
  unitPrice: number;
  identifier?: string | null;
  amount: number;
}
export type ManualWriteResult = { ok: true } | { ok: false; reason: "overdraw"; symbol?: string };

// 某账户的各 token 定义 + 各自活动(按 tokenId 归并)。**唯一加载器**:一次账户级活动读 + 分组,消 N+1;
// 写校验(loadTokens)、抽屉明细(loadManualAccountDetail)、价值历史(loadHistoryTokens)三处读路径共用,
// 各自再投影成所需形状。DB 层 token_id 可空(迁移遗留)→ 防御式跳过。
async function loadTokensWithActivities(
  userId: string,
  accountId: string,
): Promise<{ token: ManualToken; activities: ManualActivity[] }[]> {
  const [tokens, activities] = await Promise.all([
    db.listManualTokensByAccount(userId, accountId),
    db.listManualActivityByAccount(userId, accountId),
  ]);
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
async function loadTokens(userId: string, accountId: string): Promise<Token[]> {
  return (await loadTokensWithActivities(userId, accountId)).map(({ token, activities }) => ({
    id: token.id,
    symbol: token.symbol,
    unitPrice: token.unitPrice,
    identifier: token.identifier,
    activities,
  }));
}

// —— 读:抽屉账户明细(T4,#156)——
// creds.tokens(= balances 投影)不含 token 的 DB id、也不含活动账本 → 抽屉的编辑/删除与 Activity tab 需专门读。
// 返回 tokens(带 DB id + 折叠出的 amount)+ 全部活动(各自带 tokenId,供 Activity tab 按 token 归并展示)。
// UI 的 logo/name/实时市值仍从 balances(overview)取,按 identifier/symbol 匹配 —— 本读只出账本事实。
export interface ManualAccountDetailToken {
  id: string;
  symbol: string;
  unitPrice: number;
  identifier: string | null;
  amount: number;
}
export interface ManualAccountDetail {
  tokens: ManualAccountDetailToken[];
  activities: ManualActivity[];
}
export async function loadManualAccountDetail(
  userId: string,
  accountId: string,
): Promise<ManualAccountDetail> {
  const perToken = await loadTokensWithActivities(userId, accountId);
  return {
    tokens: perToken.map(({ token, activities }) => ({
      id: token.id,
      symbol: token.symbol,
      unitPrice: token.unitPrice,
      identifier: token.identifier ?? null,
      amount: deriveAmount(activities),
    })),
    activities: perToken.flatMap(({ activities }) => activities),
  };
}

// —— 读:价值历史 compute-on-read(T5,#157,ADR 0018)——
// manual 账户不写 snapshot → 其历史由账本现算。共用 loadTokensWithActivities(消 N+1),投影成 HistoryToken[]
// 喂 buildManualAccountSeries 折出 (takenAt, totalUsd) 阶梯序列。ManualActivity 结构含 HistoryActivity
// (price 参与 price@T 降级链②,见 manual-history)。
async function loadHistoryTokens(userId: string, accountId: string): Promise<HistoryToken[]> {
  return (await loadTokensWithActivities(userId, accountId)).map(({ token, activities }) => ({
    unitPrice: token.unitPrice,
    identifier: token.identifier,
    activities,
  }));
}

// 单 manual 账户的账本价值序列(抽屉头部 chart 用;getAccountValueHistory 对 manual 走此)。
// #148 未就绪 → 不传 priceAt,走账本价②/unitPrice③降级(有 identifier 者待 #148 切 oracle 历史价)。
export async function loadManualAccountSeries(
  userId: string,
  accountId: string,
): Promise<SnapshotTotalRow[]> {
  return buildManualAccountSeries(accountId, await loadHistoryTokens(userId, accountId));
}

// 单 manual 账户「当下」实时盯市总额(抽屉曲线末点接它 → 端点与抽屉头 account.totalUsd 同源盯市,不因
// 账本价/unitPrice 而与头部数值打架)。复用 injectManualSnapshots 的合成余额 + cache-only 现价(取不到回退
// unitPrice)。账户不存在/非本人 → null(getAccountById 已 userId-scoped)。
export async function loadManualAccountLiveTotal(
  userId: string,
  accountId: string,
): Promise<number | null> {
  const account = await db.getAccountById(userId, accountId);
  if (!account) return null;
  const byAccount = new Map<string, SnapshotWithBalances>();
  await injectManualSnapshots(userId, [account], byAccount);
  return byAccount.get(accountId)?.snapshot.totalUsd ?? null;
}

// 该用户 manual 账户账本序列的合并行(组合净值历史用)。各账户产各自 (accountId, takenAt, totalUsd) 行,
// 与别账户的 snapshot 行拼在一起喂 buildPortfolioHistory —— manual 不在 snapshot 表 → 不双算(ADR 0018)。
// **含归档**:历史保留归档账户的过去贡献(与 synced 账户「归档后旧快照仍在」一致);当下点由调用方的 live
// 覆写(仅活跃账户)自然把归档剔出末点。故此处不按 archived 过滤(区别于 injector/预热的「当下」三门)。
export async function loadManualHistoryRows(
  userId: string,
  accounts: AccountSafe[],
): Promise<SnapshotTotalRow[]> {
  const manual = accounts.filter((a) => isManual(a.connectorId));
  const perAccount = await Promise.all(manual.map((a) => loadManualAccountSeries(userId, a.id)));
  return perAccount.flat();
}

// 建一个 token:建行 + 一条 occurredAt=now 的开仓 set 活动(使 derived amount === 初始 amount)→ 物化。
export async function createToken(userId: string, input: CreateTokenInput) {
  const token = await db.createManualToken(userId, input.accountId, {
    symbol: input.symbol,
    unitPrice: input.unitPrice,
    identifier: input.identifier,
  });
  await db.recordManualActivity(userId, token.id, {
    kind: "set",
    amount: input.amount,
    occurredAt: Date.now(),
  });
  await materializeManualCreds(userId, input.accountId);
  return token;
}

// 改 token 定义;若目标 amount 与当前 derived 不同 → 追加一条 set 活动对齐(播 set 语义,grill Q13)→ 物化。
export async function updateToken(userId: string, input: UpdateTokenInput): Promise<void> {
  const accountId = await db.getManualTokenAccountId(userId, input.tokenId);
  await db.updateManualToken(userId, input.tokenId, {
    symbol: input.symbol,
    unitPrice: input.unitPrice,
    identifier: input.identifier,
  });
  const current = deriveAmount(await db.listManualActivityByToken(userId, input.tokenId));
  if (Math.abs(current - input.amount) > AMOUNT_EPS) {
    await db.recordManualActivity(userId, input.tokenId, {
      kind: "set",
      amount: input.amount,
      occurredAt: Date.now(),
    });
  }
  await materializeManualCreds(userId, accountId);
}

// 删一个 token(其活动经 FK 级联清)→ 物化(账户仍在)。
export async function deleteToken(userId: string, tokenId: string): Promise<void> {
  const accountId = await db.getManualTokenAccountId(userId, tokenId);
  await db.deleteManualToken(userId, tokenId);
  await materializeManualCreds(userId, accountId);
}

// 批量加活动:载既有 token → 纯逻辑解析+校验(整批拒因超支)→ 原子提交(新建 token + 插活动)→ 物化。
export async function addManualActivities(
  userId: string,
  accountId: string,
  drafts: BatchDraft[],
): Promise<ManualWriteResult> {
  const existing = await loadTokens(userId, accountId);
  const plan = planManualBatch(existing, drafts, () => crypto.randomUUID());
  if (!plan.ok) return { ok: false, reason: "overdraw", symbol: plan.symbol };
  await db.commitManualBatch(userId, {
    accountId,
    newTokens: plan.newTokens,
    activities: plan.activities,
  });
  await materializeManualCreds(userId, accountId);
  return { ok: true };
}

// 删一笔活动(不校验:删除只减活动,derived 末值仍夹 0,与前端一致)→ 物化。
export async function deleteManualActivity(
  userId: string,
  accountId: string,
  activityId: string,
): Promise<void> {
  await db.removeManualActivity(userId, accountId, activityId);
  await materializeManualCreds(userId, accountId);
}

// 编辑一笔既有活动:取所属 token 时间线、套 patch 折叠校验(改 amount/kind/日期可能致超支)→ 合法才写 → 物化。
export async function editManualActivity(
  userId: string,
  activityId: string,
  patch: ManualActivityPatch,
): Promise<ManualWriteResult> {
  const { tokenId, accountId } = await db.getManualActivityOwner(userId, activityId);
  const activities = await db.listManualActivityByToken(userId, tokenId);
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
    const symbol = (await db.listManualTokensByAccount(userId, accountId)).find(
      (t) => t.id === tokenId,
    )?.symbol;
    return { ok: false, reason: "overdraw", symbol };
  }
  await db.updateManualActivity(userId, activityId, patch);
  await materializeManualCreds(userId, accountId);
  return { ok: true };
}
