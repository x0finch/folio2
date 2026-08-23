import { Database, NotFound } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { validateAccountCreds } from "@/lib/server/connectors/registry";
import { raw2sealed } from "./create";

// userId 经 requireAuth 的 withContext 自动带入(ALS);只记 connectorId/accountId 等安全字段(红线:不打 creds)。
const log = getLogger(["folio", "web", "accounts"]);

// 凭据再水合(P6.6.1):为导入的"缺凭据"账户补录真值。活性校验通过后整张 map 覆盖(占位被真值替换)。
export const ReplaceCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string().trim()), // seal 原始输入 → 值先 trim
});

export const handleReplaceAccountCredentials = Effect.fn("replaceAccountCredentials")(function* (
  data: z.infer<typeof ReplaceCredentialsInput>,
) {
  const { accounts } = yield* Database;
  const account = yield* accounts.getById(data.accountId);
  // 「不是你的」与「不存在」共用一个错误(见 @folio/db 的 errors.ts)。以前这里是
  // `throw new Error("account not found")` —— 落在 promise 里当 defect 炸,端点只能回 500。
  if (!account) return yield* Effect.fail(new NotFound({ entity: "account", id: data.accountId }));
  // 校验(含活性探活)不碰 db,留在边缘 —— 它失败时的那条消息要原样给到表单上,
  // 所以走 `tryPromise` 变成类型化失败,而不是让它当 defect 炸(同 ./create 的那道)。
  yield* Effect.tryPromise({
    try: () =>
      validateAccountCreds(account.connectorId, data.creds, {
        liveness: true,
        label: account.label,
      }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
  const sealed = yield* Effect.promise(() => raw2sealed(account.connectorId, data.creds));
  yield* accounts.setCredentials(account.id, sealed);
  log.info("credentials provided", { connectorId: account.connectorId, accountId: account.id });
  return { ok: true as const };
});
