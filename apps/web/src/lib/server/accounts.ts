import { env } from "cloudflare:workers";
import type { ConnectorId } from "@folio/connectors";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isComplete, safeView, sealCreds } from "../creds";
import { requireAuth } from "../require-auth";
import { credentialSpecs, validateAccountCreds } from "./connectors";
import { db } from "./db";
import { createManualAccount } from "./manual";

// userId 经 requireAuth 的 withContext 自动带入(ALS);各处只记 connectorId/accountId 等安全字段(红线:不打 creds)。
const log = getLogger(["folio", "web", "accounts"]);

// connectors 层只负责校验/探活(validateAccountCreds)与字段规格(credentialSpecs);加密/脱敏/补录判定走业务层
// creds.ts(seal/safeView/isComplete),按字段 type 驱动。SECRETS_KEY 只在本层(app)见,不进 connectors。
const raw2sealed = async (connectorId: ConnectorId, values: Record<string, string>) =>
  JSON.stringify(await sealCreds(credentialSpecs()[connectorId] ?? [], values, env.SECRETS_KEY));

// 富化:把每账户的 raw creds 投影成 needsCredentials + credsSafe(public 原样、semi 打码、secret 丢弃);
// raw creds(含 secret 密文)绝不出网,只出投影。
export const listMyAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [accounts, rawList] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.listRawCredsByUser(context.userId),
    ]);
    const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
    const specsByType = credentialSpecs();
    return accounts.map((a) => {
      const raw = rawById.get(a.id);
      const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
      const specs = specsByType[a.connectorId] ?? [];
      return {
        ...a,
        needsCredentials: !isComplete(specs, stored),
        credsSafe: safeView(specs, stored),
      };
    });
  });

// 统一创建入口(connector-driven,#55/#52):表单原始输入 values(键 = connector.account.creds 的 key),
// 校验/加密/落库全由 connectorId 驱动,不再按类型分派。空串值 = 未填的可选字段,落库前丢弃。
// manual 是特例(ADR 0017):表单收单 token 标量 → createManualAccount(见 ./manual)转换成 token + 活动
// + creds.tokens;其余 connector 走通用形状闸 + 探活 + seal 落库。
const CreateAccountInput = z.object({
  connectorId: z.string().min(1),
  label: z.string().trim().min(1, "label is required"),
  values: z.record(z.string(), z.string().trim()), // 表单原始输入(键 = connector.account.creds 的 key);trim 后落库
});
export const createAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateAccountInput)
  .handler(async ({ data, context }) => {
    const connectorId = data.connectorId as ConnectorId; // 未知 connectorId 由 validateAccountCreds 兜底抛错
    // 丢掉空串:未填的可选字段缺省即不参与;必填字段留空 → 变 undefined → 下面形状闸直接拒
    //(必填 validator 对 undefined 均失败 —— z.coerce.number() 拒 undefined)。
    const values = Object.fromEntries(Object.entries(data.values).filter(([, v]) => v !== ""));

    if (connectorId === "manual") {
      const account = await createManualAccount(context.userId, data.label, values);
      log.info("account created", { connectorId, accountId: account.id });
      return account;
    }

    // 形状闸(必填/格式)+ 活性探活。
    await validateAccountCreds(connectorId, values, { liveness: true, label: data.label });
    const account = await db.createAccount(context.userId, {
      connectorId,
      label: data.label,
      creds: await raw2sealed(connectorId, values),
    });
    log.info("account created", { connectorId, accountId: account.id });
    return account;
  });

// 凭据再水合(P6.6.1):为导入的"缺凭据"账户补录真值。活性校验通过后整张 map 覆盖(占位被真值替换)。
const ProvideCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string().trim()), // seal 原始输入 → 值先 trim
});
export const provideCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ProvideCredentialsInput)
  .handler(async ({ data, context }) => {
    const account = await db.getAccountById(context.userId, data.accountId);
    if (!account) throw new Error("account not found");
    await validateAccountCreds(account.connectorId, data.creds, {
      liveness: true,
      label: account.label,
    });
    await db.setAccountCredentials(
      context.userId,
      account.id,
      await raw2sealed(account.connectorId, data.creds),
    );
    log.info("credentials provided", { connectorId: account.connectorId, accountId: account.id });
    return { ok: true as const };
  });

// —— 单账户管理(重命名 / 归档 / 删除)——
// db 层三者都按 (id, userId) 作用域,天然杜绝越权;不存在则影响 0 行(静默),不额外抛。

const AccountIdInput = z.object({ accountId: z.string().min(1) });

export const renameAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountIdInput.extend({ label: z.string().trim().min(1, "label is required") }))
  .handler(async ({ data, context }) => {
    await db.renameAccount(context.userId, data.accountId, data.label);
    log.info("account renamed", { accountId: data.accountId });
    return { ok: true as const };
  });

// 归档/取消归档:可逆,数据保留;归档后不计总额、不参与同步(过滤见 overview / sync-deps)。
export const setAccountArchived = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountIdInput.extend({ archived: z.boolean() }))
  .handler(async ({ data, context }) => {
    await db.setArchived(context.userId, data.accountId, data.archived);
    log.info("account archived toggled", { accountId: data.accountId, archived: data.archived });
    return { ok: true as const };
  });

// 删除:不可逆(snapshots/accountGroups/manual_activity 经 ON DELETE CASCADE 级联清)。前端需二次确认。
export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountIdInput)
  .handler(async ({ data, context }) => {
    await db.deleteAccount(context.userId, data.accountId);
    log.info("account deleted", { accountId: data.accountId });
    return { ok: true as const };
  });
