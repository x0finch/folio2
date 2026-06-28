import { appRegistry } from "@folio/sync";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";

// 各 account type 的账户输入规格(由 provider 的 inputs 派生,单一来源):每项 {key, type}。
// 供录入/补录表单动态生成字段(secret→password、OKX 才有 passphrase),杜绝按 type 硬编码。
// 剥掉 validator(zod/Standard Schema 不可序列化,客户端只需 key+type 渲染;真校验在服务端)。
// 走 server fn 是为了不把 provider 实现打进客户端包(只回这张静态规格表)。
export interface InputSpec {
  key: string;
  type: "text" | "secret";
  label: string; // 兼作 i18n key(见 ProviderInput.label);desc 同理
  desc?: string;
}
export const getCredentialSpecs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => {
    const specs: Record<string, InputSpec[]> = {};
    for (const [type, provider] of Object.entries(appRegistry)) {
      if (provider)
        specs[type] = (provider.inputs ?? []).map((i) => ({
          key: i.key,
          type: i.type,
          label: i.label,
          desc: i.desc,
        }));
    }
    return specs;
  });
