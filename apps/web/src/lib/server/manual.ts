import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { CredsToken } from "../manual-activity";
import { projectToken } from "../manual-activity";
import { isManual, MANUAL_CONNECTOR_ID } from "../manual-connector";
import { buildManualSnapshot } from "../manual-snapshot";
import { type BalanceLike, balanceToAssetRef } from "../tokens";
import { db } from "./db";
import { oracle } from "./oracle";

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
