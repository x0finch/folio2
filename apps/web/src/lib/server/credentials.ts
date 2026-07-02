import type { InputSpec } from "@folio/balances";
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "../require-auth";
import { balances } from "./balances";

// InputSpec 由 balances 门面定义(provider.inputs 的可序列化投影);此处转发给前端类型引用。
export type { InputSpec };

// 各 account type 的账户输入规格(录入/补录表单动态生成字段用:secret→password、OKX 才有 passphrase)。
// 规格来自 balances.credentialSpecs()(门面内部由 provider.inputs 派生、剥掉不可序列化的 validator);
// 走 server fn 是为了不把 provider 实现打进客户端包(只回这张静态规格表)。
export const getCredentialSpecs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => balances.credentialSpecs());
