import { env } from "cloudflare:workers";
import { encrypt, type FetchContext, getProvider, validateCredentials } from "@folio/core";
import { createAccount, listAccountsByUser } from "@folio/db";
import { appRegistry, scopeGlobalKeys } from "@folio/sync";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";

// 直接用 createServerFn(...).middleware([requireAuth]):Start 编译器按调用点静态识别
// createServerFn 才会在客户端构建剥离 handler 及其 server-only import(cloudflare:workers
// 等);包一层 helper 会让识别失效。userId 取自守卫注入的 context,绝不接客户端入参。
export const listMyAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => listAccountsByUser(env, context.userId));

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

// 新建 manual 账户:持仓为非密钥数据 → 明文 dataJson;manual 无输入 → encCredentials 存加密的 {}。
export const createManualAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ManualInput)
  .handler(async ({ data, context }) => {
    const encCredentials = await encrypt(JSON.stringify({}), env.SECRETS_KEY);
    const dataJson = JSON.stringify({ holdings: data.holdings });
    return createAccount(env, context.userId, {
      type: "manual",
      label: data.label,
      encCredentials,
      dataJson,
    });
  });

// 全局 provider key 表(按 provider 的 usesGlobalKeys 最小权限下发)。
const ALL_GLOBAL_KEYS = {
  ZERION_API_KEY: env.ZERION_API_KEY,
  COINSTATS_API_KEY: env.COINSTATS_API_KEY,
};

// 地址类账户(链上 + perp):地址→identifier,值由 provider.inputs 的 identifier validator 校验。
// 创建即 live validate(scoped 全局 key);存 encrypt(validated creds),无 dataJson。
async function createAddressAccount(
  userId: string,
  type: Parameters<typeof getProvider>[1],
  label: string,
  address: string,
): Promise<Awaited<ReturnType<typeof createAccount>>> {
  const provider = getProvider(appRegistry, type);
  const creds = await validateCredentials(provider.inputs ?? [], { identifier: address });
  const ctx: FetchContext = {
    account: { id: "new", userId, type, label },
    creds,
    globalKeys: scopeGlobalKeys(ALL_GLOBAL_KEYS, provider.usesGlobalKeys),
  };
  // validate=false:地址无效/不可达,或服务端缺对应 key(运维问题)。只提用户能改的(地址)。
  if (!(await provider.validate(ctx))) {
    throw new Error("could not verify the address — please check it and try again");
  }
  const encCredentials = await encrypt(JSON.stringify(creds), env.SECRETS_KEY);
  return createAccount(env, userId, { type, label, encCredentials });
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

// CEX 账户录入:凭据是真密钥 → 加密入库。字段值(apiKey/secret 非空、okx passphrase 必填)由
// provider.inputs 的 validator 派生(不再硬编码 okx passphrase refine)。
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
    const creds = await validateCredentials(provider.inputs ?? [], {
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
    const encCredentials = await encrypt(JSON.stringify(creds), env.SECRETS_KEY);
    return createAccount(env, context.userId, {
      type: data.type,
      label: data.label,
      encCredentials,
    });
  });
