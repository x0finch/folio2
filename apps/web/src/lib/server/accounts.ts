import { env } from "cloudflare:workers";
import { encrypt, type FetchContext } from "@folio/core";
import { createAccount, listAccountsByUser } from "@folio/db";
import { zerionProvider } from "@folio/provider-zerion";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildEvmCredentials, EVM_ADDRESS_RE } from "../onchain";
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

const OnchainEvmInput = z.object({
  label: z.string().trim().min(1, "label is required"),
  address: z.string().trim().regex(EVM_ADDRESS_RE, "invalid EVM address (expected 0x + 40 hex)"),
});

// 新建 onchain_evm 账户:只读地址 → creds.identifier(加密入库);无 dataJson。
// zod 校验地址格式;再 live validate(zerionProvider.validate 打一次轻量 portfolio 确认
// 地址 + key 可用),通过才入库(fail-fast)。
export const createOnchainEvmAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(OnchainEvmInput)
  .handler(async ({ data, context }) => {
    const ctx: FetchContext = {
      account: { id: "new", userId: context.userId, type: "onchain_evm", label: data.label },
      creds: { identifier: data.address },
      globalKeys: { ZERION_API_KEY: env.ZERION_API_KEY },
    };
    // validate=false 可能是地址无效/不可达,或服务端缺 ZERION_API_KEY(运维配置问题)。
    // 面向用户只提他能改的(地址);key 未配是部署侧的事,不暴露内部 env 名。
    if (!(await zerionProvider.validate(ctx))) {
      throw new Error("could not verify the address — please check it and try again");
    }

    const encCredentials = await buildEvmCredentials(data.address, env.SECRETS_KEY);
    return createAccount(env, context.userId, {
      type: "onchain_evm",
      label: data.label,
      encCredentials,
    });
  });
