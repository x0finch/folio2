import { env } from "cloudflare:workers";
import { passkey } from "@better-auth/passkey";
import { createAuthAdapter } from "@folio/db";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { derivePasskeyRp } from "../../passkey-rp";

// 密码哈希:better-auth 1.6 + nodejs_compat 默认走原生 node:crypto scrypt(坑 ① 已默认修复)。
function createAuth() {
  // WebAuthn RP 从 BETTER_AUTH_URL 派生(rpID=host、origin=完整 origin);challenge 走插件默认 cookie,
  // 不加 KV。residentKey/userVerification 用 "preferred":尽量 discoverable(conditional-UI autofill 需要)
  // + 尽量生物识别,但都不强制以最大化浏览器/认证器兼容。见 ADR 0028。
  const rp = derivePasskeyRp(env.BETTER_AUTH_URL);
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: createAuthAdapter(env),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // 自托管无邮件验证,注册即用
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7d
      updateAge: 60 * 60 * 24, // 1d
      // cookieCache 保持关闭(坑 ⑤:与 secondaryStorage 组合有 bug,且单实例下收益小)
    },
    plugins: [
      passkey({
        rpID: rp.rpID,
        rpName: rp.rpName,
        origin: rp.origin,
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      }),
      tanstackStartCookies(), // 必须放插件数组最后
    ],
  });
}

let authInstance: ReturnType<typeof createAuth> | null = null;

// 惰性单例(坑 ②⑥):首次请求时构建、之后复用;不在模块加载期做任何 auth 工作。
// env 取自 cloudflare:workers(按请求解析的静态绑定),避免每请求新建多个 drizzle 实例。
export function getAuth() {
  authInstance ??= createAuth();
  return authInstance;
}
