import { env } from "cloudflare:workers";
import { encrypt, type FetchContext, type ManualHolding } from "@folio/core";
import { createAccount, listAccountsByUser } from "@folio/db";
import { customProvider } from "@folio/provider-custom";
import { zerionProvider } from "@folio/provider-zerion";
import { createServerFn } from "@tanstack/react-start";
import { buildEvmCredentials, normalizeEvmAddress } from "../onchain";
import { requireAuth } from "../require-auth";

// 直接用 createServerFn(...).middleware([requireAuth]):Start 编译器按调用点静态识别
// createServerFn 才会在客户端构建剥离 handler 及其 server-only import(cloudflare:workers
// 等);包一层 helper 会让识别失效,故不再用 authedServerFn 包装。userId 取自守卫注入的
// context,绝不接客户端入参。
export const listMyAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => listAccountsByUser(env, context.userId));

interface CreateManualInput {
  label: string;
  holdings: ManualHolding[];
}

// 新建 manual 账户:持仓为非密钥数据 → 明文 dataJson;manual 无密钥 → encCredentials 存加密的 {}。
// 存前用 provider 契约校验持仓形状(复用 customProvider.validate),不合法则拒。
export const createManualAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: CreateManualInput) => input)
  .handler(async ({ data, context }) => {
    const label = data.label?.trim();
    if (!label) throw new Error("label is required");

    const ctx: FetchContext = {
      account: {
        id: "new",
        userId: context.userId,
        type: "manual",
        label,
        data: { holdings: data.holdings },
      },
      creds: {},
      globalKeys: {},
    };
    if (!(await customProvider.validate(ctx))) {
      throw new Error("invalid holdings: each needs a symbol and finite amount/usdValue");
    }

    const encCredentials = await encrypt(JSON.stringify({}), env.SECRETS_KEY);
    const dataJson = JSON.stringify({ holdings: data.holdings });
    return createAccount(env, context.userId, {
      type: "manual",
      label,
      encCredentials,
      dataJson,
    });
  });

interface CreateOnchainEvmInput {
  label: string;
  address: string;
}

// 新建 onchain_evm 账户:只读地址 → creds.identifier(加密入库);无 dataJson。
// 创建即 live validate(决策 2):先正则给"地址非法"清晰报错,再 zerionProvider.validate
// 打一次轻量 portfolio 确认地址 + key 可用,通过才入库(fail-fast)。
export const createOnchainEvmAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: CreateOnchainEvmInput) => input)
  .handler(async ({ data, context }) => {
    const label = data.label?.trim();
    if (!label) throw new Error("label is required");
    const address = normalizeEvmAddress(data.address); // 抛"invalid EVM address"(不发请求)

    const ctx: FetchContext = {
      account: { id: "new", userId: context.userId, type: "onchain_evm", label },
      creds: { identifier: address },
      globalKeys: { ZERION_API_KEY: env.ZERION_API_KEY },
    };
    if (!(await zerionProvider.validate(ctx))) {
      throw new Error(
        "could not verify address (check the address, and that ZERION_API_KEY is set)",
      );
    }

    const encCredentials = await buildEvmCredentials(address, env.SECRETS_KEY);
    return createAccount(env, context.userId, { type: "onchain_evm", label, encCredentials });
  });
