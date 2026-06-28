import { env } from "cloudflare:workers";
import {
  type FetchContext,
  getProvider,
  isComplete,
  type ProviderInput,
  safeView,
  sealCreds,
  validateCredentials,
} from "@folio/core";
import {
  createAccount,
  getAccountById,
  listAccountsByUser,
  listRawCredsByUser,
  setAccountCredentials,
} from "@folio/db";
import { appRegistry, scopeGlobalKeys } from "@folio/sync";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";

// 原始字符串输入 → 存库 map 的 JSON(secret 字段加密、public/semi 明文,见 @folio/core sealCreds)。
// 传【原始字符串】(已过 validateCredentials 校验闸);不传其 coerce 输出,保持 creds 为字符串 map。
function sealJson(
  inputs: readonly ProviderInput[],
  values: Record<string, string>,
): Promise<string> {
  return sealCreds(inputs, values, env.SECRETS_KEY).then((m) => JSON.stringify(m));
}

// 直接用 createServerFn(...).middleware([requireAuth]):Start 编译器按调用点静态识别
// createServerFn 才会在客户端构建剥离 handler 及其 server-only import(cloudflare:workers
// 等);包一层 helper 会让识别失效。userId 取自守卫注入的 context,绝不接客户端入参。
// 富化:按 provider.inputs 把每账户的 raw creds 投影成 needsCredentials + credsSafe(public 原样、
// semi 打码、secret 丢弃)。raw creds(含 secret 密文)绝不出网,只出投影。
export const listMyAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [accounts, rawList] = await Promise.all([
      listAccountsByUser(env, context.userId),
      listRawCredsByUser(env, context.userId),
    ]);
    const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
    return accounts.map((a) => {
      const inputs = getProvider(appRegistry, a.type).inputs ?? [];
      const raw = rawById.get(a.id);
      const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
      return {
        ...a,
        needsCredentials: !isComplete(inputs, stored),
        credsSafe: safeView(inputs, stored), // Record<string,string>(public 原样 / semi 打码)→ JSON 可序列化
      };
    });
  });

// 凭据字段的【值校验】统一走 provider.inputs 的 validator(EVM 正则 / 非空 / passphrase 必填等
// 全由声明派生,见 @folio/core validateCredentials)。外层 zod 只管 wire 形状(type 白名单 + label
// + 字段存在),不再手写 per-type 的地址正则 / passphrase refine。

// 一个 manual 账户 = 一个手记资产:symbol/amount/usdValue 三个 public 输入,走 creds(明文,见 P6.6.2)。
// wire 全字符串(amount/usdValue 的数值性由 provider.inputs 的 z.coerce.number 经 validateCredentials 校验)。
const ManualInput = z.object({
  label: z.string().trim().min(1, "label is required"),
  symbol: z.string().trim().min(1, "symbol is required"),
  amount: z.string().trim().min(1, "amount is required"),
  usdValue: z.string().trim().min(1, "usdValue is required"),
});
export const createManualAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ManualInput)
  .handler(async ({ data, context }) => {
    const inputs = getProvider(appRegistry, "manual").inputs ?? [];
    const raw = { symbol: data.symbol, amount: data.amount, usdValue: data.usdValue };
    await validateCredentials(inputs, raw); // 校验闸(amount/usdValue 可 coerce 成数值,否则抛)
    return createAccount(env, context.userId, {
      type: "manual",
      label: data.label,
      creds: await sealJson(inputs, raw),
    });
  });

// 全局 provider key 表(按 provider 的 usesGlobalKeys 最小权限下发)。
const ALL_GLOBAL_KEYS = {
  ZERION_API_KEY: env.ZERION_API_KEY,
  COINSTATS_API_KEY: env.COINSTATS_API_KEY,
};

// 地址类账户(链上 + perp):地址→identifier(public),值由 provider.inputs 的 validator 校验。
// 创建即 live validate(scoped 全局 key);存 sealCreds(identifier 明文,无 secret),无 dataJson。
async function createAddressAccount(
  userId: string,
  type: Parameters<typeof getProvider>[1],
  label: string,
  address: string,
): Promise<Awaited<ReturnType<typeof createAccount>>> {
  const provider = getProvider(appRegistry, type);
  const inputs = provider.inputs ?? [];
  const raw = { identifier: address };
  const creds = await validateCredentials(inputs, raw); // 校验 + 给 ctx 做 liveness
  const ctx: FetchContext = {
    account: { id: "new", userId, type, label },
    creds,
    globalKeys: scopeGlobalKeys(ALL_GLOBAL_KEYS, provider.usesGlobalKeys),
  };
  // validate=false:地址无效/不可达,或服务端缺对应 key(运维问题)。只提用户能改的(地址)。
  if (!(await provider.validate(ctx))) {
    throw new Error("could not verify the address — please check it and try again");
  }
  return createAccount(env, userId, { type, label, creds: await sealJson(inputs, raw) });
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

// CEX 账户录入:apiKey(semi,明文)+ secret/passphrase(secret,加密)由 sealCreds 按 type 落库。
// 字段值校验(非空、okx passphrase 必填)由 provider.inputs 的 validator 派生。
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
    const provider = getProvider(appRegistry, data.type);
    const inputs = provider.inputs ?? [];
    // passphrase 可选(仅 okx):缺省则不放进 values,由 provider.inputs 的 validator 判定是否必填。
    const values: Record<string, string> = { apiKey: data.apiKey, secret: data.secret };
    if (data.passphrase !== undefined) values.passphrase = data.passphrase;
    const creds = await validateCredentials(inputs, values);
    const ctx: FetchContext = {
      account: { id: "new", userId: context.userId, type: data.type, label: data.label },
      creds, // CEX 走 ctx.creds、无 usesGlobalKeys → scopeGlobalKeys 给 {}
      globalKeys: scopeGlobalKeys(ALL_GLOBAL_KEYS, provider.usesGlobalKeys),
    };
    if (!(await provider.validate(ctx))) {
      throw new Error("could not verify these API credentials — please check them and try again");
    }
    return createAccount(env, context.userId, {
      type: data.type,
      label: data.label,
      creds: await sealJson(inputs, values), // seal 原始字符串(非 coerce 输出)
    });
  });

// 凭据再水合(P6.6.1):为导入的"缺凭据"账户补录真值。按该账户 type 的 inputs 校验 + live validate +
// sealCreds 整张 map 覆盖(占位被真值替换)。creds 字段值的真校验由 validateCredentials(inputs) 负责。
const ProvideCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string().trim()), // seal 原始输入 → 值先 trim
});
export const provideCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ProvideCredentialsInput)
  .handler(async ({ data, context }) => {
    const account = await getAccountById(env, context.userId, data.accountId);
    if (!account) throw new Error("account not found");
    const provider = getProvider(appRegistry, account.type);
    const inputs = provider.inputs ?? [];
    const creds = await validateCredentials(inputs, data.creds);
    const ctx: FetchContext = {
      account: { id: account.id, userId: context.userId, type: account.type, label: account.label },
      creds,
      globalKeys: scopeGlobalKeys(ALL_GLOBAL_KEYS, provider.usesGlobalKeys),
    };
    if (!(await provider.validate(ctx))) {
      throw new Error("could not verify these credentials — please check them and try again");
    }
    await setAccountCredentials(
      env,
      context.userId,
      account.id,
      await sealJson(inputs, data.creds),
    );
    return { ok: true as const };
  });
