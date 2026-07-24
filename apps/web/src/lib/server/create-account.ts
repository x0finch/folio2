import { env } from "cloudflare:workers";
import type { ConnectorId } from "@folio/connectors";
import { getLogger } from "@logtape/logtape";
import { sealCreds } from "../creds";
import { isManual } from "../manual-connector";
import { credentialSpecs, validateAccountCreds } from "./connector-registry";
import { db } from "./db";
import { createManualAccount } from "./manual";

// 账户创建的分派逻辑(server fn 之外的纯 async → 不引 createServerFn/requireAuth,可在 workers-pool 集成测)。
// createAccount server fn(见 accounts.ts)只做 auth 薄壳后调本函数。SECRETS_KEY 只在此 app 层见,不进 connectors。
const log = getLogger(["folio", "web", "accounts"]);

// connectors 层校验/规格 → 业务层按字段 type seal(只有 secret 加密,public/semi 明文)。
export const raw2sealed = async (connectorId: ConnectorId, values: Record<string, string>) =>
  JSON.stringify(await sealCreds(credentialSpecs()[connectorId] ?? [], values, env.SECRETS_KEY));

// 统一创建入口(connector-driven):过滤空串 → 对**所有 connector** 统一 validateAccountCreds(形状闸 + 活性探活;
// manual 跑的即 provider 的 manualToken schema)→ 按 connector 分派创建:manual 走账本(取首 token → 建 token 行
// + 开仓 set 活动 + 物化 creds.tokens,见 createManualAccount),其余 seal 落库。
export async function createAccountFor(
  userId: string,
  connectorId: ConnectorId,
  label: string,
  rawValues: Record<string, string>,
) {
  // 丢掉空串:未填的可选字段缺省即不参与;必填字段留空 → 变 undefined → validateAccountCreds 直接拒。
  const values = Object.fromEntries(Object.entries(rawValues).filter(([, v]) => v !== ""));
  await validateAccountCreds(connectorId, values, { liveness: true, label });

  const account = isManual(connectorId)
    ? await createManualAccount(userId, label, values.tokens)
    : await db.createAccount(userId, {
        connectorId,
        label,
        creds: await raw2sealed(connectorId, values),
      });
  log.info("account created", { connectorId, accountId: account.id });
  return account;
}
