import { createServerFn } from "@tanstack/react-start";
import type { InputSpec } from "../creds";
import { requireAuth } from "../require-auth";
import { credentialSpecs } from "./connectors";

// InputSpec 定义在 lib/creds.ts(CredField 的可序列化投影);此处转发给前端类型引用。
export type { InputSpec };

// 各 connector 的账户输入规格(录入/补录表单动态生成字段用:secret→password、OKX 才有 passphrase)。
// 规格来自 credentialSpecs()(从 connector manifest 的 account.creds 派生、剥掉不可序列化的 validator);
// 走 server fn 是为了不把 provider 实现打进客户端包(只回这张静态规格表)。
export const getCredentialSpecs = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => credentialSpecs());
