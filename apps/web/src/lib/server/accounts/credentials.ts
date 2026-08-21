import { AccountStore } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { validateAccountCreds } from "../connectors/registry";
import { runStore } from "../oracle";
import { raw2sealed } from "./create";

// userId 经 requireAuth 的 withContext 自动带入(ALS);只记 connectorId/accountId 等安全字段(红线:不打 creds)。
const log = getLogger(["folio", "web", "accounts"]);

// 凭据再水合(P6.6.1):为导入的"缺凭据"账户补录真值。活性校验通过后整张 map 覆盖(占位被真值替换)。
export const ReplaceCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string().trim()), // seal 原始输入 → 值先 trim
});

export async function handleReplaceAccountCredentials({
  data,
  context,
}: {
  data: z.infer<typeof ReplaceCredentialsInput>;
  context: { userId: string };
}) {
  const account = await runStore(context.userId, AccountStore, (s) => s.getById(data.accountId));
  if (!account) throw new Error("account not found");
  // 校验(含活性探活)不碰 db,留在边缘 —— 它失败时的那条消息要原样给到表单上。
  await validateAccountCreds(account.connectorId, data.creds, {
    liveness: true,
    label: account.label,
  });
  const sealed = await raw2sealed(account.connectorId, data.creds);
  await runStore(context.userId, AccountStore, (s) => s.setCredentials(account.id, sealed));
  log.info("credentials provided", { connectorId: account.connectorId, accountId: account.id });
  return { ok: true as const };
}
