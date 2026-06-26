import { env } from "cloudflare:workers";
import { encrypt, type FetchContext, type ManualHolding } from "@folio/core";
import { createAccount, listAccountsByUser } from "@folio/db";
import { customProvider } from "@folio/provider-custom";
import { createServerFn } from "@tanstack/react-start";
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
