import { projectToken } from "../manual-activity";
import { db } from "./db";

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
    connectorId: "manual",
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
