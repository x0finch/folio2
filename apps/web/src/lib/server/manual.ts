import { projectToken } from "../manual-activity";
import { validateAccountCreds } from "./connectors";
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

// manual 加账户(ADR 0017 特例):表单收单 token 标量,拼成单元素 `tokens` JSON 走**通用**
// validateAccountCreds —— 即 provider 的 tokens(manualToken)校验 + liveness(manual 恒真的 no-op),
// 不另立校验 schema、与其余 connector 同一道形状闸。校验后建账户 + 首 token 行 + 一条开仓 set 活动,
// 再 materialize 把账本折叠回 creds.tokens(materialize 是 creds.tokens 的单写者)。多 token 录入 UI 见 T4。
export async function createManualAccount(
  userId: string,
  label: string,
  values: Record<string, string>,
) {
  // 标量 → 单元素 tokens JSON(空串字段已由 createAccount 过滤;undefined 键被 JSON.stringify 丢弃,
  // 由 manualToken validator 判必填/coerce)。
  const tokens = JSON.stringify([
    {
      symbol: values.symbol,
      unitPrice: values.unitPrice,
      identifier: values.identifier,
      amount: values.amount,
    },
  ]);
  await validateAccountCreds("manual", { tokens }, { liveness: true, label });

  const account = await db.createAccount(userId, {
    connectorId: "manual",
    label,
    creds: JSON.stringify({ tokens: "[]" }),
  });
  // 账本为真:首 token 行 + 一条开仓 set 活动(数量 = 表单 amount),再由 materialize 折叠回 creds.tokens。
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
