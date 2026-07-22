import { CredentialValidationError } from "@folio/connectors-basic";
import { z } from "zod";
import { projectHolding } from "../manual-activity";
import { db } from "./db";

// 把某 manual 账户的各 holding 定义 + 各自活动账本折叠出的 amount,物化进 public `creds.tokens`
// (provider 读取的投影,ADR 0017)。**单写者**:任何 holding / 活动写路径改动后都须重跑,维护不变量
// creds.tokens[i].amount === deriveAmount(holding i 的 activities)。manual creds 全 public、明文 JSON;
// tokens 存为 JSON 字符串(creds map 值恒字符串),provider 侧经 validateCredentials 解析回 typed 数组。
// identifier 为空时**省略该键**(而非置 null)—— provider 的 tokens validator 视 identifier 为可选 string。
export async function materializeManualCreds(userId: string, accountId: string): Promise<void> {
  const holdings = await db.listManualHoldingsByAccount(userId, accountId);
  const tokens = await Promise.all(
    holdings.map(async (h) =>
      projectHolding(h, await db.listManualActivityByHolding(userId, h.id)),
    ),
  );
  const raw = await db.getRawCreds(userId, accountId);
  const creds: Record<string, string> = raw ? JSON.parse(raw) : {};
  creds.tokens = JSON.stringify(tokens);
  await db.setAccountCredentials(userId, accountId, JSON.stringify(creds));
}

// manual 加账户首 token 的标量输入(表单 ManualFields 提交);coerce 数字,identifier 可选。
const ManualFirstToken = z.object({
  symbol: z.string().trim().min(1),
  amount: z.coerce.number(),
  unitPrice: z.coerce.number(),
  identifier: z.string().trim().min(1).optional(),
});

// manual 加账户(ADR 0017 特例):表单收单 token 标量 → 建账户(creds.tokens 先空)+ 首 holding
// + 一条 set 活动 → 物化 creds.tokens。不走通用 validateAccountCreds/raw2sealed(account.creds 现为单个
// tokens JSON 字段,与标量表单不同形)。形状不过抛 CredentialValidationError(与通用路径同一错误类型,
// 而非裸 ZodError)。多 token 录入 UI 见 T4。
export async function createManualAccount(
  userId: string,
  label: string,
  values: Record<string, string>,
) {
  const parsed = ManualFirstToken.safeParse(values);
  if (!parsed.success) {
    throw new CredentialValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "tokens"}: ${i.message}`).join("; "),
    );
  }
  const first = parsed.data;
  const account = await db.createAccount(userId, {
    connectorId: "manual",
    label,
    creds: JSON.stringify({ tokens: "[]" }),
  });
  const holding = await db.createManualHolding(userId, account.id, {
    symbol: first.symbol,
    unitPrice: first.unitPrice,
    identifier: first.identifier,
  });
  await db.recordManualActivity(userId, holding.id, {
    kind: "set",
    amount: first.amount,
    occurredAt: Date.now(),
  });
  await materializeManualCreds(userId, account.id);
  return account;
}
