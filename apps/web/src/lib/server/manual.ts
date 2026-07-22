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
