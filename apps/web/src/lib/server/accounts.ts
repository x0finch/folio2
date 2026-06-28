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

// 真值 creds → 存库 map 的 JSON(secret 字段加密、public/semi 明文,见 @folio/core sealCreds)。
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
        credsSafe: safeView(inputs, stored),
      };
    });
  });

// 凭据字段的【值校验】统一走 provider.inputs 的 validator(EVM 正则 / 非空 / passphrase 必填等
// 全由声明派生,见 @folio/core validateCredentials)。外层 zod 只管 wire 形状(type 白名单 + label
// + 字段存在),不再手写 per-type 的地址正则 / passphrase refine。

const ManualInput = z.object({
  label: z.string().trim().min(1, "label is required"),
  holdings: z
    .array(
      z.object({
        symbol: z.string().trim().min(1),
        amount: z.number(),
        usdValue: z.number(),
      }),
    )
    .min(1, "add at least one holding"),
});

// 新建 manual 账户:持仓为非凭据域数据 → 明文 dataJson;manual 无输入 → creds 为空 map "{}"。
export const createManualAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ManualInput)
  .handler(async ({ data, context }) => {
    const creds = await sealJson(getProvider(appRegistry, "manual").inputs ?? [], {});
    const dataJson = JSON.stringify({ holdings: data.holdings });
    return createAccount(env, context.userId, {
      type: "manual",
      label: data.label,
      creds,
      dataJson,
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
  const creds = await validateCredentials(inputs, { identifier: address });
  const ctx: FetchContext = {
    account: { id: "new", userId, type, label },
    creds,
    globalKeys: scopeGlobalKeys(ALL_GLOBAL_KEYS, provider.usesGlobalKeys),
  };
  // validate=false:地址无效/不可达,或服务端缺对应 key(运维问题)。只提用户能改的(地址)。
  if (!(await provider.validate(ctx))) {
    throw new Error("could not verify the address — please check it and try again");
  }
  return createAccount(env, userId, { type, label, creds: await sealJson(inputs, creds) });
}

const OnchainInput = z.object({
  type: z.enum(["onchain_evm", "onchain_solana", "onchain_sui", "onchain_cosmos"]),
  label: z.string().trim().min(1, "label is required"),
  address: z.string(),
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
  address: z.string(),
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
  apiKey: z.string(),
  secret: z.string(),
  passphrase: z.string().optional(),
});
export const createExchangeAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ExchangeInput)
  .handler(async ({ data, context }) => {
    const provider = getProvider(appRegistry, data.type);
    const inputs = provider.inputs ?? [];
    const creds = await validateCredentials(inputs, {
      apiKey: data.apiKey,
      secret: data.secret,
      passphrase: data.passphrase,
    });
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
      creds: await sealJson(inputs, creds),
    });
  });

// 凭据再水合(P6.6.1):为导入的"缺凭据"账户补录真值。按该账户 type 的 inputs 校验 + live validate +
// sealCreds 整张 map 覆盖(占位被真值替换)。creds 字段值的真校验由 validateCredentials(inputs) 负责。
const ProvideCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string()),
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
    await setAccountCredentials(env, context.userId, account.id, await sealJson(inputs, creds));
    return { ok: true as const };
  });
