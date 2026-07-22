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

// 表单首 token 标量 → 单元素 creds.tokens map,供 createAccount 用**通用** validateAccountCreds 校验
// (跑的即 provider 的 tokens/manualToken schema);manual 借此和其余 connector 走同一道形状闸,不另立 schema。
// 空串字段已由 createAccount 过滤;undefined 键被 JSON.stringify 丢弃,由 manualToken validator 判必填/coerce。
export function manualCredsFromForm(values: Record<string, string>): Record<string, string> {
  return {
    tokens: JSON.stringify([
      {
        symbol: values.symbol,
        unitPrice: values.unitPrice,
        identifier: values.identifier,
        amount: values.amount,
      },
    ]),
  };
}

// manual 加账户(ADR 0017 特例):建账户 + 首 token 行 + 一条开仓 set 活动 → materialize 把账本折叠回
// creds.tokens(单写者)。表单已由 createAccount 的 validateAccountCreds(见上 manualCredsFromForm)校验过。
// 多 token 录入 UI 见 T4。
export async function createManualAccount(
  userId: string,
  label: string,
  values: Record<string, string>,
) {
  const account = await db.createAccount(userId, {
    connectorId: "manual",
    label,
    creds: JSON.stringify({ tokens: "[]" }),
  });
  const token = await db.createManualToken(userId, account.id, {
    symbol: values.symbol,
    unitPrice: Number(values.unitPrice),
    identifier: values.identifier,
  });
  await db.recordManualActivity(userId, token.id, {
    kind: "set",
    amount: Number(values.amount),
    occurredAt: Date.now(),
  });
  await materializeManualCreds(userId, account.id);
  return account;
}
