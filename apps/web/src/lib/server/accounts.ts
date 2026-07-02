import { env } from "cloudflare:workers";
import type { AccountSafe } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isComplete, safeView, sealCreds } from "../creds";
import { requireAuth } from "../require-auth";
import { balances } from "./balances";
import { db } from "./db";

// userId 经 requireAuth 的 withContext 自动带入(ALS);各处只记 type/accountId 等安全字段(红线:不打 creds)。
const log = getLogger(["folio", "web", "accounts"]);

// balances 只负责校验/探活(validateCredentials)与字段规格(credentialSpecs);加密/脱敏/补录判定走业务层
// creds.ts(seal/safeView/isComplete),按字段 type 驱动。SECRETS_KEY 只在本层(app)见,不进 balances。
const raw2sealed = async (
  type: Parameters<typeof balances.validateCredentials>[0]["type"],
  values: Record<string, string>,
) =>
  JSON.stringify(await sealCreds(balances.credentialSpecs()[type] ?? [], values, env.SECRETS_KEY));

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
    const specsByType = balances.credentialSpecs();
    return accounts.map((a) => {
      const raw = rawById.get(a.id);
      const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
      const specs = specsByType[a.type] ?? [];
      return {
        ...a,
        needsCredentials: !isComplete(specs, stored),
        credsSafe: safeView(specs, stored),
      };
    });
  });

// 一个 manual 账户 = 一个手记资产:symbol/amount/unitPrice 三个 public 输入,走 creds(明文,见 P6.6.2/P7.4.1)。
// 创建即写一条初始 `set` 活动(manual_activity),账本从创建起就有基线;之后 amount 经活动账本物化。
const ManualInput = z.object({
  label: z.string().trim().min(1, "label is required"),
  symbol: z.string().trim().min(1, "symbol is required"),
  amount: z.string().trim().min(1, "amount is required"),
  unitPrice: z.string().trim().min(1, "unitPrice is required"),
  identifier: z.string().trim().optional(), // 选币消歧(P7.4.3),可选
  fixed: z.boolean().optional(), // 锁定固定值(P7.4.4),可选
});
export const createManualAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ManualInput)
  .handler(async ({ data, context }) => {
    const raw: Record<string, string> = {
      symbol: data.symbol,
      amount: data.amount,
      unitPrice: data.unitPrice,
      ...(data.identifier ? { identifier: data.identifier } : {}),
      ...(data.fixed ? { fixed: "1" } : {}),
    };
    await balances.validateCredentials({ type: "manual" }, raw); // 形状校验闸(manual 无需探活)
    const account = await db.createAccount(context.userId, {
      type: "manual",
      label: data.label,
      creds: await raw2sealed("manual", raw),
    });
    // 初始 set:账本基线 = 创建时数量(与 creds.amount 一致)。
    await db.recordManualActivity(context.userId, account.id, {
      kind: "set",
      amount: Number(data.amount),
      occurredAt: Date.now(),
    });
    log.info("account created", { type: "manual", accountId: account.id });
    return account;
  });

// 地址类账户(链上 + perp):地址→identifier(public)。validateCredentials({liveness}) 内部按 usesGlobalKeys
// 收窄全局 key + provider.validate,活性失败即抛(地址无效/不可达或服务端缺 key),通过才封装。
async function createAddressAccount(
  userId: string,
  type: Parameters<typeof balances.validateCredentials>[0]["type"],
  label: string,
  address: string,
): Promise<AccountSafe> {
  const raw = { identifier: address };
  await balances.validateCredentials({ type, label, userId }, raw, { liveness: true });
  const account = await db.createAccount(userId, {
    type,
    label,
    creds: await raw2sealed(type, raw),
  });
  log.info("account created", { type, accountId: account.id });
  return account;
}

const OnchainInput = z.object({
  type: z.enum(["onchain_evm", "onchain_solana", "onchain_sui", "onchain_cosmos"]),
  label: z.string().trim().min(1, "label is required"),
  address: z.string().trim(), // seal 的是原始输入 → wire 先 trim 保持落库规范
});
export const createOnchainAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(OnchainInput)
  .handler(({ data, context }) =>
    createAddressAccount(context.userId, data.type, data.label, data.address),
  );

const PerpInput = z.object({
  type: z.enum(["perp_hyperliquid"]),
  label: z.string().trim().min(1, "label is required"),
  address: z.string().trim(),
});
export const createPerpAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(PerpInput)
  .handler(({ data, context }) =>
    createAddressAccount(context.userId, data.type, data.label, data.address),
  );

// CEX 账户录入:apiKey(semi,明文)+ secret/passphrase(secret,加密)按 type 落库。
// 字段值校验(非空、okx passphrase 必填)与活性校验都在 validateCredentials 内。
const ExchangeInput = z.object({
  type: z.enum(["exchange_binance", "exchange_okx"]),
  label: z.string().trim().min(1, "label is required"),
  apiKey: z.string().trim(), // seal 原始输入 → wire 先 trim
  secret: z.string().trim(),
  passphrase: z.string().trim().optional(),
});
export const createExchangeAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ExchangeInput)
  .handler(async ({ data, context }) => {
    // passphrase 可选(仅 okx):缺省则不放进 values,由 provider.inputs 的 validator 判定是否必填。
    const values: Record<string, string> = { apiKey: data.apiKey, secret: data.secret };
    if (data.passphrase !== undefined) values.passphrase = data.passphrase;
    await balances.validateCredentials(
      { type: data.type, label: data.label, userId: context.userId },
      values,
      { liveness: true },
    );
    const account = await db.createAccount(context.userId, {
      type: data.type,
      label: data.label,
      creds: await raw2sealed(data.type, values),
    });
    log.info("exchange account created", { type: data.type, accountId: account.id });
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
    await balances.validateCredentials(
      { type: account.type, label: account.label, userId: context.userId, id: account.id },
      data.creds,
      { liveness: true },
    );
    await db.setAccountCredentials(
      context.userId,
      account.id,
      await raw2sealed(account.type, data.creds),
    );
    log.info("credentials provided", { type: account.type, accountId: account.id });
    return { ok: true as const };
  });
