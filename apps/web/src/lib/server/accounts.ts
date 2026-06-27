import { env } from "cloudflare:workers";
import { encrypt, type FetchContext, getProvider } from "@folio/core";
import { createAccount, listAccountsByUser } from "@folio/db";
import { appRegistry, scopeGlobalKeys } from "@folio/sync";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildAddressCredentials, EVM_ADDRESS_RE } from "../onchain";
import { requireAuth } from "../require-auth";

// 直接用 createServerFn(...).middleware([requireAuth]):Start 编译器按调用点静态识别
// createServerFn 才会在客户端构建剥离 handler 及其 server-only import(cloudflare:workers
// 等);包一层 helper 会让识别失效,故不再用 authedServerFn 包装。userId 取自守卫注入的
// context,绝不接客户端入参。
export const listMyAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => listAccountsByUser(env, context.userId));

// 输入校验用 zod schema(真·运行时边界校验 + 类型推断)。zod v4 实现 Standard Schema,
// 直接传给 .validator() 即可(无需 .parse 包装)。zod = 形状校验;provider.validate = 活性校验。
const ManualInput = z.object({
  label: z.string().trim().min(1, "label is required"),
  holdings: z
    .array(
      z.object({
        symbol: z.string().trim().min(1),
        // zod v4 的 z.number() 默认已拒绝 NaN/Infinity(.finite() 已废弃为 no-op)。
        amount: z.number(),
        usdValue: z.number(),
      }),
    )
    .min(1, "add at least one holding"),
});

// 新建 manual 账户:持仓为非密钥数据 → 明文 dataJson;manual 无密钥 → encCredentials 存加密的 {}。
// 持仓形状由 zod 全覆盖(取代原 customProvider.validate 调用)。
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

// 链上账户录入(统一 EVM + coinstats 三链)。type 走白名单(不接受 manual/任意值);
// 地址非空,EVM 额外正则预检,其余链格式交各 provider/API 判定。
const OnchainInput = z
  .object({
    type: z.enum(["onchain_evm", "onchain_solana", "onchain_sui", "onchain_cosmos"]),
    label: z.string().trim().min(1, "label is required"),
    address: z.string().trim().min(1, "address is required"),
  })
  .refine((d) => d.type !== "onchain_evm" || EVM_ADDRESS_RE.test(d.address), {
    error: "invalid EVM address (expected 0x + 40 hex)",
    path: ["address"],
  });

// 创建即 live validate(经注册表派发到对应 provider);key 按 provider 的 usesGlobalKeys 最小
// 权限下发(provider 拿不到别家的)。地址=只读凭据 → creds.identifier 加密入库,无 dataJson。
const ALL_GLOBAL_KEYS = {
  ZERION_API_KEY: env.ZERION_API_KEY,
  COINSTATS_API_KEY: env.COINSTATS_API_KEY,
};

export const createOnchainAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(OnchainInput)
  .handler(async ({ data, context }) => {
    const provider = getProvider(appRegistry, data.type);
    const ctx: FetchContext = {
      account: { id: "new", userId: context.userId, type: data.type, label: data.label },
      creds: { identifier: data.address },
      globalKeys: scopeGlobalKeys(ALL_GLOBAL_KEYS, provider.usesGlobalKeys),
    };
    // validate=false 可能是地址无效/不可达,或服务端缺对应 key(运维配置问题)。
    // 面向用户只提他能改的(地址);key 未配是部署侧的事,不暴露内部 env 名。
    if (!(await provider.validate(ctx))) {
      throw new Error("could not verify the address — please check it and try again");
    }

    const encCredentials = await buildAddressCredentials(data.address, env.SECRETS_KEY);
    return createAccount(env, context.userId, {
      type: data.type,
      label: data.label,
      encCredentials,
    });
  });
